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

export interface Story {
  id: number;
  user_id?: string;
  title: string;
  content: string;
  paragraphs: number;
  topic: string | null;
  formality: Formality;
  filters: StoryFilters;
  difficulty: DifficultyEstimate;
  created_at: string;
  violations?: string[];
}

export interface GenerateRequest {
  paragraphs: number;
  topic?: string;
  formality: Formality;
  filters: StoryFilters;
  allowedKanji: string;
  kanjiMeta: Record<string, { grade: number; jlpt: number | null }>;
}

export interface KanjiStats {
  total: number;
  known: number;
}

export interface Profile {
  user_id: string;
  display_name: string | null;
  openrouter_api_key: string | null;
  preferred_model: string;
  created_at: string;
}
