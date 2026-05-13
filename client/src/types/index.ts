export interface Kanji {
  character: string;
  grade: number;
  jlpt: number | null;
  meanings: string;
  readings_on: string;
  readings_kun: string;
}

export type Formality = "impolite" | "casual" | "polite" | "keigo";

export type ContentType = "fiction" | "nonfiction";

export interface DifficultyEstimate {
  uniqueKanji: number;
  grade: { max: number; avg: number };
  jlpt: { min: number; avg: number };
}

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  generated_at: string;
}

/** Per-word conversation thread. */
export interface WordThread {
  version: 1;
  messages: ChatMessage[];
}

/** Per-range map keyed by chip id from askChips.ts. Legacy "custom" entries may exist in stored data but are not surfaced. */
export type WordThreadsByThread = Record<string, WordThread>;

/** Keyed by `${start_offset}-${end_offset}` (char offsets in the story content). */
export type StoryWordThreads = Record<string, WordThreadsByThread>;

export type StoryStatus = "generating" | "complete" | "failed";

export interface Story {
  id: number;
  user_id?: string;
  title: string;
  content: string;
  content_type: ContentType;
  paragraphs: number;
  topic: string | null;
  formality: Formality;
  difficulty: DifficultyEstimate;
  explanations: StoryWordThreads | null;
  read_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
  status: StoryStatus;
  error_message: string | null;
  word_index_at: string | null;
  created_at: string;
}

export interface StoryReadState {
  read_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
}

/**
 * One occurrence of a headword in one of the user's tokenized stories. Returned
 * by `get_word_usages` and consumed by the WordPopover carousel to render every
 * place the headword appears across the user's library, with any chip threads
 * stored at that span. `lookedUpAt` / `lookupCount` come from the optional
 * `word_lookups` join — null/0 when the user has never tapped this span.
 */
export interface WordUsage {
  occurrenceId: number;
  storyId: number;
  storyTitle: string;
  storyContent: string;
  storyCreatedAt: string;
  startOffset: number;
  endOffset: number;
  surface: string;
  reading: string | null;
  threads: WordThreadsByThread;
  lookedUpAt: string | null;
  lookupCount: number;
}

// Stories-page filter shapes are persisted on the profile so the page
// reopens with the user's most recent choices.
export type ReadFilter = "all" | "unread" | "read";
export type SortMode = "newest" | "score" | "adjustedScore";
export type ParagraphFilter = number | "all";

export interface GeneratorPreferences {
  model: string;
  formality: Formality;
  paragraphs: number;
  contentType: ContentType;
  // Legacy JSON key — the UI labels this "Unseen kanji" since the meaning is
  // "kanji not in the user's allowed list".
  unknownKanjiTarget: string;
}

export interface StoriesPreferences {
  readFilter: ReadFilter;
  paragraphFilter: ParagraphFilter;
  sortMode: SortMode;
}

export interface Preferences {
  generator?: Partial<GeneratorPreferences>;
  stories?: Partial<StoriesPreferences>;
}

export interface Profile {
  user_id: string;
  display_name: string | null;
  has_openrouter_api_key: boolean;
  preferences: Preferences;
  created_at: string;
}
