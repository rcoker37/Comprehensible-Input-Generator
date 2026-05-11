// Background backfill for the word-occurrence index.
//
// On mount (once both the dictionary is "ready" and the user is signed in),
// fetches every read-but-unindexed story and processes them serially in the
// background: extractWordOccurrences → indexStoryWords → throttle. Failures
// are logged and skipped — the row stays unstamped so the next session
// retries.
//
// Settings exposes the queue length, the currently-processing story id, and
// pause/resume + run-now controls. Pause state persists across sessions in
// localStorage so a user who turned it off doesn't get re-opted-in on
// reload.
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
import {
  getStoriesNeedingIndex,
  indexStoryWords,
} from "../api/client";
import { extractWordOccurrences } from "../lib/storyWordIndex";

const PAUSED_KEY = "wordIndexBackfill.paused";
const STORY_GAP_MS = 200;

interface QueuedStory {
  id: number;
  content: string;
}

interface WordIndexBackfillContextType {
  remaining: number;
  processing: boolean;
  paused: boolean;
  currentStoryId: number | null;
  error: string | null;
  setPaused: (paused: boolean) => void;
  runNow: () => void;
  refresh: () => void;
}

const WordIndexBackfillContext =
  createContext<WordIndexBackfillContextType | null>(null);

export function useWordIndexBackfill() {
  const ctx = useContext(WordIndexBackfillContext);
  if (!ctx) {
    throw new Error(
      "useWordIndexBackfill must be used within WordIndexBackfillProvider"
    );
  }
  return ctx;
}

function readPaused(): boolean {
  try {
    return localStorage.getItem(PAUSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writePaused(paused: boolean): void {
  try {
    if (paused) localStorage.setItem(PAUSED_KEY, "1");
    else localStorage.removeItem(PAUSED_KEY);
  } catch {
    // private mode etc.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function WordIndexBackfillProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { state: dictState } = useDictionary();

  const [remaining, setRemaining] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [paused, setPausedState] = useState<boolean>(() => readPaused());
  const [currentStoryId, setCurrentStoryId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The queue lives in a ref because the processing loop reads/writes it in
  // a tight loop and we don't need React to re-render between stories.
  const queueRef = useRef<QueuedStory[]>([]);
  // Mirror of `paused` for the loop to consult without restarting on each
  // toggle. Same pattern as pollTokenRef in GenerationContext.
  const pausedRef = useRef(paused);
  // Identity check so we can cancel a stale loop after sign-out or refresh.
  const runIdRef = useRef(0);
  const loopRunningRef = useRef(false);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Queue hydrate — runs whenever the user changes (sign-in / sign-out) or
  // when the dictionary becomes ready. Both gates have to be satisfied
  // before we can do useful work, so we wait for both before fetching.
  useEffect(() => {
    if (!user || dictState !== "ready") {
      queueRef.current = [];
      runIdRef.current += 1;
      setRemaining(0);
      setProcessing(false);
      setCurrentStoryId(null);
      return;
    }
    let cancelled = false;
    setError(null);
    getStoriesNeedingIndex()
      .then((rows) => {
        if (cancelled) return;
        queueRef.current = rows;
        setRemaining(rows.length);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Backfill hydrate failed:", err);
        setError(err instanceof Error ? err.message : "Failed to load queue");
      });
    return () => {
      cancelled = true;
    };
  }, [user, dictState]);

  const runLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    const myRunId = ++runIdRef.current;
    setProcessing(true);
    setError(null);

    try {
      while (
        !pausedRef.current &&
        queueRef.current.length > 0 &&
        runIdRef.current === myRunId
      ) {
        const story = queueRef.current[0]!;
        setCurrentStoryId(story.id);
        try {
          const occurrences = await extractWordOccurrences(story);
          if (runIdRef.current !== myRunId) return;
          await indexStoryWords(story.id, occurrences);
        } catch (err) {
          // Per-story failures get logged and the story stays at the head
          // of the queue. We pop it anyway so we don't infinite-loop on a
          // broken row; the next session will re-pick it up.
          console.warn("Backfill failed for story", story.id, err);
        }
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
  }, []);

  // Auto-start the loop whenever the gates pass and there's work to do.
  // Re-fires after pause→resume (state flips trigger this effect).
  useEffect(() => {
    if (!user || dictState !== "ready" || paused) return;
    if (queueRef.current.length === 0) return;
    void runLoop();
  }, [user, dictState, paused, remaining, runLoop]);

  const setPaused = useCallback((next: boolean) => {
    setPausedState(next);
    writePaused(next);
  }, []);

  const runNow = useCallback(() => {
    // "Index now" — pretend the user un-paused for one drain. We don't flip
    // the persisted preference; if they paused, they probably want it to
    // stay paused after this drain completes. The loop reads pausedRef on
    // every iteration, so setting it false here un-gates without a state
    // round-trip.
    pausedRef.current = false;
    void runLoop().then(() => {
      pausedRef.current = paused;
    });
  }, [paused, runLoop]);

  const refresh = useCallback(() => {
    if (!user || dictState !== "ready") return;
    getStoriesNeedingIndex()
      .then((rows) => {
        queueRef.current = rows;
        setRemaining(rows.length);
      })
      .catch((err) => {
        console.warn("Backfill refresh failed:", err);
      });
  }, [user, dictState]);

  const value = useMemo(
    () => ({
      remaining,
      processing,
      paused,
      currentStoryId,
      error,
      setPaused,
      runNow,
      refresh,
    }),
    [remaining, processing, paused, currentStoryId, error, setPaused, runNow, refresh]
  );

  return (
    <WordIndexBackfillContext.Provider value={value}>
      {children}
    </WordIndexBackfillContext.Provider>
  );
}
