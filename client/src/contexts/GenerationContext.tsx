import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
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

  const clear = useCallback(() => {
    setError(null);
    setStory(null);
    setGenProgress(null);
  }, []);

  const generate = useCallback((userId: string, params: { paragraphs: number; topic?: string; formality: Formality; grammarLevel: number; model: string }) => {
    setLoading(true);
    setError(null);
    setStory(null);
    setGenProgress(null);

    generateStoryStream(userId, params, (progress) => setGenProgress(progress))
      .then((result) => {
        setGenProgress(null);
        setStory(result);
      })
      .catch((err) => {
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
