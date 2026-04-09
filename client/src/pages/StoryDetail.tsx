import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { getStory, deleteStory } from "../api/client";
import type { Story } from "../types";
import StoryDisplay from "../components/StoryDisplay";

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

  const handleDelete = async () => {
    if (id) {
      try {
        await deleteStory(Number(id));
        navigate("/stories");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete story");
      }
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">{error}</div>;
  if (!story) return <div className="error">Story not found</div>;

  return (
    <div className="story-detail-page">
      <div className="story-detail-actions">
        <button onClick={() => navigate("/stories")}>&larr; Back</button>
        <button className="delete-btn" onClick={handleDelete}>
          Delete
        </button>
      </div>
      <StoryDisplay story={story} />
    </div>
  );
}
