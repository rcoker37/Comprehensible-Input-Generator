import { useState } from "react";
import { markEpisodeRead, undoEpisodeRead } from "../api/client";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import type { EpisodeReadState, MediaEpisode } from "../types";

interface Props {
  episode: MediaEpisode;
  onChange: (state: EpisodeReadState) => void;
}

// Watched toggle for one episode. Binary single-read like StoryReadButton;
// "watched" is what gates the episode's encounters into the score, and the
// in-order presentation is the spoiler filter.
export default function EpisodeReadButton({ episode, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { prepareKanjiRefresh } = useSeenKanji();
  const { prepareVocabRefresh } = useVocab();

  const isRead = episode.read_count > 0;

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
        ? await undoEpisodeRead(episode.id)
        : await markEpisodeRead(episode.id);
      onChange(state);
      refreshScore();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update watched state");
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
        title={isRead ? "Tap to mark as unwatched" : "Mark as watched"}
      >
        {isRead ? "✓ Watched" : "Mark as Watched"}
      </button>
      {error && <div className="story-read-error">{error}</div>}
    </div>
  );
}
