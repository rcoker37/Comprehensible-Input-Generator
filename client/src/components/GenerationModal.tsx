import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import {
  DEFAULT_PARAGRAPH_COUNT,
  GENERATION_MODEL,
  PARAGRAPH_OPTIONS,
} from "../lib/generation";
import { lookupFrequencyByCanonicalSync } from "../lib/frequency";
import type { ContentType, Formality } from "../types";
import AnimatedDots from "./AnimatedDots";
import Modal from "./Modal";
import "./GenerationModal.css";

const CONTENT_TYPES: ContentType[] = ["fiction", "nonfiction", "learn_word"];

const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  fiction: "Fiction",
  nonfiction: "Nonfiction",
  learn_word: "Learn Word",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function GenerationModal({ open, onClose }: Props) {
  const { user, profile, updatePreferences } = useAuth();
  const { loading, generate } = useGeneration();
  const { seenKanji } = useSeenKanji();
  const { vocabEncountersLoaded } = useVocab();
  const [contentType, setContentType] = useState<ContentType>("fiction");
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [formality, setFormality] = useState<Formality>("polite");
  const [paragraphs, setParagraphs] = useState<number>(DEFAULT_PARAGRAPH_COUNT);
  const [targetWord, setTargetWord] = useState("");

  // Sync preferences from profile once it resolves — state initializers run
  // before the profile fetch completes, so defaults would always win otherwise.
  const profileSyncedRef = useRef(false);
  useEffect(() => {
    if (profileSyncedRef.current || !profile) return;
    profileSyncedRef.current = true;
    const gen = profile.preferences?.generator;
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sync from the
       async-resolved profile; state initializers run before the fetch lands. */
    if (gen?.contentType && CONTENT_TYPES.includes(gen.contentType as ContentType)) {
      setContentType(gen.contentType as ContentType);
    }
    if (gen?.formality) setFormality(gen.formality as Formality);
    if (typeof gen?.paragraphs === "number" &&
        (PARAGRAPH_OPTIONS as readonly number[]).includes(gen.paragraphs)) {
      setParagraphs(gen.paragraphs);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [profile]);

  const isLearnWord = contentType === "learn_word";
  const trimmedTargetWord = targetWord.trim();

  const handleGenerate = () => {
    if (!profile?.has_openrouter_api_key) return;
    if (isLearnWord && !trimmedTargetWord) return;
    // Resolve the typed word's JPDB reading so the prompt can pin the right
    // homograph. Best-effort: gated on vocabEncountersLoaded (which awaits
    // loadFrequencyIndex), and undefined when the word isn't a canonical
    // surface in the by-entry index.
    let targetWordReading: string | undefined;
    if (isLearnWord && vocabEncountersLoaded) {
      targetWordReading =
        lookupFrequencyByCanonicalSync(trimmedTargetWord)?.reading ?? undefined;
    }
    generate(user!.id, {
      contentType,
      topic: isLearnWord ? undefined : topic.trim() || undefined,
      style: isLearnWord ? undefined : style.trim() || undefined,
      targetWord: isLearnWord ? trimmedTargetWord : undefined,
      targetWordReading: isLearnWord ? targetWordReading : undefined,
      formality,
      paragraphs,
      model: GENERATION_MODEL,
      seenKanji,
    });
    updatePreferences({
      generator: {
        model: GENERATION_MODEL,
        contentType,
        formality,
        paragraphs,
      },
    }).catch((err) => console.warn("Failed to save preferences:", err));
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
              {CONTENT_TYPES.map((t) => (
                <button
                  key={t}
                  className={`chip ${contentType === t ? "active" : ""}`}
                  onClick={() => setContentType(t)}
                  aria-pressed={contentType === t}
                >
                  {CONTENT_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          {isLearnWord ? (
            <div className="form-group">
              <label>
                <span>Word</span>
                <input
                  type="text"
                  lang="ja"
                  value={targetWord}
                  onChange={(e) => setTargetWord(e.target.value)}
                  placeholder="例：勉強"
                />
              </label>
              <p className="learn-word-hint">
                Enter a Japanese word — the lesson explains its meaning and
                usage in Japanese.
              </p>
            </div>
          ) : (
            <>
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
            </>
          )}

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
            <label>
              <span>Paragraphs</span>
              <select
                value={paragraphs}
                onChange={(e) => setParagraphs(Number(e.target.value))}
              >
                {PARAGRAPH_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <button
            className="generate-btn"
            onClick={handleGenerate}
            disabled={loading || !hasKey || (isLearnWord && !trimmedTargetWord)}
            title={!hasKey ? "Add an OpenRouter API key in Settings first" : undefined}
          >
            {!loading
              ? `Generate ${CONTENT_TYPE_LABEL[contentType]}`
              : <>Generating<AnimatedDots /></>}
          </button>
        </div>
      </div>
    </Modal>
  );
}
