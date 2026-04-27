import { useState } from "react";
import { setStoryRead } from "../api/client";
import type { Story } from "../types";

interface Props {
  story: Story;
  onChange: (read_at: string | null) => void;
}

export default function StoryReadButton({ story, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRead = story.read_at != null;

  const handleClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const read_at = await setStoryRead(story.id, !isRead);
      onChange(read_at);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update read status");
    } finally {
      setBusy(false);
    }
  };

  const title = isRead && story.read_at
    ? `Read on ${new Date(story.read_at).toLocaleString()} — click to unmark`
    : undefined;

  return (
    <div className="story-read-row">
      <button
        type="button"
        className={`story-read-btn ${isRead ? "is-read" : ""}`}
        onClick={handleClick}
        disabled={busy}
        title={title}
      >
        {isRead ? "✓ Read" : "Mark as Read"}
      </button>
      {error && <div className="story-read-error">{error}</div>}
    </div>
  );
}
