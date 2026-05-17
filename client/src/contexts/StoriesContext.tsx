// Cache for the Compositions page so navigating away and back doesn't
// re-fetch `getStories` and `getPerStoryWordOccurrences`. Lives in
// AppLayout (above the route Outlet), so its state persists across
// route changes the way KanjiContext and VocabContext already do.
//
// Mutations everywhere else in the app flow through here:
//   - GenerationContext calls addStory() when a story completes.
//   - StoryReadButton's onChange → applyStoryUpdate() patches read_count.
//   - delete handlers in Stories.tsx + StoryDetail.tsx call removeStory().
// When the word-index backfill stops processing, occurrences are
// re-fetched so a freshly-indexed story's payout reflects its real
// per-headword counts.
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
import { getStories, getPerStoryWordOccurrences } from "../api/client";
import type { Story } from "../types";

interface StoriesContextType {
  stories: Story[];
  storiesLoaded: boolean;
  storyOccurrences: Map<number, Map<string, number>>;
  storyOccurrencesLoaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  refreshOccurrences: () => Promise<void>;
  addStory: (story: Story) => void;
  removeStory: (id: number) => void;
  applyStoryUpdate: (id: number, patch: Partial<Story>) => void;
}

const StoriesContext = createContext<StoriesContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useStories() {
  const ctx = useContext(StoriesContext);
  if (!ctx) throw new Error("useStories must be used within StoriesProvider");
  return ctx;
}

export function StoriesProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { processing: backfillProcessing } = useWordIndexBackfill();

  const [stories, setStories] = useState<Story[]>([]);
  const [storiesLoaded, setStoriesLoaded] = useState(false);
  const [storyOccurrences, setStoryOccurrences] = useState<
    Map<number, Map<string, number>>
  >(new Map());
  const [storyOccurrencesLoaded, setStoryOccurrencesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshOccurrences = useCallback(async () => {
    if (!user) return;
    try {
      const occ = await getPerStoryWordOccurrences();
      setStoryOccurrences(occ);
    } catch (err) {
      console.warn("Per-story occurrences refresh failed:", err);
    } finally {
      setStoryOccurrencesLoaded(true);
    }
  }, [user]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setError(null);
    await Promise.all([
      getStories()
        .then(setStories)
        .catch((err) => {
          setError(
            err instanceof Error ? err.message : "Failed to load compositions"
          );
        })
        .finally(() => setStoriesLoaded(true)),
      refreshOccurrences(),
    ]);
  }, [user, refreshOccurrences]);

  useEffect(() => {
    if (!user) {
      setStories([]);
      setStoriesLoaded(false);
      setStoryOccurrences(new Map());
      setStoryOccurrencesLoaded(false);
      setError(null);
      return;
    }
    refresh();
  }, [user, refresh]);

  // Backfill writes new rows into `story_word_occurrences`. When it
  // transitions from processing back to idle, refresh just the
  // occurrences so the affected stories' payout tags reflect the new
  // index without forcing a full stories-list refetch.
  const prevBackfillProcessingRef = useRef(false);
  useEffect(() => {
    if (prevBackfillProcessingRef.current && !backfillProcessing && user) {
      refreshOccurrences();
    }
    prevBackfillProcessingRef.current = backfillProcessing;
  }, [backfillProcessing, user, refreshOccurrences]);

  const addStory = useCallback((story: Story) => {
    setStories((prev) => {
      if (prev.some((s) => s.id === story.id)) return prev;
      return [story, ...prev];
    });
  }, []);

  const removeStory = useCallback((id: number) => {
    setStories((prev) => prev.filter((s) => s.id !== id));
    setStoryOccurrences((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const applyStoryUpdate = useCallback(
    (id: number, patch: Partial<Story>) => {
      setStories((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...patch } : s))
      );
    },
    []
  );

  const value = useMemo(
    () => ({
      stories,
      storiesLoaded,
      storyOccurrences,
      storyOccurrencesLoaded,
      error,
      refresh,
      refreshOccurrences,
      addStory,
      removeStory,
      applyStoryUpdate,
    }),
    [
      stories,
      storiesLoaded,
      storyOccurrences,
      storyOccurrencesLoaded,
      error,
      refresh,
      refreshOccurrences,
      addStory,
      removeStory,
      applyStoryUpdate,
    ]
  );

  return (
    <StoriesContext.Provider value={value}>{children}</StoriesContext.Provider>
  );
}
