export interface Kanji {
  character: string;
  grade: number;
  jlpt: number | null;
  meanings: string;
  readings_on: string;
  readings_kun: string;
}

export type Formality = "impolite" | "casual" | "polite" | "keigo";

export type ContentType = "fiction" | "nonfiction" | "learn_word";

/**
 * The two free-form composition types. "learn_word" generations go through
 * their own prompt builder (the target word takes the place of topic/style),
 * so the topic-and-style prompt tables are keyed on this narrower union.
 */
export type StoryContentType = Exclude<ContentType, "learn_word">;

export interface DifficultyEstimate {
  uniqueKanji: number;
  grade: { max: number; avg: number };
  jlpt: { min: number; avg: number };
}

/** One AI-generated translation of a single sentence within a story. */
export interface SentenceTranslation {
  text: string;
  model: string;
  generated_at: string;
}

/** Keyed by `${sentence_start_offset}-${sentence_end_offset}` (char offsets in the cleaned story content). */
export type StoryTranslations = Record<string, SentenceTranslation>;

export type StoryStatus = "generating" | "complete" | "failed";

/**
 * Lifecycle state for the client-orchestrated comprehensibility refinement
 * loop (see RefinementContext / the `revise-story` Edge Function).
 *   - `null`       → needs evaluation (freshly generated, or just revised)
 *   - `"refining"` → a repair pass is in flight
 *   - `"settled"`  → the loop is done (met threshold, hit the pass cap, or
 *                    stopped making progress)
 *   - `"failed"`   → a repair pass errored
 */
export type RefineState = "refining" | "settled" | "failed" | null;

/**
 * Measured word-level comprehensibility of a story, stamped when refinement
 * settles. `fraction` is the share of content tokens the reader KNOWS (0–1) —
 * seen enough times to have consolidated it (WELL_KNOWN_MIN), or as common as
 * words already at their level; a word seen only once or twice does not count. `problemCount` is the distinct
 * unseen-and-rare headwords still present; `newWords` is the distinct
 * new-to-learn headwords (unseen and not already-common) — the i+1 material the
 * pass-1 floor targets; `pass` is how many repair passes ran. Drives the
 * Compositions "≈NN% known · N new" badge.
 */
export interface Comprehensibility {
  fraction: number;
  problemCount: number;
  newWords: number;
  pass: number;
}

export interface Story {
  id: number;
  user_id?: string;
  title: string;
  content: string;
  content_type: ContentType;
  topic: string | null;
  formality: Formality;
  difficulty: DifficultyEstimate;
  translations: StoryTranslations | null;
  read_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
  status: StoryStatus;
  error_message: string | null;
  word_index_at: string | null;
  refine_pass: number;
  refine_state: RefineState;
  comprehensibility: Comprehensibility | null;
  created_at: string;
}

export interface StoryReadState {
  read_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
}

/**
 * One occurrence of a headword in one of the user's tokenized sources —
 * a read story or a read chat message. Returned by `get_word_usages` and
 * consumed by the WordPopover carousel to render every place the headword
 * appears across the user's library. `lookedUpAt` / `lookupCount` come from
 * the optional `word_lookups` join — null/0 when the user has never tapped
 * this span.
 *
 * `sourceType` discriminates which id columns are set:
 *   - `'story'` → `storyId` is set, `chatId`/`chatMessageId` are null
 *   - `'chat'`  → `chatId` + `chatMessageId` are set, `storyId` is null
 */
export type WordUsageSource = "story" | "chat";

export interface WordUsage {
  occurrenceId: number;
  sourceType: WordUsageSource;
  storyId: number | null;
  chatId: number | null;
  chatMessageId: number | null;
  sourceTitle: string;
  sourceContent: string;
  sourceCreatedAt: string;
  startOffset: number;
  endOffset: number;
  surface: string;
  reading: string | null;
  lookedUpAt: string | null;
  lookupCount: number;
}

