// Cache for the Chats list + per-chat message stream. Mirrors the
// StoriesContext pattern: state is loaded once at AppLayout level so
// navigating between /chats and /chats/:id doesn't refetch. Polling and
// generation orchestration live in ChatGenerationContext; this just owns
// the cached data and exposes mutators.
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
import { useAuth } from "./AuthContext";
import { useWordIndexBackfill } from "./WordIndexBackfillContext";
import {
  getChats,
  getChatMessages,
  getPerChatPayout,
} from "../api/client";
import type { Chat, ChatMessage } from "../types";

export interface PerChatPayout {
  /** Headword → occurrences across messages eligible for the next mark. */
  wordCounts: Map<string, number>;
  /** Kanji → occurrences across the same eligible messages. */
  kanjiCounts: Map<string, number>;
}

interface ChatsContextType {
  chats: Chat[];
  chatsLoaded: boolean;
  /** Map of chatId → ordered messages. Lazily populated by `loadChatMessages`. */
  messagesByChat: Map<number, ChatMessage[]>;
  /**
   * Per-chat aggregated payout inputs (headword + kanji counts across
   * every assistant message currently eligible for the next mark — i.e.,
   * not at cap and not on cooldown). Drives the chat-list `+X` tag and
   * the ChatReadButton score hint via vocabScoreDelta / kanjiCountsDelta.
   * Loaded once at AppLayout mount, refreshed after mark/undo.
   */
  perChatPayout: Map<number, PerChatPayout>;
  perChatPayoutLoaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loadChatMessages: (chatId: number) => Promise<ChatMessage[]>;
  refreshPerChatPayout: () => Promise<void>;
  addChat: (chat: Chat) => void;
  removeChat: (id: number) => void;
  applyChatUpdate: (id: number, patch: Partial<Chat>) => void;
  addChatMessage: (message: ChatMessage) => void;
  applyMessageUpdate: (messageId: number, patch: Partial<ChatMessage>) => void;
}

const ChatsContext = createContext<ChatsContextType | null>(null);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useChats() {
  const ctx = useContext(ChatsContext);
  if (!ctx) throw new Error("useChats must be used within ChatsProvider");
  return ctx;
}

