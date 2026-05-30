import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deleteChat } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useChats } from "../contexts/ChatsContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { stripBold } from "../lib/text";
import { stripAnnotations } from "../lib/furigana";
import { formatScore, kanjiCountsDelta } from "../lib/rarity";
import { vocabScoreDelta } from "../lib/vocabScore";
import AnimatedDots from "../components/AnimatedDots";
import type { Chat, ChatSortMode, ReadFilter, SortDir } from "../types";
import "./Chats.css";

// Sorts whose chip toggles asc⇄desc on re-click. The score sort is always
// highest-first, so it isn't directional. Mirrors the Stories page.
const DIRECTIONAL_SORTS = new Set<ChatSortMode>(["lastActivity", "lastRead"]);

function sanitizeSortMode(mode: ChatSortMode | undefined): ChatSortMode {
  return mode === "score" || mode === "lastRead" ? mode : "lastActivity";
}

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
  const {
    chats,
    chatsLoaded,
    error,
    removeChat,
    perChatPayout,
    perChatPayoutLoaded,
  } = useChats();
  const { profile, updatePreferences } = useAuth();
  const { kanjiExposures, kanjiExposuresLoaded } = useSeenKanji();
  const {
    vocabEncounters,
    vocabEncountersLoaded,
    getWordRank,
  } = useVocab();
  const saved = profile?.preferences?.chats;
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [readFilter, setReadFilter] = useState<ReadFilter>(
    saved?.readFilter ?? "all"
  );
  const [sortMode, setSortMode] = useState<ChatSortMode>(
    sanitizeSortMode(saved?.sortMode)
  );
  const [sortDir, setSortDir] = useState<SortDir>(saved?.sortDir ?? "desc");
  const navigate = useNavigate();

  // Skip the first effect run — that's just the initial render after
  // hydrating from the profile. Subsequent state changes write back via
  // the existing update_preferences shallow-merge RPC.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    updatePreferences({
      chats: { readFilter, sortMode, sortDir },
    }).catch((err) => console.warn("Failed to save chat filter preferences:", err));
  }, [readFilter, sortMode, sortDir, updatePreferences]);

  // Selecting a directional sort that's already active flips its
  // direction; any other selection activates the sort fresh at desc.
  // Matches the handler on Stories.tsx and the Stats Browse chips.
  const handleSort = (mode: ChatSortMode) => {
    if (DIRECTIONAL_SORTS.has(mode) && sortMode === mode) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortMode(mode);
      setSortDir("desc");
    }
  };

  // Per-chat `+X` payout — sum of kanji + vocab deltas the next chat-
  // level Mark would award. Same shape as Stories.tsx's deltaById:
  // computed from the per-chat payout map (server already filters out
  // cap/cooldown messages) crossed with the live exposure/encounter
  // maps from KanjiContext / VocabContext.
  const deltaById = useMemo(() => {
    const m = new Map<number, number>();
    if (!perChatPayoutLoaded || !kanjiExposuresLoaded || !vocabEncountersLoaded) {
      return m;
    }
    for (const chat of chats) {
      const payout = perChatPayout.get(chat.id);
      if (!payout) {
        m.set(chat.id, 0);
        continue;
      }
      const kanji = kanjiCountsDelta(payout.kanjiCounts, kanjiExposures);
      const vocab = vocabScoreDelta(payout.wordCounts, vocabEncounters, getWordRank);
      m.set(chat.id, kanji + vocab);
    }
    return m;
  }, [
    chats,
    perChatPayout,
    perChatPayoutLoaded,
    kanjiExposures,
    kanjiExposuresLoaded,
    vocabEncounters,
    vocabEncountersLoaded,
    getWordRank,
  ]);

  const scoresReady =
    perChatPayoutLoaded && kanjiExposuresLoaded && vocabEncountersLoaded;

  // A chat counts as "unread" when at least one assistant message hasn't
  // been read through yet — i.e., MIN = 0 OR there's no complete
  // assistant message yet (min === null). "Read" means everyone's been
  // marked at least once.
  const filtered = chats.filter((c) => {
    const min = c.min_assistant_read_count;
    const isRead = min != null && min > 0;
    if (readFilter === "unread" && isRead) return false;
    if (readFilter === "read" && !isRead) return false;
    return true;
  });

  const scoreFor = (c: Chat) => deltaById.get(c.id) ?? 0;
  // asc compares low→high; desc flips it. The score sort ignores direction.
  const dirMul = sortDir === "asc" ? 1 : -1;
  const visibleChats =
    sortMode === "score"
      ? [...filtered].sort((a, b) => scoreFor(b) - scoreFor(a))
      : sortMode === "lastRead"
      ? [...filtered].sort((a, b) => {
          // Never-read chats have no timestamp — treat as the earliest
          // possible time so they trail a desc sort and lead an asc one.
          const aT = a.last_read_at ? Date.parse(a.last_read_at) : -Infinity;
          const bT = b.last_read_at ? Date.parse(b.last_read_at) : -Infinity;
          return (aT - bT) * dirMul;
        })
      : [...filtered].sort(
          (a, b) =>
            (Date.parse(a.last_activity_at) - Date.parse(b.last_activity_at)) *
            dirMul
        );

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
      {chats.length > 0 && (
        <>
          <div className="filter-row">
            <label>Status</label>
            <div className="chip-group" role="radiogroup" aria-label="Read status filter">
              {(["all", "unread", "read"] as const).map((v) => (
                <button
                  key={v}
                  className={`chip ${readFilter === v ? "active" : ""}`}
                  onClick={() => setReadFilter(v)}
                  aria-pressed={readFilter === v}
                >
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-row">
            <label>Sort</label>
            <div className="chip-group" role="radiogroup" aria-label="Sort mode">
              {([
                ["lastActivity", "Last Activity"],
                ["lastRead", "Last Read"],
                ["score", "Score"],
              ] as const).map(([v, label]) => {
                const scoreSort = v === "score";
                const isDisabled = scoreSort && !scoresReady;
                const active = sortMode === v;
                const directional = active && DIRECTIONAL_SORTS.has(v);
                return (
                  <button
                    key={v}
                    className={`chip ${active ? "active" : ""}`}
                    onClick={() => handleSort(v)}
                    aria-pressed={active}
                    disabled={isDisabled}
                    title={isDisabled ? "Loading scores…" : undefined}
                    aria-label={
                      directional
                        ? `${label}, ${
                            sortDir === "desc" ? "descending" : "ascending"
                          }`
                        : label
                    }
                  >
                    {label}
                    {directional && (
                      <span className="sort-arrow" aria-hidden="true">
                        {sortDir === "desc" ? "▼" : "▲"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
      {chats.length === 0 ? (
        <p className="empty">
          No chats yet. Tap the + button to start a Japanese conversation.
        </p>
      ) : visibleChats.length === 0 ? (
        <p className="empty">No chats match this filter.</p>
      ) : (
        <div className="chat-list">
          {visibleChats.map((chat) => (
            <div key={chat.id} className="chat-card">
              <div className="chat-card-header">
                <Link to={`/chats/${chat.id}`} className="chat-card-title">
                  {stripAnnotations(stripBold(chat.title))}
                </Link>
                <div className="chat-card-header-actions">
                  {chat.min_assistant_read_count != null &&
                    chat.min_assistant_read_count > 0 && (
                      <span
                        className="read-tag"
                        title={
                          chat.last_read_at
                            ? `Last read ${new Date(chat.last_read_at).toLocaleString()}`
                            : undefined
                        }
                      >
                        {chat.min_assistant_read_count > 1
                          ? `✓ Read ${chat.min_assistant_read_count}×`
                          : "✓ Read"}
                      </span>
                    )}
                  {(deltaById.get(chat.id) ?? 0) > 0 && (
                    <span className="score-tag" title="Score gain if marked once more">
                      +{formatScore(deltaById.get(chat.id) ?? 0)}
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
