import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { generateStoryStream } from "../api/client";
import type { Formality, Story, GenerationProgress } from "../types";

interface GenerationContextType {
  loading: boolean;
  error: string | null;
  story: Story | null;
  genProgress: GenerationProgress | null;
  generate: (userId: string, params: { paragraphs: number; topic?: string; formality: Formality; grammarLevel: number; model: string }) => void;
  clear: () => void;
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
  }, []);

  const generate = useCallback((userId: string, params: { paragraphs: number; topic?: string; formality: Formality; grammarLevel: number; model: string }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setStory(null);
    setGenProgress(null);

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
      });
  }, []);

  return (
    <GenerationContext.Provider value={{ loading, error, story, genProgress, generate, clear }}>
      {children}
    </GenerationContext.Provider>
  );
}
