import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import type { Formality } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import "./Generator.css";

function AnimatedDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setCount((c) => (c % 3) + 1), 400);
    return () => clearInterval(id);
  }, []);
  return <span className="animated-dots">
    {".".repeat(count)}<span style={{ visibility: "hidden" }}>{".".repeat(3 - count)}</span>
  </span>;
}

export default function Generator() {
  const { user, profile } = useAuth();
  const { loading, error, story, genProgress, generate } = useGeneration();
  const [paragraphs, setParagraphs] = useState(5);
  const [topic, setTopic] = useState("");
  const [formality, setFormality] = useState<Formality>("polite");

  const handleGenerate = () => {
    if (!profile?.openrouter_api_key) return;
    generate(user!.id, {
      paragraphs,
      topic: topic.trim() || undefined,
      formality,
    });
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
              ? <>Thinking<AnimatedDots /></>
              : genProgress?.phase === "generating"
                ? <>Generating<AnimatedDots /></>
                : genProgress?.phase === "checking"
                  ? <>Checking<AnimatedDots /></>
                  : <>Waiting<AnimatedDots /></>}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {genProgress?.content && (
        <div className={`story-display${genProgress.phase === "checking" ? " checking-glow" : ""}`}>
          <div className="story-content">
            {genProgress.content.split("\n").filter((l: string) => l.trim()).map((p: string, i: number) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      )}
      {story && <StoryDisplay story={story} />}
    </div>
  );
}
