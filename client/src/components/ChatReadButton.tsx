import { useState } from "react";
import { markChatRead, undoChatRead } from "../api/client";
import { formatScore } from "../lib/rarity";
import type { Chat, ChatMessageMarkUpdate } from "../types";
import "./ChatReadButton.css";

interface Props {
  chat: Chat;
  /**
   * Score gain (kanji + vocab combined) the next chat-level mark would
   * award. The caller computes this from the per-chat payout map
   * cached at the AppLayout level. Zero means nothing's available —
   * either every message is on cooldown, at the 5× cap, or the chat
   * has no complete assistant replies yet.
   */
  payoutDelta: number;
  /** Loaded gate: hide the score hint until the payout map has resolved. */
  payoutLoaded: boolean;
  /**
   * Called once with every per-message row the fan-out actually
   * updated. ChatDetail uses this to patch its cached message list and
   * recompute MIN for the chats-list card.
   */
  onBatchUpdate: (updates: ChatMessageMarkUpdate[]) => void;
  /**
   * Called after a successful mark or undo so the parent can refresh
   * the header score (kanji + vocab) and the per-chat payout cache.
   */
  onAfterChange: () => void;
}

// Mirror of StoryReadButton: same per-session lock semantics, same
// "✓ Read N×" label style. The button fans out to every complete
// assistant message in the chat via mark_chat_read, which respects the
// per-message cap and cooldown — so reads will naturally drift if new
// messages arrive on a different cadence than re-reads, but the user no
// longer has a per-message affordance that can desync them deliberately.
//
// The same-session undo holds the list of message IDs the mark touched
// (returned by the RPC) and feeds it back to undo_chat_read. Reload
// starts a fresh session and locks the undo path, matching how
// StoryReadButton drops its per-session lock on unmount.

export default function ChatReadButton({
  chat,
  payoutDelta,
  payoutLoaded,
  onBatchUpdate,
  onAfterChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionMarkedIds, setSessionMarkedIds] = useState<number[]>([]);

  const minCount = chat.min_assistant_read_count ?? 0;
  const isRead = minCount > 0;
  const markedThisSession = sessionMarkedIds.length > 0;
  // Locked when there's no payout to award — every message is at cap or
  // inside the 24h cooldown. We also lock after a successful mark so the
  // button can show the same-session undo affordance.
  const noPayout = payoutLoaded && payoutDelta <= 0;
  const locked = noPayout && !markedThisSession;

  const handleMark = async () => {
    if (busy || markedThisSession || locked) return;
    setBusy(true);
    setError(null);
    try {
      const updates = await markChatRead(chat.id);
      if (updates.length > 0) {
        onBatchUpdate(updates);
        setSessionMarkedIds(updates.map((u) => u.message_id));
      }
      onAfterChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark chat as read");
    } finally {
      setBusy(false);
    }
  };

  const handleUndo = async () => {
    if (busy || sessionMarkedIds.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const updates = await undoChatRead(chat.id, sessionMarkedIds);
      if (updates.length > 0) onBatchUpdate(updates);
      setSessionMarkedIds([]);
      onAfterChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo");
    } finally {
      setBusy(false);
    }
  };

  // Label mirrors StoryReadButton: untouched chats show the action;
  // partially-read chats surface MIN so it lines up with the chats-list
  // "✓ Read N×" tag.
  const label = !isRead ? "Mark Chat as Read" : `✓ Read ${minCount}×`;
  const payoutHint =
    payoutLoaded && payoutDelta > 0 ? ` (+${formatScore(payoutDelta)})` : "";

  const title = markedThisSession
    ? "Already marked as read this session"
    : locked
    ? "Caught up — come back later for the next pass"
    : payoutLoaded
    ? `Marking would award +${formatScore(payoutDelta)}`
    : undefined;

  return (
    <div className="chat-read-row">
      <div className="chat-read-controls">
        <button
          type="button"
          className={`chat-read-btn ${isRead ? "is-read" : ""}`}
          onClick={handleMark}
          disabled={busy || markedThisSession || locked}
          title={title}
        >
          {label}
          {payoutHint && <span className="chat-read-payout">{payoutHint}</span>}
        </button>
        {markedThisSession && (
          <button
            type="button"
            className="chat-read-undo-btn"
            onClick={handleUndo}
            disabled={busy}
            title="Undo this session's mark"
            aria-label="Undo this session's mark as read"
          >
            undo
          </button>
        )}
      </div>
      {error && <div className="chat-read-error">{error}</div>}
    </div>
  );
}
