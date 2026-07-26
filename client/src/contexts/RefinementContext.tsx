// Client-orchestrated comprehensibility refinement loop.
//
// After a story is generated, it needs a comprehensibility pass. This context
// drains a queue of such stories (get_stories_needing_refinement): for each it
// tokenizes the body with the real indexer (extractWordOccurrences), scores it
// against the reader's vocabulary (lib/comprehensibility), and — if too many
// words are unseen-and-rare — calls the `revise-story` Edge Function with the
// specific offenders, polls until the rewrite lands, then re-scores. Up to
// MAX_REFINE_PASSES passes run, stopping early on a comprehensibility
// threshold (or when a pass stops making progress). When it stops it stamps
// the final metrics via settle_story_refinement.
//
// Measurement is 100% client-side — it reuses the exact kuromoji + JMdict +
// JPDB stack that already powers the zero-encounter underline, so the loop's
// notion of "seen / rare" is identical to the rest of the app. Like the
// word-index backfill, it only runs while a tab is open; gated on the same
// dictionary-ready + user signals, plus vocabEncounters being loaded.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { useDictionary } from "./DictionaryContext";
import { useVocab } from "./VocabContext";
import { useStories } from "./StoriesContext";
import { useWordIndexBackfill } from "./WordIndexBackfillContext";
import {
  getStoriesNeedingRefinement,
  settleRefinement,
  reviseStory,
  getStory,
} from "../api/client";
import { extractWordOccurrences } from "../lib/storyWordIndex";
import {
  vocabFrontier,
  vocabLevel,
  scoreComprehensibility,
  shouldSettle,
  FLAG_CAP,
} from "../lib/comprehensibility";
import type { Comprehensibility } from "../types";

const POLL_INTERVAL_MS = 3000;
// A single repair rewrite (one non-streaming OpenRouter call) shouldn't take
// longer than this; past it we abandon the pass and move on.
const REVISE_STALE_MS = 5 * 60 * 1000;
const STORY_GAP_MS = 200;

interface QueuedStory {
  id: number;
  content: string;
  refinePass: number;
}

interface RefinementContextType {
  remaining: number;
  processing: boolean;
  /** Story currently being scored or revised, for the "settling" overlay. */
  currentStoryId: number | null;
  refresh: () => void;
}

