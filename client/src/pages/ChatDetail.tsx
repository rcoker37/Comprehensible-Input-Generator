import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  deleteChat,
  getChat,
  resetChatWordIndex,
} from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import { useChats } from "../contexts/ChatsContext";
import { useChatGeneration } from "../contexts/ChatGenerationContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { stripAnnotations } from "../lib/furigana";
import { stripBold } from "../lib/text";
import { kanjiCountsDelta } from "../lib/rarity";
import { vocabScoreDelta } from "../lib/vocabScore";
import AnimatedDots from "../components/AnimatedDots";
import ChatAssistantMessage from "../components/ChatAssistantMessage";
import ChatReadButton from "../components/ChatReadButton";
import ChatUserBubble from "../components/ChatUserBubble";
import ChatComposer from "../components/ChatComposer";
import ReaderControls from "../components/ReaderControls";
import WordsToLearnButton from "../components/WordsToLearnButton";
import type {
  ChatMessage,
  ChatMessageMarkUpdate,
  DisplayMode,
  Formality,
  FontMode,
  HighlightMode,
} from "../types";
import "./ChatDetail.css";

const DISPLAY_ORDER: DisplayMode[] = ["off", "unseen", "all"];
const HIGHLIGHT_ORDER: HighlightMode[] = [
  "off",
  "frequency",
  "encounters",
  "fiveplus",
];
const FONT_ORDER: FontMode[] = ["sans", "serif"];

const cycle = <T,>(order: T[], current: T): T =>
  order[(order.indexOf(current) + 1) % order.length]!;

const coerceHighlightMode = (raw: unknown): HighlightMode | null => {
  if (
    raw === "off" ||
    raw === "frequency" ||
    raw === "encounters" ||
    raw === "fiveplus"
  )
    return raw;
  if (raw === "all") return "frequency";
  if (raw === "unseen") return "encounters";
  return null;
};

