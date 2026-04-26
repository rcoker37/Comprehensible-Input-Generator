export interface Kanji {
  character: string;
  grade: number;
  jlpt: number | null;
  known: boolean;
  meanings: string;
  readings_on: string;
  readings_kun: string;
}

export type Formality = "impolite" | "casual" | "polite" | "keigo";

export type ContentType = "story" | "dialogue" | "essay";

export interface StoryFilters {
  knownOnly: boolean;
  jlptLevels: number[];
  grades: number[];
}

export interface DifficultyEstimate {
  uniqueKanji: number;
  grade: { max: number; avg: number };
  jlpt: { min: number; avg: number };
}

export interface StoryAudioToken {
  s: string;
  r?: string;
}

export interface StoryAudioParagraph {
  start: number; // token index where this paragraph begins
  t: number;     // offset in ms
}

export interface StoryAudioSentence {
  start: number; // token index where this sentence begins
  t: number;     // offset in ms
}

export interface StoryAudio {
  path: string;
  duration_ms: number;
  voice: string;
  version: number;
  tokens: StoryAudioToken[];
  paragraphs: StoryAudioParagraph[];
  sentences?: StoryAudioSentence[];
}

export type ChatRole = "overview" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  generated_at: string;
}

/** Per-word conversation thread. If any element has role="overview", it is messages[0]. */
export interface WordThread {
  version: 1;
  messages: ChatMessage[];
}

/** Keyed by `${start_offset}-${end_offset}` (char offsets in the story content). */
export type StoryWordThreads = Record<string, WordThread>;

export interface Story {
  id: number;
  user_id?: string;
  title: string;
  content: string;
  content_type: ContentType;
  paragraphs: number;
  topic: string | null;
  formality: Formality;
  filters: StoryFilters;
  difficulty: DifficultyEstimate;
  audio: StoryAudio | null;
  explanations: StoryWordThreads | null;
  created_at: string;
}

export type GenerationPhase = "thinking" | "generating";

export interface GenerationProgress {
  phase: GenerationPhase;
  reasoning: string;
  content: string;
}

export interface KanjiStats {
  total: number;
  known: number;
}

export interface Profile {
  user_id: string;
  display_name: string | null;
  has_openrouter_api_key: boolean;
  preferred_model: string;
  preferred_formality: string | null;
  preferred_grammar_level: number | null;
  preferred_paragraphs: number | null;
  preferred_content_type: string | null;
  created_at: string;
}