// Chat feature: LLM conversations always answering in Japanese, with
// per-message Mark-as-Read that contributes encounters to the vocab/kanji
// score. Each assistant message goes through the same JMdict/kuromoji
// indexer as story content (via the polymorphic story_word_occurrences
// table).
export type ChatMessageRole = "user" | "assistant";
export type ChatMessageStatus = "pending" | "complete" | "failed";

export interface Chat {
  id: number;
  user_id?: string;
  title: string;
  created_at: string;
  last_activity_at: string;
  /**
   * MIN(read_count) across the chat's complete assistant messages. NULL when
   * the chat has no complete assistant messages yet. The Chats list shows
   * "✓ Read N×" exactly when this is > 0.
   */
  min_assistant_read_count: number | null;
  /**
   * MAX(last_read_at) across the chat's complete assistant messages. NULL
   * when no message has ever been marked read. Powers the "Last Read"
   * sort on the Chats list.
   */
  last_read_at: string | null;
}

export interface ChatMessage {
  id: number;
  chat_id: number;
  user_id?: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  error_message: string | null;
  read_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
  word_index_at: string | null;
  translations: StoryTranslations | null;
  created_at: string;
}

export interface ChatMessageReadState {
  read_count: number;
  first_read_at: string | null;
  last_read_at: string | null;
}

// Per-message slice returned by mark_chat_read / undo_chat_read for each
// row that actually changed. The fan-out skips messages at cap or on
// cooldown, so the array length tells the caller how many landed; the
// `message_id` list drives the same-session undo affordance.
export interface ChatMessageMarkUpdate extends ChatMessageReadState {
  message_id: number;
}

// One row from get_per_chat_payout. `kind` discriminates: `'word'` means
// `key` is a JMdict-canonical headword (sums into the vocab delta);
// `'kanji'` means `key` is a single CJK character (sums into the kanji
// delta). The client groups by chat_id then by kind to assemble the
// per-chat input maps for vocabScoreDelta / kanjiCountsDelta.
export interface PerChatPayoutRow {
  chat_id: number;
  kind: "word" | "kanji";
  key: string;
  count: number;
}

// Stories-page filter shapes are persisted on the profile so the page
// reopens with the user's most recent choices.
export type ReadFilter = "all" | "unread" | "read";

export interface GeneratorPreferences {
  model: string;
  formality: Formality;
  contentType: ContentType;
  // How many paragraphs to generate (3–10).
  paragraphs: number;
}

export interface StoriesPreferences {
  readFilter: ReadFilter;
}

export interface ChatsPreferences {
  readFilter: ReadFilter;
}

// Per-word display modes for the StoryDisplay furigana control:
// "off" never shown, "unseen" only on words encountered fewer than
// FURIGANA_UNSEEN_THRESHOLD times across the user's read sources, "all"
// on every word.
export type DisplayMode = "off" | "unseen" | "all";

// The app's single "known" bar (encounters) — the one source of truth. A word
// seen this many times counts as known everywhere it matters: it drops out of
// the "unseen" furigana mode, it feeds the vocab frontier estimate, and it
// counts toward the "% known" badge. comprehensibility's WELL_KNOWN_MIN and the
// furigana threshold below both derive from this, so they can't drift.
export const KNOWN_ENCOUNTERS = 5;

// Threshold for the "unseen" furigana mode — ruby is rendered when the word's
// read-source encounter count is strictly less than this. The same "known" bar
// as everything else.
export const FURIGANA_UNSEEN_THRESHOLD = KNOWN_ENCOUNTERS;

// Reading font: shared between Story reader and Chat thread. "serif" is the
// default Noto Serif JP body; "sans" swaps to Zen Kaku Gothic New (the UI sans).
export type FontMode = "serif" | "sans";

export interface ReaderPreferences {
  furigana: DisplayMode;
  font: FontMode;
}

export interface Preferences {
  generator?: Partial<GeneratorPreferences>;
  stories?: Partial<StoriesPreferences>;
  chats?: Partial<ChatsPreferences>;
  reader?: Partial<ReaderPreferences>;
}

export interface Profile {
  user_id: string;
  has_openrouter_api_key: boolean;
  preferences: Preferences;
  created_at: string;
}
