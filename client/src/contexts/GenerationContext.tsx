import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { generateStoryStream } from "../api/client";
import type { ContentType, Formality, Story, StoryAudio, GenerationProgress } from "../types";

interface GenerationContextType {
  loading: boolean;
  error: string | null;
  story: Story | null;
  genProgress: GenerationProgress | null;
  startedAt: number | null;
  generate: (userId: string, params: { contentType: ContentType; paragraphs: number; topic?: string; style?: string; formality: Formality; grammarLevel: number; model: string; prioritizedKanji: string[] }) => void;
  clear: () => void;
  setStoryAudio: (audio: StoryAudio) => void;
  setStoryReadAt: (read_at: string | null) => void;
}

const GenerationContext = createContext<GenerationContextType | null>(null);

export function useGeneration() {
  const ctx = useContext(GenerationContext);
  if (!ctx) throw new Error("useGeneration must be used within GenerationProvider");
  return ctx;
}

export function GenerationProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [genProgress, setGenProgress] = useState<GenerationProgress | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight generation on unmount
  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setError(null);
    setStory(null);
    setGenProgress(null);
    setStartedAt(null);
  }, []);

  const generate = useCallback((userId: string, params: { contentType: ContentType; paragraphs: number; topic?: string; style?: string; formality: Formality; grammarLevel: number; model: string; prioritizedKanji: string[] }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setStory(null);
    setGenProgress(null);
    setStartedAt(Date.now());

    generateStoryStream(userId, params, (progress) => setGenProgress(progress), controller.signal)
      .then((result) => {
        setGenProgress(null);
        setStory(result);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Generation failed");
      })
      .finally(() => {
        setLoading(false);
        setStartedAt(null);
      });
  }, []);

  const setStoryAudio = useCallback((audio: StoryAudio) => {
    setStory((s) => (s ? { ...s, audio } : s));
  }, []);

  const setStoryReadAt = useCallback((read_at: string | null) => {
    setStory((s) => (s ? { ...s, read_at } : s));
  }, []);

  return (
    <GenerationContext.Provider value={{ loading, error, story, genProgress, startedAt, generate, clear, setStoryAudio, setStoryReadAt }}>
      {children}
    </GenerationContext.Provider>
  );
}
