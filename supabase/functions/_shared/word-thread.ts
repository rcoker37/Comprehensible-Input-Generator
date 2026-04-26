// Shape of stories.explanations JSONB on the server side.
// Keep in sync with client/src/types/index.ts (WordThread, ChatMessage).

export type ChatRole = "overview" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  generated_at: string;
}

export interface WordThread {
  version: 1;
  messages: ChatMessage[]; // if any element has role="overview", it is messages[0].
}

// Keyed by `${start_offset}-${end_offset}`.
export type StoredWordThreads = Record<string, WordThread>;
