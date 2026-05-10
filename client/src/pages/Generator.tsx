import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { updateProfile, deleteStory, getUnderusedKanji } from "../api/client";
import { stripBold } from "../lib/text";
import { stripAnnotations } from "../lib/furigana";
import type { UnknownKanjiTarget } from "../lib/generation";
import type { ContentType, Formality } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import StoryReadButton from "../components/StoryReadButton";
import AnimatedDots from "../components/AnimatedDots";
import "../components/StoryActions.css";
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

const UNKNOWN_KANJI_OPTIONS: { value: UnknownKanjiTarget; label: string }[] = [
  { value: "none", label: "None" },
  { value: "1-2", label: "1–2" },
  { value: "3-5", label: "3–5" },
  { value: "5-10", label: "5–10" },
];

export default function Generator() {
  const { user, profile } = useAuth();
  const { loading, error, story, genProgress, startedAt, generate, clear, setStoryReadState } = useGeneration();
  const [contentType, setContentType] = useState<ContentType>((profile?.preferred_content_type as ContentType) ?? "fiction");
  const [paragraphs, setParagraphs] = useState(profile?.preferred_paragraphs ?? 5);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [formality, setFormality] = useState<Formality>((profile?.preferred_formality as Formality) ?? "polite");
  const [unknownKanjiTarget, setUnknownKanjiTarget] = useState<UnknownKanjiTarget>("none");
  const [underusedKanji, setUnderusedKanji] = useState<string[]>([]);
  const [excludedKanji, setExcludedKanji] = useState<Set<string>>(() => new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;
    let cancelled = false;
    getUnderusedKanji(10)
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
    setDeleteError(null);
    generate(user!.id, {
      contentType,
      paragraphs,
      topic: topic.trim() || undefined,
      style: style.trim() || undefined,
      formality,
      model: MODEL,
      prioritizedKanji: underusedKanji.filter((k) => !excludedKanji.has(k)),
      unknownKanjiTarget,
    });
    updateProfile(user!.id, {
      preferred_content_type: contentType,
      preferred_formality: formality,
      preferred_paragraphs: paragraphs,
    }).catch((err) => console.warn("Failed to save preferences:", err));
  };

  const handleDelete = async () => {
    if (!story) return;
    if (!window.confirm("Delete this story? This cannot be undone.")) return;
    setDeleteError(null);
    try {
      await deleteStory(story.id);
      clear();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete story");
    }
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
              placeholder="e.g., cooking, school life, travel..."
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
          <label>
            <span>Style <span className="optional">(optional)</span></span>
            <input
              type="text"
              placeholder="e.g., noir, slice of life, Haruki Murakami..."
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
          <label>Unknown kanji</label>
          <div className="chip-group" role="radiogroup" aria-label="Unknown kanji target">
            {UNKNOWN_KANJI_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                className={`chip ${unknownKanjiTarget === opt.value ? "active" : ""}`}
                onClick={() => setUnknownKanjiTarget(opt.value)}
                aria-pressed={unknownKanjiTarget === opt.value}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {underusedKanji.length > 0 && (
          <div className="form-group">
            <div className="form-group__header">
              <label>
                Low scoring kanji{" "}
                <span className="optional">
                  ({underusedKanji.length - excludedKanji.size} / {underusedKanji.length})
                </span>
              </label>
              <div className="kanji-preview-actions">
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => setExcludedKanji(new Set())}
                  disabled={excludedKanji.size === 0}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => setExcludedKanji(new Set(underusedKanji))}
                  disabled={excludedKanji.size === underusedKanji.length}
                >
                  Deselect all
                </button>
              </div>
            </div>
            <div className="kanji-preview" aria-label="Low scoring kanji — tap to toggle">
              {underusedKanji.map((k) => {
                const isExcluded = excludedKanji.has(k);
                return (
                  <button
                    type="button"
                    key={k}
                    className={`kanji-preview__char${isExcluded ? " kanji-preview__char--excluded" : ""}`}
                    onClick={() =>
                      setExcludedKanji((prev) => {
                        const next = new Set(prev);
                        if (next.has(k)) next.delete(k);
                        else next.add(k);
                        return next;
                      })
                    }
                    aria-pressed={!isExcluded}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={loading || !hasKey}
          title={!hasKey ? "Add an OpenRouter API key in Settings first" : undefined}
        >
          {!loading
            ? `Generate ${contentType.charAt(0).toUpperCase() + contentType.slice(1)}`
            : genProgress?.phase === "thinking"
              ? <>Thinking<AnimatedDots /></>
              : genProgress?.phase === "generating"
                ? <>Generating<AnimatedDots /></>
                : <>Waiting<AnimatedDots /></>}
        </button>
        {loading && startedAt !== null && (
          <div className="generate-status">
            Elapsed: <ElapsedTimer startedAt={startedAt} />
          </div>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {genProgress?.reasoning && (
        <details className="reasoning-display" open>
          <summary>Thinking</summary>
          <pre>{genProgress.reasoning}</pre>
        </details>
      )}
      {!story && genProgress?.content && (
        <div className="story-display">
          <div className="story-content">
            {stripAnnotations(stripBold(genProgress.content))
              .split("\n")
              .filter((l: string) => l.trim())
              .map((p: string, i: number) => (
                <p key={i}>{p}</p>
              ))}
          </div>
        </div>
      )}
      {story && (
        <div className="generator-story-view">
          <div className="story-actions">
            <button
              type="button"
              className="story-action-btn"
              onClick={handleDelete}
              title="Delete story"
              aria-label="Delete story"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M2.5 4h11" />
                <path d="M6 4V2.5h4V4" />
                <path d="M3.5 4l.7 9a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4" />
              </svg>
            </button>
          </div>
          {deleteError && <div className="error">{deleteError}</div>}
          <StoryDisplay story={story} />
          <StoryReadButton story={story} onChange={setStoryReadState} />
        </div>
      )}
    </div>
  );
}
