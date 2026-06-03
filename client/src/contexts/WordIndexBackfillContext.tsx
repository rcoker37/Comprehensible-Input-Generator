// Background backfill for the word-occurrence index.
//
// On mount (once both the dictionary is "ready" and the user is signed in),
// fetches every unindexed source — stories AND assistant chat messages —
// and processes them serially in the background: extractWordOccurrences →
// indexStoryWords / indexChatMessageWords → throttle. Failures are logged
// and skipped; the row stays unstamped so the next session retries.
//
// Settings exposes the queue length and the currently-processing item for
// visibility. There's no pause control: if the dictionary is loaded and
// there's work to do, we drain.
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
  getChatMessagesNeedingIndex,
  getMediaEpisodesNeedingIndex,
  indexStoryWords,
  indexChatMessageWords,
  indexMediaEpisodeWords,
} from "../api/client";
import { extractWordOccurrences } from "../lib/storyWordIndex";

const STORY_GAP_MS = 200;

type SourceKind = "story" | "chat_message" | "media_episode";

interface QueuedItem {
  kind: SourceKind;
  id: number;
  content: string;
}

interface WordIndexBackfillContextType {
  remaining: number;
  processing: boolean;
  /** Id of the currently-processing source, regardless of kind. */
  currentSourceId: number | null;
  /** Kind of the currently-processing source, when one is in flight. */
  currentSourceKind: SourceKind | null;
  /** Convenience: currentSourceId when the active source is a story, else null. */
  currentStoryId: number | null;
  /** Convenience: currentSourceId when the active source is a chat message, else null. */
  currentChatMessageId: number | null;
  /** Convenience: currentSourceId when the active source is a media episode, else null. */
  currentMediaEpisodeId: number | null;
  error: string | null;
  refresh: () => void;
}

const WordIndexBackfillContext =
  createContext<WordIndexBackfillContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useWordIndexBackfill() {
  const ctx = useContext(WordIndexBackfillContext);
  if (!ctx) {
    throw new Error(
      "useWordIndexBackfill must be used within WordIndexBackfillProvider"
    );
  }
  return ctx;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function WordIndexBackfillProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { state: dictState } = useDictionary();

  const [remaining, setRemaining] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [currentSourceId, setCurrentSourceId] = useState<number | null>(null);
  const [currentSourceKind, setCurrentSourceKind] = useState<SourceKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The queue lives in a ref because the processing loop reads/writes it in
  // a tight loop and we don't need React to re-render between items.
  const queueRef = useRef<QueuedItem[]>([]);
  // Identity check so we can cancel a stale loop after sign-out or refresh.
  const runIdRef = useRef(0);
  const loopRunningRef = useRef(false);

  const loadQueue = useCallback(async (): Promise<QueuedItem[]> => {
    const [storyRows, chatRows, mediaRows] = await Promise.all([
      getStoriesNeedingIndex(),
      getChatMessagesNeedingIndex(),
      getMediaEpisodesNeedingIndex(),
    ]);
    const items: QueuedItem[] = [
      ...storyRows.map((s) => ({ kind: "story" as const, id: s.id, content: s.content })),
      ...chatRows.map((m) => ({
        kind: "chat_message" as const,
        id: m.id,
        content: m.content,
      })),
      ...mediaRows.map((e) => ({
        kind: "media_episode" as const,
        id: e.id,
        content: e.content,
      })),
    ];
    return items;
  }, []);

  // Queue hydrate — runs whenever the user changes (sign-in / sign-out) or
  // when the dictionary becomes ready. Both gates have to be satisfied
  // before we can do useful work, so we wait for both before fetching.
  useEffect(() => {
    if (!user || dictState !== "ready") {
      queueRef.current = [];
      runIdRef.current += 1;
      setRemaining(0);
      setProcessing(false);
      setCurrentSourceId(null);
      setCurrentSourceKind(null);
      return;
    }
    let cancelled = false;
    setError(null);
    loadQueue()
      .then((items) => {
        if (cancelled) return;
        queueRef.current = items;
        setRemaining(items.length);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("Backfill hydrate failed:", err);
        setError(err instanceof Error ? err.message : "Failed to load queue");
      });
    return () => {
      cancelled = true;
    };
  }, [user, dictState, loadQueue]);

  const runLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    const myRunId = ++runIdRef.current;
    setProcessing(true);
    setError(null);

    try {
      while (
        queueRef.current.length > 0 &&
        runIdRef.current === myRunId
      ) {
        const item = queueRef.current[0]!;
        setCurrentSourceId(item.id);
        setCurrentSourceKind(item.kind);
        try {
          // extractWordOccurrences only reads `.content` — same shape works
          // for both stories and chat messages.
          const occurrences = await extractWordOccurrences(item);
          if (runIdRef.current !== myRunId) return;
          if (item.kind === "story") {
            await indexStoryWords(item.id, occurrences);
          } else if (item.kind === "chat_message") {
            await indexChatMessageWords(item.id, occurrences);
          } else {
            await indexMediaEpisodeWords(item.id, occurrences);
          }
        } catch (err) {
          // Per-item failures get logged and the item stays at the head
          // of the queue. We pop it anyway so we don't infinite-loop on a
          // broken row; the next session will re-pick it up.
          console.warn("Backfill failed for", item.kind, item.id, err);
        }
        if (runIdRef.current !== myRunId) return;
        queueRef.current.shift();
        setRemaining(queueRef.current.length);
        if (queueRef.current.length > 0) await sleep(STORY_GAP_MS);
      }
    } finally {
      if (runIdRef.current === myRunId) {
        setProcessing(false);
        setCurrentSourceId(null);
        setCurrentSourceKind(null);
      }
      loopRunningRef.current = false;
    }
  }, []);

  // Auto-start the loop whenever the gates pass and there's work to do.
  useEffect(() => {
    if (!user || dictState !== "ready") return;
    if (queueRef.current.length === 0) return;
    void runLoop();
  }, [user, dictState, remaining, runLoop]);

  const refresh = useCallback(() => {
    if (!user || dictState !== "ready") return;
    loadQueue()
      .then((items) => {
        queueRef.current = items;
        setRemaining(items.length);
      })
      .catch((err) => {
        console.warn("Backfill refresh failed:", err);
      });
  }, [user, dictState, loadQueue]);

  const currentStoryId =
    currentSourceKind === "story" ? currentSourceId : null;
  const currentChatMessageId =
    currentSourceKind === "chat_message" ? currentSourceId : null;
  const currentMediaEpisodeId =
    currentSourceKind === "media_episode" ? currentSourceId : null;

  const value = useMemo(
    () => ({
      remaining,
      processing,
      currentSourceId,
      currentSourceKind,
      currentStoryId,
      currentChatMessageId,
      currentMediaEpisodeId,
      error,
      refresh,
    }),
    [
      remaining,
      processing,
      currentSourceId,
      currentSourceKind,
      currentStoryId,
      currentChatMessageId,
      currentMediaEpisodeId,
      error,
      refresh,
    ]
  );

  return (
    <WordIndexBackfillContext.Provider value={value}>
      {children}
    </WordIndexBackfillContext.Provider>
  );
}
