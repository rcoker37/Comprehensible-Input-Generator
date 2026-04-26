import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getStory, deleteStory } from "../api/client";
import type { Story, StoryAudio } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import PlaybackFooter from "../components/PlaybackFooter";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import "./StoryDetail.css";

export default function StoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      getStory(Number(id))
        .then(setStory)
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to load story"))
        .finally(() => setLoading(false));
    }
  }, [id]);

  const handleAudioGenerated = useCallback((audio: StoryAudio) => {
    setStory((s) => (s ? { ...s, audio } : s));
  }, []);

  const player = useAudioPlayer(story, handleAudioGenerated);

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm("Delete this story? This cannot be undone.")) return;
    try {
      await deleteStory(Number(id));
      navigate("/stories");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete story");
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">{error}</div>;
  if (!story) return <div className="error">Story not found</div>;

  return (
    <div className="story-detail-page">
      <div className="story-detail-actions">
        <button
          type="button"
          className="story-detail-back"
          onClick={() => navigate("/stories")}
        >
          &larr; Stories
        </button>
        <div className="story-detail-actions-right">
          <button
            type="button"
            className="story-detail-icon-btn"
            onClick={player.handleRegenerate}
            disabled={!player.audio || player.regenerating || player.loading}
            title={player.regenerating ? "Regenerating…" : "Regenerate audio"}
            aria-label="Regenerate audio"
          >
            {player.regenerating ? (
              <span className="playback-spinner" aria-hidden="true" />
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M13.5 2.5v3.5h-3.5" />
                <path d="M13.5 6A5.5 5.5 0 1 0 14 9.5" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="story-detail-icon-btn"
            onClick={handleDelete}
            title="Delete story"
            aria-label="Delete story"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.5 4h11" />
              <path d="M6 4V2.5h4V4" />
              <path d="M3.5 4l.7 9a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4" />
            </svg>
          </button>
        </div>
      </div>
      <StoryDisplay
        story={story}
        audio={player.audio}
        activeSegmentIdx={player.activeSegmentIdx}
        onSentenceClick={player.seekToSegment}
      />
      <PlaybackFooter {...player} />
    </div>
  );
}
