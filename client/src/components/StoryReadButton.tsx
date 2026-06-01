import { useState } from "react";
import { markStoryRead, undoStoryRead } from "../api/client";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import type { Story, StoryReadState } from "../types";

interface Props {
  story: Story;
  onChange: (state: StoryReadState) => void;
}

export default function StoryReadButton({ story, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { prepareKanjiRefresh } = useSeenKanji();
  const { prepareVocabRefresh } = useVocab();

  const isRead = story.read_count > 0;

  const refreshScore = async () => {
    const [commitKanji, commitVocab] = await Promise.all([
      prepareKanjiRefresh(),
      prepareVocabRefresh(),
    ]);
    commitKanji();
    commitVocab();
  };

  const handleToggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const state = isRead
        ? await undoStoryRead(story.id)
        : await markStoryRead(story.id);
      onChange(state);
      refreshScore();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update read state");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="story-read-row">
      <button
        type="button"
        className={`story-read-btn ${isRead ? "is-read" : ""}`}
        onClick={handleToggle}
        disabled={busy}
        title={isRead ? "Tap to mark as unread" : "Mark as read"}
      >
        {isRead ? "✓ Read" : "Mark as Read"}
      </button>
      {error && <div className="story-read-error">{error}</div>}
    </div>
  );
}
