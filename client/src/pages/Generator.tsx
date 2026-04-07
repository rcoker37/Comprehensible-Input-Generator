import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { generateStoryStream } from "../api/client";
import type { Formality, Story, GenerationProgress } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import "./Generator.css";

export default function Generator() {
  const { user, profile } = useAuth();
  const [paragraphs, setParagraphs] = useState(5);
  const [topic, setTopic] = useState("");
  const [formality, setFormality] = useState<Formality>("polite");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [genProgress, setGenProgress] = useState<GenerationProgress | null>(null);

  const userId = user!.id;

  const handleGenerate = async () => {
    if (!profile?.openrouter_api_key) {
      setError("Please set your OpenRouter API key in Settings first.");
      return;
    }
    setLoading(true);
    setError(null);
    setStory(null);
    setGenProgress(null);
    try {
      const result = await generateStoryStream(
        userId,
        {
          paragraphs,
          topic: topic.trim() || undefined,
          formality,
        },
        (progress) => setGenProgress(progress)
      );
      setGenProgress(null);
      setStory(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="generator">
      <h1>Generate a Story</h1>

      <div className="form-section">
        <div className="form-row">
          <label>
            Paragraphs
            <select
              value={paragraphs}
              onChange={(e) => setParagraphs(Number(e.target.value))}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Topic <span className="optional">(optional)</span></span>
            <input
              type="text"
              placeholder="e.g., cooking, school life, travel..."
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
        </div>

        <div className="form-group">
          <label>Formality</label>
          <div className="chip-group">
            {(["impolite", "casual", "polite", "keigo"] as Formality[]).map((f) => (
              <button
                key={f}
                className={`chip ${formality === f ? "active" : ""}`}
                onClick={() => setFormality(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={loading}
        >
          {!loading
            ? "Generate Story"
            : genProgress?.phase === "thinking"
              ? "Thinking..."
              : genProgress?.phase === "checking"
                ? "Checking..."
                : "Generating..."}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {genProgress && (
        <div className="story-display">
          {genProgress.reasoning && (
            <details className="thinking-section">
              <summary>Thinking{genProgress.phase === "thinking" ? "..." : ""}</summary>
              <div className="thinking-content">{genProgress.reasoning}</div>
            </details>
          )}
          {genProgress.content && (
            <div className="story-content">
              {genProgress.content.split("\n").filter((l: string) => l.trim()).map((p: string, i: number) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
        </div>
      )}
      {story && <StoryDisplay story={story} />}
    </div>
  );
}
