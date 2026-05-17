// Manual override editor for a span of story text. Entered from the
// WordPopover's "Override" button. The user is given a region (initially
// the popover's matched span) which they can extend / shrink at either
// edge and split at any character boundary; each resulting sub-span gets
// a candidate-picker over every JMdict entry that could match it
// (homophones + deinflections). On save, every algorithm row whose span
// intersects the region is replaced by the chosen manual rows.
import { useCallback, useEffect, useMemo, useState } from "react";
import { listSpanCandidates, type SpanCandidate } from "../lib/lookupAtCursor";
import type { FuriganaAnnotation } from "../lib/furigana";
import type { WordOverride } from "../api/client";
import AnimatedDots from "./AnimatedDots";
import "./StoryOverrideEditor.css";

interface Props {
  cleanText: string;
  annotations: FuriganaAnnotation[];
  initialStart: number;
  initialEnd: number;
  onSave: (overrides: WordOverride[]) => void | Promise<void>;
  onCancel: () => void;
}

interface Subspan {
  start: number;
  end: number;
  surface: string;
}

interface CandidatesState {
  loading: boolean;
  candidates: SpanCandidate[];
  mode: "dictionary" | "name";
  // Candidate index when mode='dictionary'; null = no candidate picked yet.
  selected: number | null;
  // When true, no manual row is written for this sub-span — the algorithm
  // fills it in. `selected` / `mode` are preserved underneath so the user can
  // toggle skip back off ("Restore") without losing their choice.
  skipped: boolean;
  // User-typed reading when mode='name'. Pre-filled from any ruby annotation
  // that exactly covers the sub-span so kanji names like 田中《たなか》 don't
  // require re-typing the reading.
  nameReading: string;
}

function subspanKey(start: number, end: number): string {
  return `${start}-${end}`;
}

// Pre-fill the name reading from any ruby annotation that exactly covers
// the sub-span. Covers the common case where the LLM annotated a name
// (田中《たなか》) but the indexer regrouped it incorrectly — the reading
// is already in the annotations, so the user doesn't have to retype it.
function initialNameReading(
  annotations: FuriganaAnnotation[],
  start: number,
  end: number,
  surface: string
): string {
  const exact = annotations.find((a) => a.start === start && a.end === end);
  if (exact) return exact.reading;
  // All-kana surface: the surface is the reading.
  if (!/[一-鿿]/.test(surface)) return surface;
  return "";
}

function deriveSubspans(
  cleanText: string,
  regionStart: number,
  regionEnd: number,
  splits: Set<number>
): Subspan[] {
  const sorted = [...splits]
    .filter((s) => s > regionStart && s < regionEnd)
    .sort((a, b) => a - b);
  const out: Subspan[] = [];
  let prev = regionStart;
  for (const s of sorted) {
    out.push({ start: prev, end: s, surface: cleanText.slice(prev, s) });
    prev = s;
  }
  out.push({
    start: prev,
    end: regionEnd,
    surface: cleanText.slice(prev, regionEnd),
  });
  return out;
}

function isWhitespace(ch: string | undefined): boolean {
  return !ch || /\s/.test(ch);
}

