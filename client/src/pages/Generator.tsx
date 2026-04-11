import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { updateProfile } from "../api/client";
import { stripBold } from "../lib/text";
import type { ContentType, Formality } from "../types";
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

const VALID_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-pro-preview",
];

export default function Generator() {
  const { user, profile } = useAuth();
  const { loading, error, story, genProgress, generate } = useGeneration();
  const [contentType, setContentType] = useState<ContentType>((profile?.preferred_content_type as ContentType) ?? "story");
  const [paragraphs, setParagraphs] = useState(profile?.preferred_paragraphs ?? 5);
  const [topic, setTopic] = useState("");
  const [formality, setFormality] = useState<Formality>((profile?.preferred_formality as Formality) ?? "polite");
  const [grammarLevel, setGrammarLevel] = useState(profile?.preferred_grammar_level ?? 2);
  const savedModel = profile?.preferred_model;
  const [model, setModel] = useState(savedModel && VALID_MODELS.includes(savedModel) ? savedModel : "anthropic/claude-sonnet-4.6");

  const handleGenerate = () => {
    if (!profile?.has_openrouter_api_key) return;
    generate(user!.id, {
      contentType,
      paragraphs,
      topic: topic.trim() || undefined,
      formality,
      grammarLevel,
      model,
    });
    updateProfile(user!.id, {
      preferred_model: model,
      preferred_content_type: contentType,
      preferred_formality: formality,
      preferred_grammar_level: grammarLevel,
      preferred_paragraphs: paragraphs,
    }).catch((err) => console.warn("Failed to save preferences:", err));
  };

  const hasKey = profile?.has_openrouter_api_key ?? false;
  const profileLoaded = profile != null;

  return (
    <div className="generator">
      <h1>Generate</h1>

      {profileLoaded && !hasKey && (
        <div className="warning" role="alert">
          You need an OpenRouter API key to generate stories.{" "}
          <Link to="/settings">Add one in Settings →</Link>
        </div>
      )}

      <div className="form-section">
        <div className="form-group">
          <label>Type</label>
          <div className="chip-group" role="radiogroup" aria-label="Content type">
            {(["story", "dialogue", "essay"] as ContentType[]).map((t) => (
              <button
                key={t}
                className={`chip ${contentType === t ? "active" : ""}`}
                onClick={() => setContentType(t)}
                aria-pressed={contentType === t}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="form-row">
          <label>
            {contentType === "dialogue" ? "Exchanges" : "Paragraphs"}
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
          <label>Grammar Level</label>
          <div className="chip-group" role="radiogroup" aria-label="Grammar level">
            {[5, 4, 3, 2, 1].map((n) => (
              <button
                key={n}
                className={`chip ${grammarLevel === n ? "active" : ""}`}
                onClick={() => setGrammarLevel(n)}
                aria-pressed={grammarLevel === n}
              >
                N{n}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Formality</label>
          <div className="chip-group" role="radiogroup" aria-label="Formality">
            {(["impolite", "casual", "polite", "keigo"] as Formality[]).map((f) => (
              <button
                key={f}
                className={`chip ${formality === f ? "active" : ""}`}
                onClick={() => setFormality(f)}
                aria-pressed={formality === f}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Model</label>
          <div className="chip-group" role="radiogroup" aria-label="Model">
            {([
              { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$" },
              { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", price: "$$" },
            ] as const).map((m) => (
              <button
                key={m.id}
                className={`chip ${model === m.id ? "active" : ""}`}
                onClick={() => setModel(m.id)}
                aria-pressed={model === m.id}
              >
                {m.label} <span className="chip-price">{m.price}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={loading || !hasKey}
          title={!hasKey ? "Add an OpenRouter API key in Settings first" : undefined}
        >
          {!loading
            ? "Generate Story"
            : genProgress?.phase === "thinking"
              ? <>Thinking<AnimatedDots /></>
              : genProgress?.phase === "generating"
                ? <>Generating<AnimatedDots /></>
                : <>Waiting<AnimatedDots /></>}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {genProgress?.content && (
        <div className="story-display">
          <div className="story-content">
            {stripBold(genProgress.content).split("\n").filter((l: string) => l.trim()).map((p: string, i: number) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      )}
      {story && <StoryDisplay story={story} />}
    </div>
  );
}
