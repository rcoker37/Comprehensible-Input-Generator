import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";
import { annotateStory, generateStoryStream } from "../api/client";
import { tokenizeForAnnotations } from "../lib/tokenizer";
import { stripBold } from "../lib/text";
import { parseAnnotatedText } from "../lib/furigana";
import type { ContentType, Formality, Story, GenerationProgress } from "../types";

interface GenerationContextType {
  loading: boolean;
  error: string | null;
  story: Story | null;
  genProgress: GenerationProgress | null;
  startedAt: number | null;
  annotating: boolean;
  generate: (userId: string, params: { contentType: ContentType; paragraphs: number; topic?: string; style?: string; formality: Formality; grammarLevel: number; model: string }) => void;
  clear: () => void;
}

const GenerationContext = createContext<GenerationContextType | null>(null);

/**
 * Fire-and-forget annotation pass. Tokenizes the freshly-saved story on the
 * client (to align with what the reader renders) and invokes annotate-story.
 * Returns the story with annotations merged, or null on failure — the caller
 * can then drop the result back into state. Errors are swallowed so a failed
 * annotation never blocks the main generation flow.
 */
async function triggerAnnotationForStory(story: Story): Promise<Story | null> {
  try {
    const { cleanText, annotations: rubyAnnotations } = parseAnnotatedText(
      stripBold(story.content)
    );
    const tokens = await tokenizeForAnnotations(cleanText, rubyAnnotations);
    const annotations = await annotateStory(story.id, cleanText, tokens);
    return { ...story, annotations };
  } catch (err) {
    console.warn("annotate-story failed:", err);
    return null;
  }
}

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
  const [annotating, setAnnotating] = useState(false);
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
    setAnnotating(false);
  }, []);

  const generate = useCallback((userId: string, params: { contentType: ContentType; paragraphs: number; topic?: string; style?: string; formality: Formality; grammarLevel: number; model: string }) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    setStory(null);
    setGenProgress(null);
    setStartedAt(Date.now());
    setAnnotating(false);

    generateStoryStream(userId, params, (progress) => setGenProgress(progress), controller.signal)
      .then((result) => {
        setGenProgress(null);
        setStory(result);
        setAnnotating(true);
        triggerAnnotationForStory(result)
          .then((annotated) => {
            if (annotated) setStory(annotated);
          })
          .finally(() => setAnnotating(false));
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

  return (
    <GenerationContext.Provider value={{ loading, error, story, genProgress, startedAt, annotating, generate, clear }}>
      {children}
    </GenerationContext.Provider>
  );
}