export default function StoryOverrideEditor({
  cleanText,
  annotations,
  initialStart,
  initialEnd,
  onSave,
  onCancel,
}: Props) {
  const [regionStart, setRegionStart] = useState(initialStart);
  const [regionEnd, setRegionEnd] = useState(initialEnd);
  const [splits, setSplits] = useState<Set<number>>(() => new Set());
  const [candidatesBySpan, setCandidatesBySpan] = useState<
    Map<string, CandidatesState>
  >(() => new Map());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const subspans = useMemo(
    () => deriveSubspans(cleanText, regionStart, regionEnd, splits),
    [cleanText, regionStart, regionEnd, splits]
  );

  // Load candidates for any sub-span we haven't seen yet. Default-select the
  // first candidate (the algorithm's preference). Stale sub-spans (no longer
  // in `subspans`) are pruned to keep the map size bounded across edits.
  useEffect(() => {
    const liveKeys = new Set(subspans.map((s) => subspanKey(s.start, s.end)));
    setCandidatesBySpan((prev) => {
      let changed = false;
      const next = new Map<string, CandidatesState>();
      for (const [k, v] of prev) {
        if (liveKeys.has(k)) next.set(k, v);
        else changed = true;
      }
      if (changed) return next;
      return prev;
    });
    let cancelled = false;
    for (const s of subspans) {
      const key = subspanKey(s.start, s.end);
      setCandidatesBySpan((prev) => {
        if (prev.has(key)) return prev;
        const next = new Map(prev);
        next.set(key, {
          loading: true,
          candidates: [],
          mode: "dictionary",
          selected: null,
          skipped: false,
          nameReading: initialNameReading(annotations, s.start, s.end, s.surface),
        });
        return next;
      });
      void listSpanCandidates(cleanText, s.start, s.end, annotations).then(
        (cands) => {
          if (cancelled) return;
          setCandidatesBySpan((prev) => {
            const cur = prev.get(key);
            if (!cur || !cur.loading) return prev;
            const next = new Map(prev);
            next.set(key, {
              ...cur,
              loading: false,
              candidates: cands,
              selected: cands.length > 0 ? 0 : null,
            });
            return next;
          });
        }
      );
    }
    return () => {
      cancelled = true;
    };
  }, [subspans, cleanText, annotations]);

  const toggleSplit = (pos: number) => {
    setSplits((prev) => {
      const next = new Set(prev);
      if (next.has(pos)) next.delete(pos);
      else next.add(pos);
      return next;
    });
  };

  const extendLeft = useCallback(() => {
    setRegionStart((s) => {
      let next = s - 1;
      while (next >= 0 && isWhitespace(cleanText[next])) next--;
      return Math.max(0, next);
    });
  }, [cleanText]);

  const extendRight = useCallback(() => {
    setRegionEnd((e) => {
      let next = e + 1;
      while (next <= cleanText.length && isWhitespace(cleanText[next - 1]))
        next++;
      return Math.min(cleanText.length, next);
    });
  }, [cleanText]);

  const shrinkLeft = useCallback(() => {
    setRegionStart((s) => {
      if (s + 1 >= regionEnd) return s;
      return s + 1;
    });
  }, [regionEnd]);

  const shrinkRight = useCallback(() => {
    setRegionEnd((e) => {
      if (e - 1 <= regionStart) return e;
      return e - 1;
    });
  }, [regionStart]);

  const canExtendLeft = regionStart > 0;
  const canExtendRight = regionEnd < cleanText.length;
  const canShrinkLeft = regionEnd - regionStart > 1;
  const canShrinkRight = regionEnd - regionStart > 1;

  const handleSelect = (subspan: Subspan, index: number) => {
    const key = subspanKey(subspan.start, subspan.end);
    setCandidatesBySpan((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, {
        ...cur,
        mode: "dictionary",
        selected: index,
        skipped: false,
      });
      return next;
    });
  };

  // Skip is a toggle: it sets `skipped` but preserves the underlying
  // `selected` / `mode`, so the user can press "Restore" to undo an
  // accidental skip without re-picking the candidate.
  const handleSkip = (subspan: Subspan) => {
    const key = subspanKey(subspan.start, subspan.end);
    setCandidatesBySpan((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, skipped: true });
      return next;
    });
  };

  const handleRestore = (subspan: Subspan) => {
    const key = subspanKey(subspan.start, subspan.end);
    setCandidatesBySpan((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, skipped: false });
      return next;
    });
  };

  const handleEnterNameMode = (subspan: Subspan) => {
    const key = subspanKey(subspan.start, subspan.end);
    setCandidatesBySpan((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, mode: "name" });
      return next;
    });
  };

  const handleNameReadingChange = (subspan: Subspan, reading: string) => {
    const key = subspanKey(subspan.start, subspan.end);
    setCandidatesBySpan((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, nameReading: reading });
      return next;
    });
  };

  const anyLoading = subspans.some(
    (s) => candidatesBySpan.get(subspanKey(s.start, s.end))?.loading
  );
  // Name mode always counts as "selected" (the row is saved with the user's
  // reading, even when empty — kanji-only names with an unknown reading still
  // benefit from being marked so the popover stops trying to look them up).
  const anySelected = subspans.some((s) => {
    const st = candidatesBySpan.get(subspanKey(s.start, s.end));
    return (
      !!st && !st.skipped && (st.mode === "name" || st.selected !== null)
    );
  });
  const canSave = !saving && !anyLoading && anySelected;

  const handleSave = async () => {
    setSaveError(null);
    const overrides: WordOverride[] = [];
    for (const s of subspans) {
      const state = candidatesBySpan.get(subspanKey(s.start, s.end));
      if (!state) continue;
      if (state.skipped) continue;
      if (state.mode === "name") {
        overrides.push({
          start: s.start,
          end: s.end,
          surface: s.surface,
          headword: s.surface,
          reading: state.nameReading,
          entryId: null,
          isName: true,
        });
        continue;
      }
      if (state.selected === null) continue;
      const cand = state.candidates[state.selected];
      if (!cand) continue;
      overrides.push({
        start: s.start,
        end: s.end,
        surface: s.surface,
        headword: cand.headword,
        reading: cand.reading ?? "",
        entryId: cand.entryId,
        isName: false,
      });
    }
    setSaving(true);
    try {
      await onSave(overrides);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="story-override">
      <div className="story-override__header">
        <span className="story-override__title">Override word boundaries</span>
        <span className="story-override__hint">
          Extend or shrink the region, add splits between characters, then
          pick a dictionary entry for each part.
        </span>
      </div>

      <div className="story-override__region-row">
        <button
          type="button"
          className="story-override__edge-btn"
          onClick={extendLeft}
          disabled={!canExtendLeft || saving}
          title="Extend region left"
        >
          ←
        </button>
        <button
          type="button"
          className="story-override__edge-btn story-override__edge-btn--shrink"
          onClick={shrinkLeft}
          disabled={!canShrinkLeft || saving}
          title="Shrink region from the left"
        >
          →
        </button>

        <div className="story-override__region">
          {Array.from({ length: regionEnd - regionStart }).map((_, i) => {
            const charOffset = regionStart + i;
            const ch = cleanText[charOffset] ?? "";
            const showGutterAfter = i < regionEnd - regionStart - 1;
            const gutterPos = charOffset + 1;
            const splitActive = splits.has(gutterPos);
            return (
              <span key={charOffset} className="story-override__region-cell">
                <span className="story-override__region-char">
                  {ch === "\n" ? "⏎" : ch}
                </span>
                {showGutterAfter && (
                  <button
                    type="button"
                    className={`story-override__split-btn${
                      splitActive ? " is-active" : ""
                    }`}
                    onClick={() => toggleSplit(gutterPos)}
                    disabled={saving}
                    title={splitActive ? "Remove split" : "Add split here"}
                    aria-pressed={splitActive}
                  >
                    {splitActive ? "│" : "·"}
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <button
          type="button"
          className="story-override__edge-btn story-override__edge-btn--shrink"
          onClick={shrinkRight}
          disabled={!canShrinkRight || saving}
          title="Shrink region from the right"
        >
          ←
        </button>
        <button
          type="button"
          className="story-override__edge-btn"
          onClick={extendRight}
          disabled={!canExtendRight || saving}
          title="Extend region right"
        >
          →
        </button>
      </div>

      <div className="story-override__subspans">
        {subspans.map((s) => {
          const key = subspanKey(s.start, s.end);
          const state = candidatesBySpan.get(key);
          return (
            <SubspanPanel
              key={key}
              subspan={s}
              state={state}
              onSelect={(idx) => handleSelect(s, idx)}
              onSkip={() => handleSkip(s)}
              onRestore={() => handleRestore(s)}
              onEnterNameMode={() => handleEnterNameMode(s)}
              onNameReadingChange={(r) => handleNameReadingChange(s, r)}
              disabled={saving}
            />
          );
        })}
      </div>

      {saveError && (
        <div className="story-override__error">{saveError}</div>
      )}

      <div className="story-override__actions">
        <button
          type="button"
          className="story-override__cancel"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
        <button
          type="button"
          className="story-override__save"
          onClick={handleSave}
          disabled={!canSave}
        >
          {saving ? "Saving…" : "Save overrides"}
        </button>
      </div>
    </div>
  );
}

interface SubspanPanelProps {
  subspan: Subspan;
  state: CandidatesState | undefined;
  onSelect: (index: number) => void;
  onSkip: () => void;
  onRestore: () => void;
  onEnterNameMode: () => void;
  onNameReadingChange: (reading: string) => void;
  disabled: boolean;
}

function SubspanPanel({
  subspan,
  state,
  onSelect,
  onSkip,
  onRestore,
  onEnterNameMode,
  onNameReadingChange,
  disabled,
}: SubspanPanelProps) {
  const [expanded, setExpanded] = useState(false);

  if (!state || state.loading) {
    return (
      <div className="story-override__subspan">
        <div className="story-override__subspan-surface">{subspan.surface}</div>
        <div className="story-override__subspan-loading">
          Looking up<AnimatedDots />
        </div>
      </div>
    );
  }

  const skipped = state.skipped;
  const isNameMode = state.mode === "name";
  const selected =
    !isNameMode && state.selected !== null
      ? state.candidates[state.selected]
      : null;
  const hasCandidates = state.candidates.length > 0;

  return (
    <div
      className={`story-override__subspan${
        skipped ? " is-skipped" : ""
      }`}
    >
      <div className="story-override__subspan-surface">{subspan.surface}</div>
      {skipped ? (
        <div className="story-override__subspan-skipped">
          Skipped — the algorithm will index this part.
        </div>
      ) : isNameMode ? (
        <div className="story-override__subspan-selected">
          <div className="story-override__subspan-headword">
            {state.nameReading && state.nameReading !== subspan.surface ? (
              <ruby>
                {subspan.surface}
                <rt>{state.nameReading}</rt>
              </ruby>
            ) : (
              subspan.surface
            )}
            <span className="story-override__subspan-name-tag">name</span>
          </div>
          <label className="story-override__subspan-name-row">
            <span className="story-override__subspan-name-label">Reading</span>
            <input
              type="text"
              className="story-override__subspan-name-input"
              value={state.nameReading}
              onChange={(e) => onNameReadingChange(e.target.value)}
              placeholder="e.g. たなか"
              disabled={disabled}
              autoFocus
            />
          </label>
        </div>
      ) : selected ? (
        <div className="story-override__subspan-selected">
          <div className="story-override__subspan-headword">
            {selected.reading && selected.reading !== selected.headword ? (
              <ruby>
                {selected.headword}
                <rt>{selected.reading}</rt>
              </ruby>
            ) : (
              selected.headword
            )}
            {selected.deinflected && (
              <span className="story-override__subspan-deinflected">
                {" ← "}
                {selected.derivations?.join(" ← ")}
              </span>
            )}
          </div>
          {selected.pos.length > 0 && (
            <div className="story-override__subspan-pos">
              {selected.pos.join(", ")}
            </div>
          )}
          {selected.primarySense && (
            <div className="story-override__subspan-sense">
              {selected.primarySense}
            </div>
          )}
        </div>
      ) : hasCandidates ? (
        <div className="story-override__subspan-empty">No candidate chosen</div>
      ) : (
        <div className="story-override__subspan-empty">
          No dictionary entries for this span
        </div>
      )}
      <div className="story-override__subspan-controls">
        {skipped ? (
          <button
            type="button"
            className="story-override__subspan-restore"
            onClick={onRestore}
            disabled={disabled}
            title="Write a manual row for this sub-span again"
          >
            Restore
          </button>
        ) : (
          <>
            {!isNameMode && hasCandidates && (
              <button
                type="button"
                className="story-override__subspan-toggle"
                onClick={() => setExpanded((v) => !v)}
                disabled={disabled}
              >
                {expanded ? "Hide" : `Choose (${state.candidates.length})`}
              </button>
            )}
            {!isNameMode && (
              <button
                type="button"
                className="story-override__subspan-name-btn"
                onClick={onEnterNameMode}
                disabled={disabled}
                title="Match this span as a name (proper noun) — skips JMdict lookup"
              >
                Match as name
              </button>
            )}
            {(isNameMode || selected) && (
              <button
                type="button"
                className="story-override__subspan-clear"
                onClick={onSkip}
                disabled={disabled}
                title="Don't write a manual row for this sub-span (let the algorithm decide). You can Restore it afterwards."
              >
                Skip
              </button>
            )}
          </>
        )}
      </div>
      {!skipped && !isNameMode && expanded && hasCandidates && (
        <ul className="story-override__candidate-list">
          {state.candidates.map((c, i) => (
            <li key={`${c.entryId}-${i}`}>
              <button
                type="button"
                className={`story-override__candidate${
                  state.selected === i ? " is-active" : ""
                }`}
                onClick={() => {
                  onSelect(i);
                  setExpanded(false);
                }}
                disabled={disabled}
              >
                <div className="story-override__candidate-head">
                  {c.reading && c.reading !== c.headword ? (
                    <ruby>
                      {c.headword}
                      <rt>{c.reading}</rt>
                    </ruby>
                  ) : (
                    c.headword
                  )}
                  {c.deinflected && (
                    <span className="story-override__candidate-tag">
                      deinflected
                    </span>
                  )}
                </div>
                {c.pos.length > 0 && (
                  <div className="story-override__candidate-pos">
                    {c.pos.join(", ")}
                  </div>
                )}
                {c.primarySense && (
                  <div className="story-override__candidate-sense">
                    {c.primarySense}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
