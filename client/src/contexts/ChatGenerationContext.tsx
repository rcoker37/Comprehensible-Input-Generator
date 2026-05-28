// In-flight chat-message generation. Mirrors GenerationContext (the story
// version) but supports multiple concurrent assistant replies — one per
// chat — so the polling state is keyed by `messageId` rather than a single
// ref.
//
// Workflow:
//   1. UI calls `sendMessage({chatId, userText, formality})`.
//   2. We call the Edge Function; it inserts user + assistant placeholder
//      and returns their IDs.
//   3. We insert both rows into ChatsContext optimistically (with the
//      assistant placeholder in status='pending').
//   4. We start polling the assistant message; when its status flips to
//      'complete' we patch the cached row and refresh the word-index
//      backfill queue so it picks up the new message.
//   5. On 'failed' we patch the row's status + error_message and stop polling.
//
// On mount, we also resume polling for any assistant messages that were
// in flight when the tab last closed (cross-session resume).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getChatMessage,
  getPendingChatAssistantMessages,
  markChatMessageFailed,
  sendChatMessage,
} from "../api/client";
import { useAuth } from "./AuthContext";
import { useChats } from "./ChatsContext";
import { useSeenKanji } from "./KanjiContext";
import { useWordIndexBackfill } from "./WordIndexBackfillContext";
import type { ChatMessage, Formality } from "../types";

const POLL_INTERVAL_MS = 3000;
const STALE_THRESHOLD_MS = 90 * 1000;

interface SendParams {
  chatId: number | null;
  userText: string;
  formality: Formality;
}

interface SendResult {
  chatId: number;
  userMessageId: number;
  assistantMessageId: number;
  chatCreated: boolean;
}

interface ChatGenerationContextType {
  /** True when there's at least one assistant message currently pending. */
  anyPending: boolean;
  /** Per-message pending state — populated for chats with an in-flight reply. */
  pendingByChat: Map<number, number>;
  /** Map of messageId → error message for messages that flipped to 'failed' in this session. */
  errorByMessage: Map<number, string>;
  sendMessage: (params: SendParams) => Promise<SendResult>;
  dismissError: (messageId: number) => void;
}

const ChatGenerationContext = createContext<ChatGenerationContextType | null>(
  null
);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useChatGeneration() {
  const ctx = useContext(ChatGenerationContext);
  if (!ctx)
    throw new Error(
      "useChatGeneration must be used within ChatGenerationProvider"
    );
  return ctx;
}

