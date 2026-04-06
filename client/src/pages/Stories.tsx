import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { getStories, deleteStory } from "../api/client";
import type { Story } from "../types";
import DifficultyBadge from "../components/DifficultyBadge";
import "./Stories.css";

export default function Stories() {
  const [stories, setStories] = useState<Story[]>([]);
  const [loading, setLoading] = useState(true);

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
                  {story.title}
                </Link>
                <button
                  className="delete-btn"
                  onClick={() => handleDelete(story.id)}
                  title="Delete story"
                >
                  &times;
                </button>
              </div>
              <div className="story-card-meta">
                <DifficultyBadge difficulty={story.difficulty} />
                <span className="formality-tag">{story.formality}</span>
                {story.topic && <span className="topic-tag">{story.topic}</span>}
                <span className="date">
                  {new Date(story.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
