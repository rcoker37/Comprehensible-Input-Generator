import { useState } from "react";
import { indexStoryWords, markStoryRead, undoStoryRead } from "../api/client";
import { useKnownKanji } from "../contexts/KanjiContext";
import { extractWordOccurrences } from "../lib/storyWordIndex";
import type { Story, StoryReadState } from "../types";

interface Props {
  story: Story;
  onChange: (state: StoryReadState) => void;
  onIndexed?: (wordIndexAt: string) => void;
}

// One mark per session: after the user clicks once, the primary button locks
// and the undo (−) button appears. Reload starts a fresh session. The undo
// affordance is therefore only ever wired to a same-session increment, so
// past-session reads can't be cleared from the UI — only deleting the story
// removes those. Server-side undo is a safety net (decrements with a floor of 0).
export default function StoryReadButton({ story, onChange, onIndexed }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markedThisSession, setMarkedThisSession] = useState(false);
  const { refreshKanjiExposures } = useKnownKanji();

  const count = story.read_count;
  const isRead = count > 0;

  const handleMark = async () => {
    if (markedThisSession) return;
    setBusy(true);
    setError(null);
    try {
      const state = await markStoryRead(story.id);
      onChange(state);
      setMarkedThisSession(true);
      refreshKanjiExposures();
      // First-time word indexing — fires after the read is recorded and runs
      // in the background so the UI stays responsive. Re-runs on subsequent
      // reads as long as `word_index_at` is null (e.g. previous attempt
      // failed, or the story was read before this feature shipped).
      if (!story.word_index_at) {
        void runWordIndex(story, onIndexed);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark as read");
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    setBusy(true);
    setError(null);
    try {
      const state = await undoStoryRead(story.id);
      onChange(state);
      setMarkedThisSession(false);
      refreshKanjiExposures();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo");
    } finally {
      setBusy(false);
    }
  };

  const label = !isRead ? "Mark as Read" : `✓ Read ${count}×`;

  const title = markedThisSession
    ? "Already marked as read this session"
    : isRead && story.last_read_at
    ? `Last read ${new Date(story.last_read_at).toLocaleString()} — click to mark as read again`
    : undefined;

  return (
    <div className="story-read-row">
      <div className="story-read-controls">
        <button
          type="button"
          className={`story-read-btn ${isRead ? "is-read" : ""}`}
          onClick={handleMark}
          disabled={busy || markedThisSession}
          title={title}
        >
          {label}
        </button>
        {markedThisSession && (
          <button
            type="button"
            className="story-read-undo-btn"
            onClick={handleUndo}
            disabled={busy}
            title="Undo this session's mark"
            aria-label="Undo this session's mark as read"
          >
            undo
          </button>
        )}
      </div>
      {error && <div className="story-read-error">{error}</div>}
    </div>
  );
}

async function runWordIndex(
  story: Story,
  onIndexed?: (wordIndexAt: string) => void
): Promise<void> {
  try {
    const occurrences = await extractWordOccurrences(story);
    const stampedAt = await indexStoryWords(story.id, occurrences);
    onIndexed?.(stampedAt);
  } catch (err) {
    // Indexing is best-effort — surface to the console so it's debuggable
    // but don't block the user. The next mark-as-read will retry because
    // `word_index_at` will still be null on the row.
    console.warn("Word indexing failed for story", story.id, err);
  }
}