export function ChatGenerationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { seenKanji } = useSeenKanji();
  const { addChatMessage, applyMessageUpdate, applyChatUpdate } = useChats();
  const { refresh: refreshBackfill } = useWordIndexBackfill();

  // Refs so the polling callbacks read the latest fns without rebuilding.
  const applyMessageUpdateRef = useRef(applyMessageUpdate);
  const applyChatUpdateRef = useRef(applyChatUpdate);
  const refreshBackfillRef = useRef(refreshBackfill);
  useEffect(() => {
    applyMessageUpdateRef.current = applyMessageUpdate;
    applyChatUpdateRef.current = applyChatUpdate;
    refreshBackfillRef.current = refreshBackfill;
  }, [applyMessageUpdate, applyChatUpdate, refreshBackfill]);

  // One poll token per pending message. Stopping a poll bumps the token
  // so any in-flight tick checks-and-bails.
  const pollTokensRef = useRef<Map<number, number>>(new Map());
  const pollTimersRef = useRef<Map<number, number>>(new Map());

  const [pendingByChat, setPendingByChat] = useState<Map<number, number>>(
    new Map()
  );
  const [errorByMessage, setErrorByMessage] = useState<Map<number, string>>(
    new Map()
  );

  const markPending = useCallback((messageId: number, chatId: number) => {
    setPendingByChat((prev) => {
      if (prev.get(chatId) === messageId) return prev;
      const next = new Map(prev);
      next.set(chatId, messageId);
      return next;
    });
  }, []);

  const clearPending = useCallback((messageId: number) => {
    setPendingByChat((prev) => {
      let touched = false;
      const next = new Map<number, number>();
      for (const [chatId, mid] of prev.entries()) {
        if (mid === messageId) {
          touched = true;
          continue;
        }
        next.set(chatId, mid);
      }
      return touched ? next : prev;
    });
  }, []);

  const stopPolling = useCallback((messageId: number) => {
    const tokens = pollTokensRef.current;
    tokens.set(messageId, (tokens.get(messageId) ?? 0) + 1);
    const timer = pollTimersRef.current.get(messageId);
    if (timer != null) {
      window.clearTimeout(timer);
      pollTimersRef.current.delete(messageId);
    }
  }, []);

  const startPolling = useCallback(
    (messageId: number, chatId: number, started: number) => {
      const tokens = pollTokensRef.current;
      const myToken = (tokens.get(messageId) ?? 0) + 1;
      tokens.set(messageId, myToken);

      markPending(messageId, chatId);

      const isStale = () => tokens.get(messageId) !== myToken;

      const tick = async () => {
        pollTimersRef.current.delete(messageId);
        if (isStale()) return;
        try {
          const fresh = await getChatMessage(messageId);
          if (isStale()) return;
          if (fresh.status === "complete") {
            applyMessageUpdateRef.current(messageId, {
              content: fresh.content,
              status: "complete",
              error_message: null,
            });
            applyChatUpdateRef.current(chatId, {
              last_activity_at: fresh.created_at,
            });
            clearPending(messageId);
            // Newly-complete assistant messages need indexing. The backfill
            // would pick it up on next session anyway; refreshing pulls it
            // into the queue immediately so tap-spans go live ASAP.
            refreshBackfillRef.current();
            return;
          }
          if (fresh.status === "failed") {
            applyMessageUpdateRef.current(messageId, {
              status: "failed",
              error_message: fresh.error_message,
            });
            setErrorByMessage((prev) => {
              const next = new Map(prev);
              next.set(messageId, fresh.error_message || "Generation failed");
              return next;
            });
            clearPending(messageId);
            return;
          }
          // Still pending — kill it if it's been too long, then keep polling
          // so the next tick can flip the UI to 'failed'.
          if (Date.now() - started > STALE_THRESHOLD_MS) {
            try {
              await markChatMessageFailed(messageId, "Reply timed out");
            } catch (err) {
              console.warn("markChatMessageFailed failed:", err);
            }
          }
          if (isStale()) return;
          pollTimersRef.current.set(
            messageId,
            window.setTimeout(tick, POLL_INTERVAL_MS)
          );
        } catch (err) {
          console.warn("Chat polling error:", err);
          if (isStale()) return;
          pollTimersRef.current.set(
            messageId,
            window.setTimeout(tick, POLL_INTERVAL_MS)
          );
        }
      };
      pollTimersRef.current.set(
        messageId,
        window.setTimeout(tick, POLL_INTERVAL_MS)
      );
    },
    [markPending, clearPending]
  );

  // Resume polling for any in-flight assistant messages from prior sessions.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void getPendingChatAssistantMessages()
      .then((rows) => {
        if (cancelled) return;
        for (const m of rows) {
          startPolling(m.id, m.chat_id, new Date(m.created_at).getTime());
        }
      })
      .catch((err) => console.warn("Chat hydrate failed:", err));
    return () => {
      cancelled = true;
    };
  }, [user, startPolling]);

  // Clean up timers on sign-out / unmount. Snapshot the refs at effect-run
  // time so the cleanup closes over the same Maps the polling tick uses
  // (the refs themselves are stable, but lint can't see that).
  useEffect(() => {
    const timers = pollTimersRef.current;
    const tokens = pollTokensRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
      tokens.clear();
    };
  }, []);

  const sendMessage = useCallback(
    async ({ chatId, userText, formality }: SendParams): Promise<SendResult> => {
      const res = await sendChatMessage({
        chatId,
        userText,
        seenKanji,
        formality,
      });

      // Optimistic local state: insert the user + assistant placeholder so
      // the UI shows them before the next refetch.
      const nowIso = new Date().toISOString();
      const userMessage: ChatMessage = {
        id: res.userMessageId,
        chat_id: res.chatId,
        role: "user",
        content: userText,
        status: "complete",
        error_message: null,
        read_count: 0,
        first_read_at: null,
        last_read_at: null,
        word_index_at: null,
        translations: null,
        created_at: nowIso,
      };
      addChatMessage(userMessage);
      const assistantPlaceholder: ChatMessage = {
        id: res.assistantMessageId,
        chat_id: res.chatId,
        role: "assistant",
        content: "",
        status: "pending",
        error_message: null,
        read_count: 0,
        first_read_at: null,
        last_read_at: null,
        word_index_at: null,
        translations: null,
        created_at: nowIso,
      };
      addChatMessage(assistantPlaceholder);
      applyChatUpdateRef.current(res.chatId, { last_activity_at: nowIso });

      startPolling(res.assistantMessageId, res.chatId, Date.now());
      return res;
    },
    [seenKanji, addChatMessage, startPolling]
  );

  const dismissError = useCallback(
    (messageId: number) => {
      stopPolling(messageId);
      setErrorByMessage((prev) => {
        if (!prev.has(messageId)) return prev;
        const next = new Map(prev);
        next.delete(messageId);
        return next;
      });
      clearPending(messageId);
    },
    [stopPolling, clearPending]
  );

  const anyPending = pendingByChat.size > 0;

  const value = useMemo(
    () => ({
      anyPending,
      pendingByChat,
      errorByMessage,
      sendMessage,
      dismissError,
    }),
    [anyPending, pendingByChat, errorByMessage, sendMessage, dismissError]
  );

  return (
    <ChatGenerationContext.Provider value={value}>
      {children}
    </ChatGenerationContext.Provider>
  );
}
