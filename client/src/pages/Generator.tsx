import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { updatePreferences, getUnderusedKanji } from "../api/client";
import type { UnseenKanjiTarget } from "../lib/generation";
import type { ContentType, Formality } from "../types";
import AnimatedDots from "../components/AnimatedDots";
import "./Generator.css";

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  const totalSec = Math.floor(elapsed / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return <>{m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`}</>;
}

const MODEL = "anthropic/claude-opus-4.7";

const UNSEEN_KANJI_OPTIONS: { value: UnseenKanjiTarget; label: string }[] = [
  { value: "none", label: "None" },
  { value: "1-2", label: "1–2" },
  { value: "3-5", label: "3–5" },
  { value: "5-10", label: "5–10" },
];

export default function Generator() {
  const { user, profile, refreshProfile } = useAuth();
  const { loading, error, startedAt, generate } = useGeneration();
  const { seenKanji } = useSeenKanji();
  const gen = profile?.preferences?.generator;
  const [contentType, setContentType] = useState<ContentType>((gen?.contentType as ContentType) ?? "fiction");
  const [paragraphs, setParagraphs] = useState(gen?.paragraphs ?? 5);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [formality, setFormality] = useState<Formality>((gen?.formality as Formality) ?? "polite");
  const [unseenKanjiTarget, setUnseenKanjiTarget] = useState<UnseenKanjiTarget>(
    (gen?.unknownKanjiTarget as UnseenKanjiTarget) ?? "none"
  );
  const [underusedKanji, setUnderusedKanji] = useState<string[]>([]);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;
    let cancelled = false;
    getUnderusedKanji(25)
      .then((kanji) => {
        if (!cancelled) setUnderusedKanji(kanji);
      })
      .catch((err) => {
        console.warn("Failed to fetch underused kanji:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleGenerate = () => {
    if (!profile?.has_openrouter_api_key) return;
    generate(user!.id, {
      contentType,
      paragraphs,
      topic: topic.trim() || undefined,
      style: style.trim() || undefined,
      formality,
      model: MODEL,
      seenKanji,
      prioritizedKanji: underusedKanji,
      unseenKanjiTarget,
    });
    updatePreferences({
      generator: {
        model: MODEL,
        contentType,
        formality,
        paragraphs,
        unknownKanjiTarget: unseenKanjiTarget,
      },
    })
      .then(() => refreshProfile())
      .catch((err) => console.warn("Failed to save preferences:", err));
  };

  const hasKey = profile?.has_openrouter_api_key ?? false;
  const profileLoaded = profile != null;

  return (
    <div className="generator">
      <h1>Generate</h1>

      {profileLoaded && !hasKey && (
        <div className="warning" role="alert">
          You need an OpenRouter API key to generate compositions.{" "}
          <Link to="/settings">Add one in Settings →</Link>
        </div>
      )}

      <div className="form-section">
        <div className="form-group">
          <label>Type</label>
          <div className="chip-group" role="radiogroup" aria-label="Content type">
            {(["fiction", "nonfiction"] as ContentType[]).map((t) => (
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
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
          <label>
            <span>Style <span className="optional">(optional)</span></span>
            <input
              type="text"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
            />
          </label>
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
          <label>Unseen kanji</label>
          <div className="chip-group" role="radiogroup" aria-label="Unseen kanji target">
            {UNSEEN_KANJI_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`chip ${unseenKanjiTarget === opt.value ? "active" : ""}`}
                onClick={() => setUnseenKanjiTarget(opt.value)}
                aria-pressed={unseenKanjiTarget === opt.value}
              >
                {opt.label}
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
            ? `Generate ${contentType.charAt(0).toUpperCase() + contentType.slice(1)}`
            : <>Generating<AnimatedDots /></>}
        </button>
        {loading && startedAt !== null && (
          <div className="generate-status">
            Elapsed: <ElapsedTimer startedAt={startedAt} />
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}
