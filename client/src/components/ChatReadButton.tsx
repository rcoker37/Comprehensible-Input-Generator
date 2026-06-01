import { useState } from "react";
import { markChatRead, undoChatRead } from "../api/client";
import { formatScore } from "../lib/rarity";
import type { Chat, ChatMessageMarkUpdate } from "../types";
import "./ChatReadButton.css";

interface Props {
  chat: Chat;
  /**
   * Message IDs of every complete assistant message in the chat, used so
   * the undo path knows which messages to reset when the user toggles a
   * fully-read chat back to unread.
   */
  completeAssistantMessageIds: number[];
  /**
   * Score gain (kanji + vocab combined) the next chat-level mark would
   * award. Zero when every complete assistant message is already read.
   */
  payoutDelta: number;
  /** Loaded gate: hide the score hint until the payout map has resolved. */
  payoutLoaded: boolean;
  /**
   * Called once with every per-message row the toggle actually updated.
   * ChatDetail patches its cached message list and recomputes MIN for the
   * chats-list card from this.
   */
  onBatchUpdate: (updates: ChatMessageMarkUpdate[]) => void;
  /**
   * Called after a successful mark or undo so the parent can refresh the
   * header score (kanji + vocab) and the per-chat payout cache.
   */
  onAfterChange: () => void;
}

// Toggle button: when any complete assistant message is unread the click
// marks them all as read; when every complete assistant message is read
// the click undoes them all (sets each back to 0). No cooldown, no cap.

export default function ChatReadButton({
  chat,
  completeAssistantMessageIds,
  payoutDelta,
  payoutLoaded,
  onBatchUpdate,
  onAfterChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const minCount = chat.min_assistant_read_count ?? 0;
  const isRead = minCount > 0;

  const handleToggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updates = isRead
        ? await undoChatRead(chat.id, completeAssistantMessageIds)
        : await markChatRead(chat.id);
      if (updates.length > 0) onBatchUpdate(updates);
      onAfterChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update read state");
    } finally {
      setBusy(false);
    }
  };

  const label = isRead ? "✓ Read" : "Mark Chat as Read";
  const payoutHint =
    !isRead && payoutLoaded && payoutDelta > 0
      ? ` (+${formatScore(payoutDelta)})`
      : "";

  const title = isRead
    ? "Tap to mark this chat as unread"
    : payoutLoaded
    ? `Marking would award +${formatScore(payoutDelta)}`
    : undefined;

  return (
    <div className="chat-read-row">
      <button
        type="button"
        className={`chat-read-btn ${isRead ? "is-read" : ""}`}
        onClick={handleToggle}
        disabled={busy}
        title={title}
      >
        {label}
        {payoutHint && <span className="chat-read-payout">{payoutHint}</span>}
      </button>
      {error && <div className="chat-read-error">{error}</div>}
    </div>
  );
}
