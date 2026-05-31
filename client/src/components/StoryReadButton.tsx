import { useState } from "react";
import { markStoryRead, undoStoryRead } from "../api/client";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import {
  MAX_READ_COUNT,
  isOnReadCooldown,
  readCooldownLabel,
} from "../lib/readCooldown";
import type { Story, StoryReadState } from "../types";

interface Props {
  story: Story;
  onChange: (state: StoryReadState) => void;
}

// One mark per session: after the user clicks once, the primary button locks
// and the undo (−) button appears. Reload starts a fresh session. The undo
// affordance is therefore only ever wired to a same-session increment, so
// past-session reads can't be cleared from the UI — only deleting the story
// removes those. Server-side undo is a safety net (decrements with a floor of 0).
//
// Read count is capped at 3× server-side (mark_story_read uses
// LEAST(..., GREATEST(read_count, 3))). The mark button locks visually
// once count >= 3 so the cap is discoverable. Cooldown between reads is
// 24h normally and 7 days before the 3rd read (see lib/readCooldown.ts).
export default function StoryReadButton({ story, onChange }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markedThisSession, setMarkedThisSession] = useState(false);
  const { prepareKanjiRefresh } = useSeenKanji();
  const { prepareVocabRefresh } = useVocab();

  const count = story.read_count;
  const isRead = count > 0;
  const atCap = count >= MAX_READ_COUNT;
  const lockedAtCap = atCap && !markedThisSession;
  // Cooldown duration depends on count: 7 days when next mark is the 3rd
  // (count = 2), 24h otherwise. Server enforces the same predicate.
  // markedThisSession takes precedence so the user sees the friendlier
  // "this session" title.
  const onCooldown =
    !markedThisSession && isOnReadCooldown(story.last_read_at, count);

  // Refresh the header score after a read-state change. Both halves (kanji +
  // vocab) are fetched in parallel, then committed together in one tick so the
  // score re-renders once instead of jumping twice.
  const refreshScore = async () => {
    const [commitKanji, commitVocab] = await Promise.all([
      prepareKanjiRefresh(),
      prepareVocabRefresh(),
    ]);
    commitKanji();
    commitVocab();
  };

  const handleMark = async () => {
    if (markedThisSession || lockedAtCap || onCooldown) return;
    setBusy(true);
    setError(null);
    try {
      const state = await markStoryRead(story.id);
      onChange(state);
      setMarkedThisSession(true);
      refreshScore();
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
      refreshScore();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo");
    } finally {
      setBusy(false);
    }
  };

  const label = !isRead ? "Mark as Read" : `✓ Read ${count}×`;

  const title = markedThisSession
    ? "Already marked as read this session"
    : lockedAtCap
    ? `Already read ${MAX_READ_COUNT}× — the maximum`
    : onCooldown
    ? `Available again in ${readCooldownLabel(story.last_read_at, count)}`
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
          disabled={busy || markedThisSession || lockedAtCap || onCooldown}
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
