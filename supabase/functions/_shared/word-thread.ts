// Shape of stories.explanations JSONB on the server side.
// Keep in sync with client/src/types/index.ts (WordThread, ChatMessage).

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  generated_at: string;
}

export interface WordThread {
  version: 1;
  messages: ChatMessage[];
}

// Per-range map keyed by thread id (a chip id from askChips.ts; "custom"
// may also appear in legacy data from before the chips-only redesign).
export type WordThreadsByThread = Record<string, WordThread>;

// Outer keyed by `${start_offset}-${end_offset}`.
export type StoredWordThreads = Record<string, WordThreadsByThread>;
