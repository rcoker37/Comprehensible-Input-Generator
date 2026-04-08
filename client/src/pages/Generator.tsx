import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { supabase } from "../lib/supabase";
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

const VALID_MODELS = [
  "anthropic/claude-sonnet-4.6",
  "openai/o4-mini",
  "google/gemini-3.1-pro-preview",
];

export default function Generator() {
  const { user, profile } = useAuth();
  const { loading, error, story, genProgress, generate } = useGeneration();
  const [paragraphs, setParagraphs] = useState(profile?.preferred_paragraphs ?? 5);
  const [topic, setTopic] = useState("");
  const [formality, setFormality] = useState<Formality>((profile?.preferred_formality as Formality) ?? "polite");
  const [grammarLevel, setGrammarLevel] = useState(profile?.preferred_grammar_level ?? 2);
  const savedModel = profile?.preferred_model;
  const [model, setModel] = useState(savedModel && VALID_MODELS.includes(savedModel) ? savedModel : "openai/o4-mini");

  const handleGenerate = () => {
    if (!profile?.openrouter_api_key) return;
    generate(user!.id, {
      paragraphs,
      topic: topic.trim() || undefined,
      formality,
      grammarLevel,
      model,
    });
    supabase.from("profiles").update({
      preferred_model: model,
      preferred_formality: formality,
      preferred_grammar_level: grammarLevel,
      preferred_paragraphs: paragraphs,
    }).eq("user_id", user!.id).then(() => {});
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
          <label>Grammar Level</label>
          <div className="chip-group">
            {[5, 4, 3, 2, 1].map((n) => (
              <button
                key={n}
                className={`chip ${grammarLevel === n ? "active" : ""}`}
                onClick={() => setGrammarLevel(n)}
              >
                N{n}
              </button>
            ))}
          </div>
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

        <div className="form-group">
          <label>Model</label>
          <div className="chip-group">
            {([
              { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6", price: "$" },
              { id: "openai/o4-mini", label: "ChatGPT o4-mini", price: "$$" },
              { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", price: "$$$" },
            ] as const).map((m) => (
              <button
                key={m.id}
                className={`chip ${model === m.id ? "active" : ""}`}
                onClick={() => setModel(m.id)}
              >
                {m.label} <span className="chip-price">{m.price}</span>
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
                : <>Waiting<AnimatedDots /></>}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {genProgress?.content && (
        <div className="story-display">
          <div className="story-content">
            {genProgress.content.replace(/\*\*/g, "").split("\n").filter((l: string) => l.trim()).map((p: string, i: number) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      )}
      {story && <StoryDisplay story={story} />}
    </div>
  );
}
