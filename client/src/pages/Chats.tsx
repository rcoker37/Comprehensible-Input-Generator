import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deleteChat } from "../api/client";
import { useChats } from "../contexts/ChatsContext";
import { stripBold } from "../lib/text";
import { stripAnnotations } from "../lib/furigana";
import AnimatedDots from "../components/AnimatedDots";
import "./Chats.css";

function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const m = Math.floor(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(iso).toLocaleDateString();
}

export default function Chats() {
  const { chats, chatsLoaded, error, removeChat } = useChats();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const navigate = useNavigate();

  if (!chatsLoaded) {
    return (
      <div className="loading">
        Loading chats
        <AnimatedDots />
      </div>
    );
  }

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this chat? This cannot be undone.")) return;
    try {
      await deleteChat(id);
      removeChat(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete chat");
    }
  };

  return (
    <div className="chats-page">
      <div className="chats-page-header">
        <div>
          <h1>Chat</h1>
          <div className="chats-page-sub">
            {chats.length} {chats.length === 1 ? "conversation" : "conversations"}
          </div>
        </div>
      </div>
      {(error || deleteError) && (
        <div className="error">{deleteError ?? error}</div>
      )}
      {chats.length === 0 ? (
        <p className="empty">
          No chats yet. Tap the + button to start a Japanese conversation.
        </p>
      ) : (
        <div className="chat-list">
          {chats.map((chat) => (
            <div key={chat.id} className="chat-card">
              <div className="chat-card-header">
                <Link to={`/chats/${chat.id}`} className="chat-card-title">
                  {stripAnnotations(stripBold(chat.title))}
                </Link>
                <div className="chat-card-header-actions">
                  {chat.min_assistant_read_count != null &&
                    chat.min_assistant_read_count > 0 && (
                      <span className="read-tag">
                        {chat.min_assistant_read_count > 1
                          ? `✓ Read ${chat.min_assistant_read_count}×`
                          : "✓ Read"}
                      </span>
                    )}
                  <button
                    className="delete-btn"
                    onClick={() => handleDelete(chat.id)}
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <line x1="3" y1="3" x2="11" y2="11" />
                      <line x1="11" y1="3" x2="3" y2="11" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="chat-card-meta">
                <span className="date">
                  {formatRelativeDate(chat.last_activity_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        className="fab-generate"
        onClick={() => navigate("/chats/new")}
        title="Start a new chat"
        aria-label="Start a new chat"
      >
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
