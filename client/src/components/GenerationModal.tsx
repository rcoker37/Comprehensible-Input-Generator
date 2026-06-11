import { useState, useEffect, useMemo, useRef } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useGeneration } from "../contexts/GenerationContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import {
  DEFAULT_PARAGRAPH_COUNT,
  GENERATION_MODEL,
  LEARN_WORD_CANDIDATE_POOL,
  LEARN_WORD_MAX_ENCOUNTERS,
  PARAGRAPH_OPTIONS,
} from "../lib/generation";
import {
  lookupFrequencyByCanonicalSync,
  lookupFrequencySync,
} from "../lib/frequency";
import { renderSurfaceRuby } from "../lib/renderSurfaceRuby";
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
  const { vocabEncounters, vocabEncountersLoaded } = useVocab();
  const [contentType, setContentType] = useState<ContentType>("fiction");
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState("");
  const [formality, setFormality] = useState<Formality>("polite");
  const [paragraphs, setParagraphs] = useState<number>(DEFAULT_PARAGRAPH_COUNT);
  const [targetWord, setTargetWord] = useState<string | null>(null);

  // Learn Word candidate pool: the user's most frequent (JPDB rank ASC)
  // headwords still encountered fewer than LEARN_WORD_MAX_ENCOUNTERS times.
  // Encounter stamps are JMdict canonicals; each is resolved through the
  // by-entry index to the JPDB display variant + reading — the same surface
  // the Browse cards and popover show (a 貴方 stamp displays as あなた) —
  // and deduped on it, keeping the best rank when two canonicals share a
  // display surface. Unranked headwords are skipped — "most frequent" is
  // meaningless without a rank, and the long tail is a poor fit for a
  // dedicated lesson anyway. The sync frequency lookups are safe behind
  // vocabEncountersLoaded, which awaits loadFrequencyIndex().
  const candidates = useMemo(() => {
    if (!vocabEncountersLoaded) return [];
    const byWord = new Map<
      string,
      { word: string; reading: string | null; rank: number }
    >();
    for (const [canonical, count] of vocabEncounters) {
      if (count >= LEARN_WORD_MAX_ENCOUNTERS) continue;
      const entry = lookupFrequencyByCanonicalSync(canonical);
      const word = entry?.headword ?? canonical;
      const rank = entry?.rank ?? lookupFrequencySync(canonical, null).rank;
      if (rank === null) continue;
      const existing = byWord.get(word);
      if (!existing || rank < existing.rank) {
        byWord.set(word, { word, reading: entry?.reading ?? null, rank });
      }
    }
    return [...byWord.values()]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, LEARN_WORD_CANDIDATE_POOL);
  }, [vocabEncounters, vocabEncountersLoaded]);

  // Auto-pick a word whenever Learn Word is active and no (still-valid)
  // pick exists yet.
  useEffect(() => {
    if (contentType !== "learn_word" || candidates.length === 0) return;
    /* eslint-disable react-hooks/set-state-in-effect -- async-resolved
       candidate pool; there's no event to hang the initial pick on. */
    setTargetWord((current) =>
      current && candidates.some((c) => c.word === current)
        ? current
        : candidates[Math.floor(Math.random() * candidates.length)]!.word
    );
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [contentType, candidates]);

  const targetCandidate =
    candidates.find((c) => c.word === targetWord) ?? null;

  const rerollWord = () => {
    if (candidates.length === 0) return;
    if (candidates.length === 1) {
      setTargetWord(candidates[0]!.word);
      return;
    }
    const pool = candidates.filter((c) => c.word !== targetWord);
    setTargetWord(pool[Math.floor(Math.random() * pool.length)]!.word);
  };

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

  const handleGenerate = () => {
    if (!profile?.has_openrouter_api_key) return;
    if (isLearnWord && !targetWord) return;
    generate(user!.id, {
      contentType,
      topic: isLearnWord ? undefined : topic.trim() || undefined,
      style: isLearnWord ? undefined : style.trim() || undefined,
      targetWord: isLearnWord ? targetWord ?? undefined : undefined,
      targetWordReading: isLearnWord
        ? targetCandidate?.reading ?? undefined
        : undefined,
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
              <label>Word</label>
              {!vocabEncountersLoaded ? (
                <div className="learn-word-row learn-word-row--empty">
                  Loading your vocabulary<AnimatedDots />
                </div>
              ) : candidates.length === 0 ? (
                <div className="learn-word-row learn-word-row--empty">
                  No eligible words yet — read a story or chat first.
                </div>
              ) : (
                <div className="learn-word-row">
                  <span className="learn-word-word" lang="ja">
                    {targetCandidate
                      ? renderSurfaceRuby(
                          targetCandidate.word,
                          targetCandidate.reading
                        )
                      : targetWord}
                  </span>
                  <button
                    type="button"
                    className="learn-word-reroll"
                    onClick={rerollWord}
                    disabled={candidates.length <= 1}
                    title="Pick a different word"
                    aria-label="Pick a different word"
                  >
                    ↻
                  </button>
                </div>
              )}
              <p className="learn-word-hint">
                Picked from your {LEARN_WORD_CANDIDATE_POOL} most common words
                seen fewer than {LEARN_WORD_MAX_ENCOUNTERS} times. The lesson
                explains its meaning and usage in Japanese.
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
            disabled={loading || !hasKey || (isLearnWord && !targetWord)}
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
