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
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import {
  getChats,
  getChatMessages,
} from "../api/client";
import type { Chat, ChatMessage } from "../types";

interface ChatsContextType {
  chats: Chat[];
  chatsLoaded: boolean;
  /** Map of chatId → ordered messages. Lazily populated by `loadChatMessages`. */
  messagesByChat: Map<number, ChatMessage[]>;
  error: string | null;
  refresh: () => Promise<void>;
  loadChatMessages: (chatId: number) => Promise<ChatMessage[]>;
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

  const [chats, setChats] = useState<Chat[]>([]);
  const [chatsLoaded, setChatsLoaded] = useState(false);
  const [messagesByChat, setMessagesByChat] = useState<
    Map<number, ChatMessage[]>
  >(new Map());
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

  useEffect(() => {
    if (!user) {
      setChats([]);
      setChatsLoaded(false);
      setMessagesByChat(new Map());
      setError(null);
      return;
    }
    refresh();
  }, [user, refresh]);

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
      error,
      refresh,
      loadChatMessages,
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
      error,
      refresh,
      loadChatMessages,
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
