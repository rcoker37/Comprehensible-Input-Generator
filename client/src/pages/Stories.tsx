import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { deleteStory } from "../api/client";
import GenerationModal from "../components/GenerationModal";
import { useGeneration } from "../contexts/GenerationContext";
import { useAuth } from "../contexts/AuthContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { useStories } from "../contexts/StoriesContext";
import { stripBold } from "../lib/text";
import { stripAnnotations } from "../lib/furigana";
import { formatScore, readingScoreDelta } from "../lib/rarity";
import { vocabScoreDelta } from "../lib/vocabScore";
import { MAX_READ_COUNT, isOnReadCooldown } from "../lib/readCooldown";
import type { ReadFilter, Story } from "../types";
import AnimatedDots from "../components/AnimatedDots";
import "./Stories.css";

export default function Stories() {
  const {
    stories,
    storiesLoaded,
    storyOccurrences,
    storyOccurrencesLoaded,
    error: contextError,
    removeStory,
  } = useStories();
  const { profile, updatePreferences } = useAuth();
  const { loading: generating } = useGeneration();
  const saved = profile?.preferences?.stories;
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [readFilter, setReadFilter] = useState<ReadFilter>(saved?.readFilter ?? "all");
  const { kanjiExposures } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded, getWordRank } = useVocab();

  // Skip the first effect run — that's just the initial render after hydrating
  // from the profile. Subsequent state changes write back to the server.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    updatePreferences({
      stories: { readFilter },
    }).catch((err) => console.warn("Failed to save filter preferences:", err));
  }, [readFilter, updatePreferences]);

  // Number of distinct headwords in the story that the user has never
  // encountered in a read story. Returns null until both halves of the
  // lookup (per-story occurrences + global vocab counts) have loaded so
  // the UI doesn't flash "0 unseen" before the data arrives.
  const unseenWordCount = (storyId: number): number | null => {
    if (!storyOccurrencesLoaded || !vocabEncountersLoaded) return null;
    const occMap = storyOccurrences.get(storyId);
    if (!occMap) return 0;
    let n = 0;
    for (const headword of occMap.keys()) {
      if ((vocabEncounters.get(headword) ?? 0) === 0) n += 1;
    }
    return n;
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this composition? This cannot be undone.")) return;
    try {
      await deleteStory(id);
      removeStory(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete composition");
    }
  };

  const error = deleteError ?? contextError;
  const loading = !storiesLoaded;

  // Wait for BOTH halves of the payout to load before computing any
  // deltas — otherwise the score tag (and score-sort) would flash a
  // kanji-only number for a beat while the paginated vocab RPC drains.
  const deltaById = useMemo(() => {
    const m = new Map<number, number>();
    if (!vocabEncountersLoaded || !storyOccurrencesLoaded) return m;
    for (const s of stories) {
      const kanji = readingScoreDelta(s.content, kanjiExposures);
      const occMap = storyOccurrences.get(s.id);
      const vocab = occMap
        ? vocabScoreDelta(occMap, vocabEncounters, getWordRank)
        : 0;
      m.set(s.id, kanji + vocab);
    }
    return m;
  }, [
    stories,
    kanjiExposures,
    storyOccurrences,
    storyOccurrencesLoaded,
    vocabEncounters,
    vocabEncountersLoaded,
    getWordRank,
  ]);

  if (loading) return <div className="loading">Loading compositions<AnimatedDots /></div>;

  // Stories at the cap or inside the per-step cooldown are hidden
  // entirely from the list — the mark-read button would be locked and
  // they aren't candidates for the user's next reading session. They
  // become visible again when the cooldown expires (or never, once at
  // cap), so the list mirrors what's actually actionable right now.
  const filtered = stories.filter((s) => {
    if (s.read_count >= MAX_READ_COUNT) return false;
    if (isOnReadCooldown(s.last_read_at, s.read_count)) return false;
    if (readFilter === "unread" && s.read_count !== 0) return false;
    if (readFilter === "read" && s.read_count === 0) return false;
    return true;
  });

  const scoreFor = (s: Story) => deltaById.get(s.id) ?? 0;

  const visibleStories = [...filtered].sort(
    (a, b) => scoreFor(b) - scoreFor(a)
  );

  return (
    <div className="stories-page">
      <div className="stories-page-header">
        <h1>Read</h1>
      </div>
      <GenerationModal open={modalOpen} onClose={() => setModalOpen(false)} />
      {error && <div className="error">{error}</div>}
      {stories.length > 0 && (
        <>
          <div className="filter-row">
            <label>Status</label>
            <div className="chip-group" role="radiogroup" aria-label="Read status filter">
              {(["all", "unread", "read"] as const).map((v) => (
                <button
                  key={v}
                  className={`chip ${readFilter === v ? "active" : ""}`}
                  onClick={() => setReadFilter(v)}
                  aria-pressed={readFilter === v}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {stories.length === 0 ? (
        <p className="empty">No compositions yet. Tap the + button to create one.</p>
      ) : visibleStories.length === 0 ? (
        <p className="empty">No compositions match this filter.</p>
      ) : (
        <div className="story-list">
          {visibleStories.map((story) => (
            <div key={story.id} className="story-card">
              <div className="story-card-header">
                <Link to={`/stories/${story.id}`} className="story-card-title">
                  {stripAnnotations(stripBold(story.title))}
                </Link>
                <div className="story-card-header-actions">
                  {story.read_count > 0 && (
                    <span
                      className="read-tag"
                      title={
                        story.last_read_at
                          ? `Last read ${new Date(story.last_read_at).toLocaleString()}`
                          : undefined
                      }
                    >
                      {story.read_count > 1 ? `✓ Read ${story.read_count}×` : "✓ Read"}
                    </span>
                  )}
                  <button
                    className="delete-btn"
                    onClick={() => handleDelete(story.id)}
                    title="Delete story"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>
                  </button>
                </div>
              </div>
              <div className="story-card-meta">
                <span className="date">
                  {new Date(story.created_at).toLocaleDateString()}
                </span>
                {(() => {
                  const n = unseenWordCount(story.id);
                  if (n === null) return null;
                  return (
                    <span className={`unknown-tag ${n === 0 ? "none" : ""}`}>
                      {n} unseen {n === 1 ? "word" : "words"}
                    </span>
                  );
                })()}
                {(deltaById.get(story.id) ?? 0) > 0 && (
                  <span className="score-tag" title="Score gain if read once more">
                    +{formatScore(deltaById.get(story.id) ?? 0)}
                  </span>
                )}
                <span className="type-tag">{story.content_type ?? "fiction"}</span>
                <span className="formality-tag">{story.formality}</span>
                {story.topic && <span className="topic-tag">{story.topic}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        className="fab-generate"
        onClick={() => setModalOpen(true)}
        disabled={generating}
        title={generating ? "Generation in progress…" : "Generate a new story"}
        aria-label={generating ? "Generating…" : "Generate a new story"}
      >
        {generating ? <span className="fab-spinner" /> : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        )}
      </button>
    </div>
  );
}
