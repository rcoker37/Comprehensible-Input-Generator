// Media (anime / VTuber) series cache + annotation orchestration.
//
// Two jobs:
//  1. Cache the series list at AppLayout level so navigating between the media
//     pages doesn't refetch (analog of StoriesContext / ChatsContext).
//  2. Drive furigana annotation: import-media creates `pending` episodes but
//     does NOT annotate them. This context owns a serial queue that, for each
//     pending episode, kicks the annotate-media Edge Function and polls the
//     row until it flips to `complete` / `failed`, then nudges the word-index
//     backfill so the episode gets indexed. On mount it resumes any episodes
//     left mid-annotation by a previous tab.
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
import { useWordIndexBackfill } from "./WordIndexBackfillContext";
import {
  annotateEpisode,
  getEpisode,
  getInFlightEpisodes,
  getSeriesList,
} from "../api/client";
import type { MediaSeries } from "../types";

const POLL_MS = 3000;
const STALE_MS = 5 * 60 * 1000;

interface QueueItem {
  episodeId: number;
  // True when the episode is already 'annotating' server-side (resumed on
  // mount) — we poll without re-triggering annotate-media.
  alreadyStarted: boolean;
}

interface MediaContextType {
  seriesList: MediaSeries[];
  seriesLoaded: boolean;
  refreshSeries: () => void;
  addSeries: (series: MediaSeries) => void;
  removeSeries: (id: number) => void;
  /** Queue these episode IDs for annotation (called right after import). */
  annotateEpisodes: (episodeIds: number[]) => void;
  /** Episode IDs currently being annotated/polled. */
  inFlight: Set<number>;
  /** Bumps each time an episode reaches a terminal state, so pages can refetch. */
  completedTick: number;
}

const MediaContext = createContext<MediaContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with provider
export function useMedia() {
  const ctx = useContext(MediaContext);
  if (!ctx) throw new Error("useMedia must be used within MediaProvider");
  return ctx;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => window.setTimeout(r, ms));
}

export function MediaProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { refresh: refreshBackfill } = useWordIndexBackfill();

  const [seriesList, setSeriesList] = useState<MediaSeries[]>([]);
  const [seriesLoaded, setSeriesLoaded] = useState(false);
  const [inFlight, setInFlight] = useState<Set<number>>(() => new Set());
  const [completedTick, setCompletedTick] = useState(0);

  const queueRef = useRef<QueueItem[]>([]);
  const loopRunningRef = useRef(false);
  const runIdRef = useRef(0);

  const refreshSeries = useCallback(() => {
    if (!user) return;
    getSeriesList()
      .then((list) => {
        setSeriesList(list);
        setSeriesLoaded(true);
      })
      .catch((err) => console.warn("Failed to load series:", err));
  }, [user]);

  const addSeries = useCallback((series: MediaSeries) => {
    setSeriesList((prev) => {
      const rest = prev.filter((s) => s.id !== series.id);
      return [series, ...rest];
    });
  }, []);

  const removeSeries = useCallback((id: number) => {
    setSeriesList((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const markInFlight = useCallback((id: number, on: boolean) => {
    setInFlight((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const runLoop = useCallback(async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    const myRunId = ++runIdRef.current;
    try {
      while (queueRef.current.length > 0 && runIdRef.current === myRunId) {
        const item = queueRef.current[0]!;
        markInFlight(item.episodeId, true);
        const startedAt = Date.now();
        try {
          if (!item.alreadyStarted) {
            await annotateEpisode(item.episodeId);
          }
          // Poll until terminal or stale.
          for (;;) {
            if (runIdRef.current !== myRunId) return;
            await sleep(POLL_MS);
            let ep;
            try {
              ep = await getEpisode(item.episodeId);
            } catch {
              continue;
            }
            if (ep.status === "complete") {
              refreshBackfill();
              break;
            }
            if (ep.status === "failed") break;
            if (Date.now() - startedAt > STALE_MS) break;
          }
        } catch (err) {
          console.warn("Annotation failed for episode", item.episodeId, err);
        } finally {
          markInFlight(item.episodeId, false);
        }
        if (runIdRef.current !== myRunId) return;
        queueRef.current.shift();
        setCompletedTick((t) => t + 1);
      }
    } finally {
      loopRunningRef.current = false;
    }
  }, [markInFlight, refreshBackfill]);

  const annotateEpisodes = useCallback(
    (episodeIds: number[]) => {
      const existing = new Set(queueRef.current.map((q) => q.episodeId));
      for (const id of episodeIds) {
        if (!existing.has(id)) {
          queueRef.current.push({ episodeId: id, alreadyStarted: false });
        }
      }
      void runLoop();
    },
    [runLoop]
  );

  // Load series + resume any in-flight episodes on sign-in.
  useEffect(() => {
    if (!user) {
      queueRef.current = [];
      runIdRef.current += 1;
      setSeriesList([]);
      setSeriesLoaded(false);
      setInFlight(new Set());
      return;
    }
    refreshSeries();
    let cancelled = false;
    getInFlightEpisodes()
      .then((eps) => {
        if (cancelled || eps.length === 0) return;
        const existing = new Set(queueRef.current.map((q) => q.episodeId));
        for (const ep of eps) {
          if (existing.has(ep.id)) continue;
          queueRef.current.push({
            episodeId: ep.id,
            alreadyStarted: ep.status === "annotating",
          });
        }
        void runLoop();
      })
      .catch((err) => console.warn("Failed to resume annotations:", err));
    return () => {
      cancelled = true;
    };
  }, [user, refreshSeries, runLoop]);

  const value = useMemo(
    () => ({
      seriesList,
      seriesLoaded,
      refreshSeries,
      addSeries,
      removeSeries,
      annotateEpisodes,
      inFlight,
      completedTick,
    }),
    [
      seriesList,
      seriesLoaded,
      refreshSeries,
      addSeries,
      removeSeries,
      annotateEpisodes,
      inFlight,
      completedTick,
    ]
  );

  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}
