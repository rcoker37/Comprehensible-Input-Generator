import { createContext, useContext, useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from "react";
import {
  startStoryGeneration,
  getInFlightGeneration,
  getStory,
  markStoryFailed,
  deleteStory,
} from "../api/client";
import type { UnseenWordTarget } from "../lib/generation";
import type { ContentType, Formality } from "../types";
import { useWordIndexBackfill } from "./WordIndexBackfillContext";
import { useStories } from "./StoriesContext";

const POLL_INTERVAL_MS = 3000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface GenerateParams {
  contentType: ContentType;
  topic?: string;
  style?: string;
  formality: Formality;
  model: string;
  seenKanji: Set<string>;
  unseenWordTarget: UnseenWordTarget;
  seenWords: Set<string>;
}

interface GenerationContextType {
  loading: boolean;
  error: string | null;
  startedAt: number | null;
  generate: (userId: string, params: GenerateParams) => void;
}

const GenerationContext = createContext<GenerationContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useGeneration() {
  const ctx = useContext(GenerationContext);
  if (!ctx) throw new Error("useGeneration must be used within GenerationProvider");
  return ctx;
}

export function GenerationProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const { refresh: refreshBackfill } = useWordIndexBackfill();
  const { addStory, removeStory } = useStories();
  // Mirror in refs so the polling tick (captured inside a useCallback with
  // empty deps) reads the latest fns without rebuilding the callback.
  const refreshBackfillRef = useRef(refreshBackfill);
  const addStoryRef = useRef(addStory);
  const removeStoryRef = useRef(removeStory);
  useEffect(() => {
    refreshBackfillRef.current = refreshBackfill;
    addStoryRef.current = addStory;
    removeStoryRef.current = removeStory;
  }, [refreshBackfill, addStory, removeStory]);
  // The id of the failed row, so dismissError() / generate() retry can clean
  // it up from the DB.
  const failedIdRef = useRef<number | null>(null);
  // Each call to startPolling bumps this token; in-flight ticks check it
  // against their captured copy so a stale chain (cancelled by stopPolling
  // or replaced by a new generate()) can't update state. We don't gate on a
  // single boolean because React 18 StrictMode runs cleanups during the
  // simulated unmount/remount cycle in dev — a permanent "unmounted" flag
  // would silently kill polling forever.
  const pollTokenRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    pollTokenRef.current += 1;
    if (pollTimerRef.current != null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => { stopPolling(); };
  }, [stopPolling]);

  const startPolling = useCallback((storyId: number, started: number) => {
    pollTokenRef.current += 1;
    const myToken = pollTokenRef.current;

    setStartedAt(started);
    setError(null);
    failedIdRef.current = null;

    const isStale = () => pollTokenRef.current !== myToken;

    const tick = async () => {
      pollTimerRef.current = null;
      if (isStale()) return;
      try {
        const fresh = await getStory(storyId);
        if (isStale()) return;
        if (fresh.status === "complete") {
          // Intentionally do not surface the story here — the Generator page
          // is fire-and-forget; completed stories live on the Compositions
          // page. We only need to flip loading off so the user can generate
          // again.
          setStartedAt(null);
          // Insert the row into the cached Compositions list so the user
          // sees it on next navigation without forcing a refetch.
          addStoryRef.current(fresh);
          // Pull the freshly-completed story into the word-index backfill
          // queue so its tap-spans are precomputed in the background. The
          // queue is hydrated on auth-ready and wouldn't otherwise see this
          // row until next session.
          refreshBackfillRef.current();
          return;
        }
        if (fresh.status === "failed") {
          setError(fresh.error_message || "Generation failed");
          failedIdRef.current = storyId;
          setStartedAt(null);
          return;
        }
        // Still generating — promote to failed if it's been too long, then
        // keep polling so the UI flips on the next tick.
        if (Date.now() - started > STALE_THRESHOLD_MS) {
          try {
            await markStoryFailed(storyId, "Generation timed out");
          } catch (err) {
            console.warn("Failed to mark story timed out:", err);
          }
        }
        if (isStale()) return;
        pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      } catch (err) {
        console.warn("Polling error:", err);
        if (isStale()) return;
        pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    pollTimerRef.current = window.setTimeout(tick, POLL_INTERVAL_MS);
  }, []);

  // Hydrate on mount: if a generation is in flight (e.g., user reloaded the
  // page mid-generation), resume polling against that row. Failed rows are
  // not surfaced on mount — the user already moved on; errors are only shown
  // for failures observed within the current session via polling.
  useEffect(() => {
    let cancelled = false;
    getInFlightGeneration()
      .then((existing) => {
        if (cancelled || !existing) return;
        if (existing.status === "generating") {
          startPolling(existing.id, new Date(existing.created_at).getTime());
        }
      })
      .catch((err) => console.warn("Hydrate generation failed:", err));
    return () => { cancelled = true; };
  }, [startPolling]);

  const generate = useCallback((userId: string, params: GenerateParams) => {
    stopPolling();
    setError(null);

    // Best-effort cleanup of the previous failed row before retrying, so it
    // doesn't accumulate in the DB.
    if (failedIdRef.current != null) {
      const id = failedIdRef.current;
      failedIdRef.current = null;
      removeStoryRef.current(id);
      deleteStory(id).catch((err) => console.warn("Failed to clean up failed story row:", err));
    }

    // Optimistically enter "generating" state so the button locks immediately.
    const started = Date.now();
    setStartedAt(started);

    startStoryGeneration(userId, params)
      .then((res) => startPolling(res.storyId, started))
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : "Generation failed";
        // 409: the Edge Function refused because a generation is already in
        // flight (e.g., started in another tab). Recover by polling the
        // existing row instead of erroring out.
        if (message.toLowerCase().includes("already in progress")) {
          try {
            const existing = await getInFlightGeneration();
            if (existing && existing.status === "generating") {
              startPolling(existing.id, new Date(existing.created_at).getTime());
              return;
            }
          } catch (e) {
            console.warn("Hydrate after 409 failed:", e);
          }
        }
        setError(message);
        setStartedAt(null);
      });
  }, [startPolling, stopPolling]);

  const loading = startedAt !== null;

  const value = useMemo(
    () => ({ loading, error, startedAt, generate }),
    [loading, error, startedAt, generate]
  );

  return (
    <GenerationContext.Provider value={value}>
      {children}
    </GenerationContext.Provider>
  );
}
