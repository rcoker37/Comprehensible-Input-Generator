import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { updatePreferences } from "../api/client";
import type { UnseenKanjiTarget } from "../lib/generation";
import type { ContentType, Formality } from "../types";
import AnimatedDots from "./AnimatedDots";
import Modal from "./Modal";
import "./GenerationModal.css";

const MODEL = "anthropic/claude-opus-4.7";

const UNSEEN_KANJI_OPTIONS: { value: UnseenKanjiTarget; label: string }[] = [
  { value: "none", label: "None" },
  { value: "1-2", label: "1–2" },
  { value: "3-5", label: "3–5" },
  { value: "5-10", label: "5–10" },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function GenerationModal({ open, onClose }: Props) {
  const { user, profile, refreshProfile } = useAuth();
  const { loading, generate } = useGeneration();
  const { seenKanji } = useSeenKanji();
  const [contentType, setContentType] = useState<ContentType>("fiction");
  const [paragraphs, setParagraphs] = useState(5);
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [formality, setFormality] = useState<Formality>("polite");
  const [unseenKanjiTarget, setUnseenKanjiTarget] = useState<UnseenKanjiTarget>("none");

  // Sync preferences from profile once it resolves — state initializers run
  // before the profile fetch completes, so defaults would always win otherwise.
  const profileSyncedRef = useRef(false);
  useEffect(() => {
    if (profileSyncedRef.current || !profile) return;
    profileSyncedRef.current = true;
    const gen = profile.preferences?.generator;
    if (gen?.contentType) setContentType(gen.contentType as ContentType);
    if (gen?.paragraphs) setParagraphs(gen.paragraphs);
    if (gen?.formality) setFormality(gen.formality as Formality);
    if (gen?.unknownKanjiTarget) setUnseenKanjiTarget(gen.unknownKanjiTarget as UnseenKanjiTarget);
  }, [profile]);

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
    onClose();
  };

  const hasKey = profile?.has_openrouter_api_key ?? false;
  const profileLoaded = profile != null;

  return (
    <Modal open={open} onClose={onClose}>
      <div className="generation-modal-content">
        {profileLoaded && !hasKey && (
          <div className="warning" role="alert">
            You need an OpenRouter API key to generate compositions.{" "}
            <Link to="/settings" onClick={onClose}>Add one in Settings →</Link>
          </div>
        )}

        <div className="generation-modal-fields">
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

          <div className="form-group">
            <label>
              Paragraphs
              <select value={paragraphs} onChange={(e) => setParagraphs(Number(e.target.value))}>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="form-group">
            <label>
              <span>Topic <span className="optional">(optional)</span></span>
              <input type="text" value={topic} onChange={(e) => setTopic(e.target.value)} />
            </label>
          </div>

          <div className="form-group">
            <label>
              <span>Style <span className="optional">(optional)</span></span>
              <input type="text" value={style} onChange={(e) => setStyle(e.target.value)} />
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
        </div>
      </div>
    </Modal>
  );
}
