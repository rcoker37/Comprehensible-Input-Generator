import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { getStories, deleteStory } from "../api/client";
import { useKnownKanji } from "../contexts/KanjiContext";
import { stripBold, getUnknownKanji } from "../lib/text";
import { stripAnnotations } from "../lib/furigana";
import { formatScore, readingScoreDelta } from "../lib/rarity";
import type { Story } from "../types";
import "./Stories.css";

type ReadFilter = "all" | "unread" | "read";
type SortMode = "newest" | "score" | "adjustedScore";

export default function Stories() {
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readFilter, setReadFilter] = useState<ReadFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const { knownKanji, kanjiExposures } = useKnownKanji();

  const unknownCount = (text?: string | null) => {
    if (!text) return 0;
    return getUnknownKanji(text, knownKanji).size;
  };

  useEffect(() => {
    getStories()
      .then(setStories)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load compositions"))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this composition? This cannot be undone.")) return;
    try {
      await deleteStory(id);
      setStories((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete composition");
    }
  };

  const deltaById = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of stories) {
      m.set(s.id, readingScoreDelta(s.content, kanjiExposures));
    }
    return m;
  }, [stories, kanjiExposures]);

  if (loading) return <div className="loading">Loading compositions...</div>;

  const filtered = stories.filter((s) => {
    if (readFilter === "unread") return s.read_count === 0;
    if (readFilter === "read") return s.read_count > 0;
    return true;
  });

  const scoreFor = (s: Story) => deltaById.get(s.id) ?? 0;
  const adjustedScoreFor = (s: Story) => {
    const chars = stripAnnotations(s.content).length;
    return chars > 0 ? scoreFor(s) / chars : 0;
  };

  const visibleStories =
    sortMode === "score"
      ? [...filtered].sort((a, b) => scoreFor(b) - scoreFor(a))
      : sortMode === "adjustedScore"
      ? [...filtered].sort((a, b) => adjustedScoreFor(b) - adjustedScoreFor(a))
      : filtered;

  return (
    <div className="stories-page">
      <h1>Composition History</h1>
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
          <div className="filter-row">
            <label>Sort</label>
            <div className="chip-group" role="radiogroup" aria-label="Sort mode">
              {([
                ["newest", "Newest"],
                ["score", "Score"],
                ["adjustedScore", "Adjusted Score"],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  className={`chip ${sortMode === v ? "active" : ""}`}
                  onClick={() => setSortMode(v)}
                  aria-pressed={sortMode === v}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {stories.length === 0 ? (
        <p className="empty">No compositions yet. Generate one from the home page!</p>
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
                <span className={`unknown-tag ${unknownCount(story.content) === 0 ? "none" : ""}`}>
                  {unknownCount(story.content)} unknown kanji
                </span>
                {(deltaById.get(story.id) ?? 0) > 0 && (
                  <span className="score-tag" title="Score gain if read once more">
                    +{formatScore(deltaById.get(story.id) ?? 0)}
                  </span>
                )}
                <span className="type-tag">{story.content_type ?? "fiction"}</span>
                <span className="paragraphs-tag">
                  {story.paragraphs} {story.paragraphs === 1 ? "paragraph" : "paragraphs"}
                </span>
                <span className="formality-tag">{story.formality}</span>
                {story.topic && <span className="topic-tag">{story.topic}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