export default function ChatDetail() {
  const { id: rawId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { profile, updatePreferences } = useAuth();
  const {
    chats,
    messagesByChat,
    loadChatMessages,
    removeChat,
    applyMessageUpdate,
    applyChatUpdate,
    perChatPayout,
    perChatPayoutLoaded,
    refreshPerChatPayout,
  } = useChats();
  const { sendMessage, pendingByChat, errorByMessage, dismissError } =
    useChatGeneration();
  const { refresh: refreshBackfill } = useWordIndexBackfill();
  const {
    kanjiExposures,
    kanjiExposuresLoaded,
    prepareKanjiRefresh,
  } = useSeenKanji();
  const {
    vocabEncounters,
    vocabEncountersLoaded,
    getWordRank,
    prepareVocabRefresh,
  } = useVocab();

  const isNew = rawId === "new";
  const chatId = isNew ? null : Number(rawId);

  const [loadingMessages, setLoadingMessages] = useState(!isNew);
  const [error, setError] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
  // Locally-held text of a message the user just submitted but whose
  // sendChatMessage round-trip hasn't returned yet — rendered as a
  // ChatUserBubble appended to the stream so the bubble appears the moment
  // the user hits send rather than after the Edge Function responds.
  const [sendingText, setSendingText] = useState<string | null>(null);

  const [furiganaMode, setFuriganaMode] = useState<DisplayMode>("unseen");
  const [highlightMode, setHighlightMode] = useState<HighlightMode>("encounters");
  const [font, setFont] = useState<FontMode>("sans");

  // Hydrate reader prefs once.
  const readerSyncedRef = useRef(false);
  useEffect(() => {
    if (readerSyncedRef.current || !profile) return;
    readerSyncedRef.current = true;
    const reader = profile.preferences?.reader;
    if (reader?.furigana) setFuriganaMode(reader.furigana);
    const migrated = coerceHighlightMode(reader?.highlight);
    if (migrated) setHighlightMode(migrated);
    if (reader?.font) setFont(reader.font);
  }, [profile]);

  const persistReader = useCallback(
    (next: { furigana: DisplayMode; highlight: HighlightMode; font: FontMode }) => {
      updatePreferences({ reader: next }).catch((err) =>
        console.warn("Failed to save reader preferences:", err)
      );
    },
    [updatePreferences]
  );

  const cycleFurigana = () => {
    setFuriganaMode((prev) => {
      const next = cycle(DISPLAY_ORDER, prev);
      persistReader({ furigana: next, highlight: highlightMode, font });
      return next;
    });
  };
  const cycleHighlight = () => {
    setHighlightMode((prev) => {
      const next = cycle(HIGHLIGHT_ORDER, prev);
      persistReader({ furigana: furiganaMode, highlight: next, font });
      return next;
    });
  };
  const cycleFont = () => {
    setFont((prev) => {
      const next = cycle(FONT_ORDER, prev);
      persistReader({ furigana: furiganaMode, highlight: highlightMode, font: next });
      return next;
    });
  };

  // Load chat + messages.
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  useEffect(() => {
    if (chatId == null) {
      setChatTitle("New chat");
      setLoadingMessages(false);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    Promise.all([getChat(chatId), loadChatMessages(chatId)])
      .then(([chat]) => {
        if (cancelled) return;
        setChatTitle(chat.title);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load chat");
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, loadChatMessages]);

  // Track chat title updates that flow in via ChatsContext (e.g. on
  // first-message creation we navigated to /chats/:id and chats list
  // already has the new chat).
  useEffect(() => {
    if (chatId == null) return;
    const cached = chats.find((c) => c.id === chatId);
    if (cached) setChatTitle(cached.title);
  }, [chats, chatId]);

  const messages: ChatMessage[] = useMemo(
    () => (chatId != null ? messagesByChat.get(chatId) ?? [] : []),
    [chatId, messagesByChat]
  );

  const isPending = chatId != null && pendingByChat.has(chatId);

  const handleSend = async (text: string) => {
    setSendingText(text);
    try {
      const formality: Formality =
        profile?.preferences?.generator?.formality ?? "polite";
      const res = await sendMessage({
        chatId,
        userText: text,
        formality,
      });
      setSendingText(null);
      if (chatId == null) {
        // Replace URL with the new chat id so a refresh resumes here.
        navigate(`/chats/${res.chatId}`, { replace: true });
      }
    } catch (err) {
      setSendingText(null);
      setError(err instanceof Error ? err.message : "Failed to send message");
    }
  };

  const handleDelete = async () => {
    if (chatId == null) {
      navigate("/chats");
      return;
    }
    if (!window.confirm("Delete this chat? This cannot be undone.")) return;
    try {
      await deleteChat(chatId);
      removeChat(chatId);
      navigate("/chats");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete chat");
    }
  };

  const handleResetIndex = async () => {
    if (chatId == null || resetPending) return;
    setResetPending(true);
    try {
      await resetChatWordIndex(chatId);
      refreshBackfill();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset word index");
    } finally {
      setResetPending(false);
    }
  };

  // Re-render to drop the pending state when a generation fails — surface
  // the error briefly, then clear the toast on dismiss.
  const pendingErrorMessage = useMemo(() => {
    for (const [mid, err] of errorByMessage.entries()) {
      const m = messages.find((x) => x.id === mid);
      if (m?.chat_id === chatId) return { mid, err };
    }
    return null;
  }, [errorByMessage, messages, chatId]);

  // Batched read-state update handler used by ChatReadButton (mark and
  // undo both return an array of per-message updates). Patches each
  // cached message, then recomputes the chat's MIN(read_count) once so
  // the chats-list "✓ Read N×" tag reflects the new state without a
  // round trip.
  const handleReadBatch = useCallback(
    (updates: ChatMessageMarkUpdate[]) => {
      if (updates.length === 0) return;
      const byId = new Map(updates.map((u) => [u.message_id, u]));
      for (const u of updates) {
        applyMessageUpdate(u.message_id, {
          read_count: u.read_count,
          first_read_at: u.first_read_at,
          last_read_at: u.last_read_at,
        });
      }
      if (chatId != null) {
        const updatedMessages = messages.map((m) => {
          const u = byId.get(m.id);
          return u ? { ...m, read_count: u.read_count } : m;
        });
        const completeAssistant = updatedMessages.filter(
          (m) => m.role === "assistant" && m.status === "complete"
        );
        const minCount =
          completeAssistant.length === 0
            ? null
            : completeAssistant.reduce(
                (acc, m) => Math.min(acc, m.read_count),
                Number.POSITIVE_INFINITY
              );
        applyChatUpdate(chatId, {
          min_assistant_read_count:
            minCount === null || minCount === Number.POSITIVE_INFINITY
              ? null
              : minCount,
        });
      }
    },
    [applyChatUpdate, applyMessageUpdate, chatId, messages]
  );

  // Refresh the header score (kanji + vocab in one tick) and the per-
  // chat payout cache after the chat-level mark or undo lands.
  const refreshScoreAndPayout = useCallback(async () => {
    const [commitKanji, commitVocab] = await Promise.all([
      prepareKanjiRefresh(),
      prepareVocabRefresh(),
    ]);
    commitKanji();
    commitVocab();
    refreshPerChatPayout();
  }, [prepareKanjiRefresh, prepareVocabRefresh, refreshPerChatPayout]);

  // Score gain the next chat-level mark would award. Same shape as the
  // chats-list `+X` calc — feeds ChatReadButton's title hint and lock
  // logic (zero = nothing to mark right now).
  const chatPayoutDelta = useMemo(() => {
    if (chatId == null) return 0;
    if (!perChatPayoutLoaded || !kanjiExposuresLoaded || !vocabEncountersLoaded) {
      return 0;
    }
    const payout = perChatPayout.get(chatId);
    if (!payout) return 0;
    const kanji = kanjiCountsDelta(payout.kanjiCounts, kanjiExposures);
    const vocab = vocabScoreDelta(payout.wordCounts, vocabEncounters, getWordRank);
    return kanji + vocab;
  }, [
    chatId,
    perChatPayout,
    perChatPayoutLoaded,
    kanjiExposures,
    kanjiExposuresLoaded,
    vocabEncounters,
    vocabEncountersLoaded,
    getWordRank,
  ]);

  const payoutInputsLoaded =
    perChatPayoutLoaded && kanjiExposuresLoaded && vocabEncountersLoaded;

  const activeChat = useMemo(
    () => (chatId != null ? chats.find((c) => c.id === chatId) ?? null : null),
    [chats, chatId]
  );

  if (loadingMessages && messages.length === 0) {
    return (
      <div className="loading">
        Loading chat
        <AnimatedDots />
      </div>
    );
  }

  return (
    <div className="chat-detail">
      <header className="chat-detail-header">
        <button
          type="button"
          className="chat-detail-back"
          onClick={() => navigate("/chats")}
          aria-label="Back to chats"
        >
          ‹
        </button>
        <div className="chat-detail-title-block">
          <div className="chat-detail-title">
            {chatTitle
              ? stripAnnotations(stripBold(chatTitle))
              : isNew
                ? "New chat"
                : ""}
          </div>
          <div className="chat-detail-meta">
            {chatId != null && (
              <>
                {messages.length}{" "}
                {messages.length === 1 ? "message" : "messages"}
              </>
            )}
          </div>
        </div>
        <div className="chat-detail-actions">
          {chatId != null && (
            <>
              <button
                type="button"
                className="chat-detail-icon-btn"
                onClick={handleResetIndex}
                disabled={resetPending}
                title="Reset word index for this chat"
                aria-label="Reset word index"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M13.5 3.5v3.2h-3.2" />
                  <path d="M2.6 8a5.4 5.4 0 0 1 9.8-2.6l1.1 1.3" />
                  <path d="M2.5 12.5v-3.2h3.2" />
                  <path d="M13.4 8a5.4 5.4 0 0 1-9.8 2.6L2.5 9.3" />
                </svg>
              </button>
              <button
                type="button"
                className="chat-detail-icon-btn"
                onClick={handleDelete}
                title="Delete chat"
                aria-label="Delete chat"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 4h10M6.5 4V2.8a.8.8 0 01.8-.8h1.4a.8.8 0 01.8.8V4M4.4 4l.6 8.4a1 1 0 001 .9h4a1 1 0 001-.9L11.6 4M6.8 6.8v4.4M9.2 6.8v4.4" />
                </svg>
              </button>
            </>
          )}
        </div>
      </header>

      <div className="chat-detail-controls">
        <ReaderControls
          furigana={furiganaMode}
          highlight={highlightMode}
          font={font}
          onFuriganaCycle={cycleFurigana}
          onHighlightCycle={cycleHighlight}
          onFontCycle={cycleFont}
        />
      </div>

      {error && <div className="error">{error}</div>}
      {pendingErrorMessage && (
        <div className="error chat-detail-toast">
          {pendingErrorMessage.err}
          <button
            type="button"
            className="chat-detail-toast-dismiss"
            onClick={() => dismissError(pendingErrorMessage.mid)}
          >
            ×
          </button>
        </div>
      )}

      <div className="chat-detail-stream">
        {messages.length === 0 && isNew && sendingText == null && (
          <div className="empty chat-detail-empty">
            Ask anything in English or Japanese — replies always come back in
            Japanese.
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <ChatUserBubble key={m.id} text={m.content} />
          ) : (
            <ChatAssistantMessage
              key={m.id}
              message={m}
              furiganaMode={furiganaMode}
              highlightMode={highlightMode}
              font={font}
            />
          )
        )}
        {sendingText != null && <ChatUserBubble text={sendingText} />}
        {activeChat && messages.some((m) => m.role === "assistant" && m.status === "complete") && (
          <div className="chat-detail-actions-row">
            <ChatReadButton
              chat={activeChat}
              payoutDelta={chatPayoutDelta}
              payoutLoaded={payoutInputsLoaded}
              onBatchUpdate={handleReadBatch}
              onAfterChange={refreshScoreAndPayout}
            />
            <WordsToLearnButton
              source={{
                kind: "chat",
                messageIds: messages
                  .filter(
                    (m) => m.role === "assistant" && m.status === "complete"
                  )
                  .map((m) => m.id),
              }}
            />
          </div>
        )}
      </div>

      <ChatComposer
        disabled={isPending || sendingText != null}
        onSend={handleSend}
      />
    </div>
  );
}