const RefinementContext = createContext<RefinementContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useRefinement() {
  const ctx = useContext(RefinementContext);
  if (!ctx) {
    throw new Error("useRefinement must be used within RefinementProvider");
  }
  return ctx;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function RefinementProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { state: dictState } = useDictionary();
  const { vocabEncounters, vocabEncountersLoaded, getWordRank } = useVocab();
  const { applyStoryUpdate } = useStories();
  const { refresh: refreshBackfill } = useWordIndexBackfill();

  const [remaining, setRemaining] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [currentStoryId, setCurrentStoryId] = useState<number | null>(null);

  // The loop reads the latest vocab + cache-updater without rebuilding, so a
  // long drain doesn't capture a stale snapshot (mirrors how the word-index
  // backfill mirrors its callbacks in refs).
  const vocabRef = useRef(vocabEncounters);
  const getWordRankRef = useRef(getWordRank);
  const applyStoryUpdateRef = useRef(applyStoryUpdate);
  const refreshBackfillRef = useRef(refreshBackfill);
  useEffect(() => {
    vocabRef.current = vocabEncounters;
    getWordRankRef.current = getWordRank;
    applyStoryUpdateRef.current = applyStoryUpdate;
    refreshBackfillRef.current = refreshBackfill;
  }, [vocabEncounters, getWordRank, applyStoryUpdate, refreshBackfill]);

  const queueRef = useRef<QueuedStory[]>([]);
  const runIdRef = useRef(0);
  const loopRunningRef = useRef(false);

  const gatesOpen = Boolean(user) && dictState === "ready" && vocabEncountersLoaded;

  const loadQueue = useCallback(async (): Promise<QueuedStory[]> => {
    return await getStoriesNeedingRefinement();
  }, []);

  // Wait for an in-flight revision to land, polling the row until refine_state
  // leaves 'refining'. Returns the fresh story on success, or null on failure
  // / timeout / a stale run.
  const waitForRevision = useCallback(
    async (storyId: number, myRunId: number) => {
      const started = Date.now();
      while (runIdRef.current === myRunId) {
        await sleep(POLL_INTERVAL_MS);
        if (runIdRef.current !== myRunId) return null;
        let fresh;
        try {
          fresh = await getStory(storyId);
        } catch {
          if (Date.now() - started > REVISE_STALE_MS) return null;
          continue;
        }
        if (fresh.refine_state === "refining") {
          if (Date.now() - started > REVISE_STALE_MS) return null;
          continue;
        }
        // null (success — re-eval) or 'failed'.
        return fresh.refine_state === "failed" ? null : fresh;
      }
      return null;
    },
    []
  );

  // Run the measure → revise → re-measure loop for one story to convergence.
  const refineOne = useCallback(
    async (item: QueuedStory, frontier: number, levelBlurb: string, myRunId: number) => {
      let content = item.content;
      let pass = item.refinePass;
      let prevProblemCount = Number.POSITIVE_INFINITY;

      for (;;) {
        if (runIdRef.current !== myRunId) return;
        const occurrences = await extractWordOccurrences({ content });
        if (runIdRef.current !== myRunId) return;
        const score = scoreComprehensibility(
          occurrences,
          vocabRef.current,
          getWordRankRef.current,
          frontier
        );

        if (shouldSettle(score, pass, prevProblemCount)) {
          const metrics: Comprehensibility = {
            fraction: score.fraction,
            problemCount: score.problemWords.length,
            newWords: score.newWords,
            pass,
          };
          await settleRefinement(item.id, metrics);
          applyStoryUpdateRef.current(item.id, {
            content,
            refine_pass: pass,
            refine_state: "settled",
            comprehensibility: metrics,
          });
          return;
        }

        prevProblemCount = score.problemWords.length;
        const flagged = score.problemWords
          .slice(0, FLAG_CAP)
          .map((w) => ({ surface: w.surface, reading: w.reading }));
        await reviseStory(item.id, flagged, levelBlurb);
        const revised = await waitForRevision(item.id, myRunId);
        if (!revised) return; // failed / stale — leave it (still readable)
        content = revised.content;
        pass = revised.refine_pass;
        applyStoryUpdateRef.current(item.id, {
          content,
          refine_pass: pass,
          refine_state: revised.refine_state,
        });
      }
    },
    [waitForRevision]
  );

  const runLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    const myRunId = ++runIdRef.current;
    setProcessing(true);

    // Frontier + level are properties of the reader, computed once per drain.
    const frontier = vocabFrontier(vocabRef.current, getWordRankRef.current);
    const levelBlurb = vocabLevel(vocabRef.current, getWordRankRef.current).blurb;

    try {
      while (queueRef.current.length > 0 && runIdRef.current === myRunId) {
        const item = queueRef.current[0]!;
        setCurrentStoryId(item.id);
        try {
          await refineOne(item, frontier, levelBlurb, myRunId);
        } catch (err) {
          console.warn("Refinement failed for story", item.id, err);
        }
        // A repair pass rewrites the story and nulls word_index_at server-side.
        // Nothing else re-queues the backfill for it, so without this kick the
        // story stays un-indexed — StoryDisplay shows its reflow overlay stuck
        // until the next app load. Re-query so the (possibly-rewritten) story is
        // re-indexed promptly; a no-op when the pass made no changes.
        refreshBackfillRef.current();
        if (runIdRef.current !== myRunId) return;
        queueRef.current.shift();
        setRemaining(queueRef.current.length);
        if (queueRef.current.length > 0) await sleep(STORY_GAP_MS);
      }
    } finally {
      if (runIdRef.current === myRunId) {
        setProcessing(false);
        setCurrentStoryId(null);
      }
      loopRunningRef.current = false;
    }
  }, [refineOne]);

  // Hydrate the queue whenever the gates open / close.
  useEffect(() => {
    if (!gatesOpen) {
      queueRef.current = [];
      runIdRef.current += 1;
      setRemaining(0);
      setProcessing(false);
      setCurrentStoryId(null);
      return;
    }
    let cancelled = false;
    loadQueue()
      .then((items) => {
        if (cancelled) return;
        queueRef.current = items;
        setRemaining(items.length);
      })
      .catch((err) => console.warn("Refinement hydrate failed:", err));
    return () => {
      cancelled = true;
    };
  }, [gatesOpen, loadQueue]);

  // Auto-start the drain whenever the gates pass and there's work to do.
  useEffect(() => {
    if (!gatesOpen) return;
    if (queueRef.current.length === 0) return;
    void runLoop();
  }, [gatesOpen, remaining, runLoop]);

  const refresh = useCallback(() => {
    if (!gatesOpen) return;
    loadQueue()
      .then((items) => {
        queueRef.current = items;
        setRemaining(items.length);
      })
      .catch((err) => console.warn("Refinement refresh failed:", err));
  }, [gatesOpen, loadQueue]);

  const value = useMemo(
    () => ({ remaining, processing, currentStoryId, refresh }),
    [remaining, processing, currentStoryId, refresh]
  );

  return (
    <RefinementContext.Provider value={value}>
      {children}
    </RefinementContext.Provider>
  );
}