export function ChatsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { processing: backfillProcessing } = useWordIndexBackfill();

  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [messagesByChat, setMessagesByChat] = useState<
    Map<number, ChatMessage[]>
  >(new Map());
  const [perChatPayout, setPerChatPayout] = useState<Map<number, PerChatPayout>>(
    new Map(),
  );
  const [perChatPayoutLoaded, setPerChatPayoutLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const rows = await getChats();
      setChats(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chats");
    } finally {
      setChatsLoaded(true);
    }
  }, [user]);

  // Reshape the flat (chat_id, kind, key, count) rows into per-chat
  // headword and kanji maps. Done in one pass so the consumer never sees
  // a half-populated state.
  const refreshPerChatPayout = useCallback(async () => {
    if (!user) return;
    try {
      const rows = await getPerChatPayout();
      const next = new Map<number, PerChatPayout>();
      for (const r of rows) {
        let entry = next.get(r.chat_id);
        if (!entry) {
          entry = { wordCounts: new Map(), kanjiCounts: new Map() };
          next.set(r.chat_id, entry);
        }
        const target = r.kind === "word" ? entry.wordCounts : entry.kanjiCounts;
        target.set(r.key, r.count);
      }
      setPerChatPayout(next);
    } catch (err) {
      // Payout drives a non-critical tag; surface to console only so a
      // transient failure doesn't break the chats list.
      console.warn("Failed to refresh per-chat payout:", err);
    } finally {
      setPerChatPayoutLoaded(true);
    }
  }, [user]);

  useEffect(() => {
    if (!user) {
      setChats([]);
      setChatsLoaded(false);
      setMessagesByChat(new Map());
      setPerChatPayout(new Map());
      setPerChatPayoutLoaded(false);
      setError(null);
      return;
    }
    refresh();
    refreshPerChatPayout();
  }, [user, refresh, refreshPerChatPayout]);

  // Backfill stamps new rows into `story_word_occurrences` for chat
  // messages too. When it idles back, the per-chat payout map may be
  // stale — re-aggregate so a freshly-indexed reply shows up in the
  // chat-list `+X` tag immediately.
  const prevBackfillProcessingRef = useRef(false);
  useEffect(() => {
    if (prevBackfillProcessingRef.current && !backfillProcessing && user) {
      refreshPerChatPayout();
    }
    prevBackfillProcessingRef.current = backfillProcessing;
  }, [backfillProcessing, user, refreshPerChatPayout]);

  const loadChatMessages = useCallback(
    async (chatId: number): Promise<ChatMessage[]> => {
      const rows = await getChatMessages(chatId);
      setMessagesByChat((prev) => {
        const next = new Map(prev);
        next.set(chatId, rows);
        return next;
      });
      return rows;
    },
    []
  );

  const addChat = useCallback((chat: Chat) => {
    setChats((prev) => {
      if (prev.some((c) => c.id === chat.id)) return prev;
      // Insert sorted by last_activity_at desc.
      const next = [chat, ...prev];
      next.sort((a, b) =>
        new Date(b.last_activity_at).getTime() -
        new Date(a.last_activity_at).getTime()
      );
      return next;
    });
  }, []);

  const removeChat = useCallback((id: number) => {
    setChats((prev) => prev.filter((c) => c.id !== id));
    setMessagesByChat((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setPerChatPayout((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const applyChatUpdate = useCallback(
    (id: number, patch: Partial<Chat>) => {
      setChats((prev) => {
        const next = prev.map((c) => (c.id === id ? { ...c, ...patch } : c));
        // If `last_activity_at` changed, re-sort.
        if ("last_activity_at" in patch) {
          next.sort((a, b) =>
            new Date(b.last_activity_at).getTime() -
            new Date(a.last_activity_at).getTime()
          );
        }
        return next;
      });
    },
    []
  );

  const addChatMessage = useCallback((message: ChatMessage) => {
    setMessagesByChat((prev) => {
      const existing = prev.get(message.chat_id) ?? [];
      if (existing.some((m) => m.id === message.id)) return prev;
      const next = new Map(prev);
      next.set(message.chat_id, [...existing, message]);
      return next;
    });
  }, []);

  const applyMessageUpdate = useCallback(
    (messageId: number, patch: Partial<ChatMessage>) => {
      setMessagesByChat((prev) => {
        let touched = false;
        const next = new Map<number, ChatMessage[]>();
        for (const [chatId, msgs] of prev.entries()) {
          const idx = msgs.findIndex((m) => m.id === messageId);
          if (idx === -1) {
            next.set(chatId, msgs);
            continue;
          }
          const updated = [...msgs];
          updated[idx] = { ...msgs[idx]!, ...patch };
          next.set(chatId, updated);
          touched = true;
        }
        return touched ? next : prev;
      });
    },
    []
  );

  const value = useMemo(
    () => ({
      chats,
      chatsLoaded,
      messagesByChat,
      perChatPayout,
      perChatPayoutLoaded,
      error,
      refresh,
      loadChatMessages,
      refreshPerChatPayout,
      addChat,
      removeChat,
      applyChatUpdate,
      addChatMessage,
      applyMessageUpdate,
    }),
    [
      chats,
      chatsLoaded,
      messagesByChat,
      perChatPayout,
      perChatPayoutLoaded,
      error,
      refresh,
      loadChatMessages,
      refreshPerChatPayout,
      addChat,
      removeChat,
      applyChatUpdate,
      addChatMessage,
      applyMessageUpdate,
    ]
  );

  return (
    <ChatsContext.Provider value={value}>{children}</ChatsContext.Provider>
  );
}
