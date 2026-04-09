import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getStories, deleteStory } from "../api/client";
import { useKnownKanji } from "../contexts/KanjiContext";
import type { Story } from "../types";
import "./Stories.css";

const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/g;

export default function Stories() {
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);
  const { knownKanji } = useKnownKanji();

  const unknownCount = (text?: string | null) => {
    if (!text) return 0;
    const unique = new Set(text.match(KANJI_REGEX) || []);
    return [...unique].filter((k) => !knownKanji.has(k)).length;
  };

  useEffect(() => {
    getStories()
      .then(setStories)
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: number) => {
    await deleteStory(id);
    setStories((prev) => prev.filter((s) => s.id !== id));
  };

  if (loading) return <div className="loading">Loading stories...</div>;

  return (
    <div className="stories-page">
      <h1>Story History</h1>
      {stories.length === 0 ? (
        <p className="empty">No stories yet. Generate one from the home page!</p>
      ) : (
        <div className="story-list">
          {stories.map((story) => (
            <div key={story.id} className="story-card">
              <div className="story-card-header">
                <Link to={`/stories/${story.id}`} className="story-card-title">
                  {story.title.replace(/\*\*/g, "")}
                </Link>
                <button
                  className="delete-btn"
                  onClick={() => handleDelete(story.id)}
                  title="Delete story"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>
                </button>
              </div>
              <div className="story-card-meta">
                <span className="date">
                  {new Date(story.created_at).toLocaleDateString()}
                </span>
                <span className={`unknown-tag ${unknownCount(story.content) === 0 ? "none" : ""}`}>
                  {unknownCount(story.content)} unknown kanji
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
