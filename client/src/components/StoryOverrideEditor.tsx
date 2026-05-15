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
  selected: number | null;
}

function subspanKey(start: number, end: number): string {
  return `${start}-${end}`;
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
        next.set(key, { loading: true, candidates: [], selected: null });
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
      next.set(key, { ...cur, selected: index });
      return next;
    });
  };

  const handleClearSelection = (subspan: Subspan) => {
    const key = subspanKey(subspan.start, subspan.end);
    setCandidatesBySpan((prev) => {
      const cur = prev.get(key);
      if (!cur) return prev;
      const next = new Map(prev);
      next.set(key, { ...cur, selected: null });
      return next;
    });
  };

  const anyLoading = subspans.some(
    (s) => candidatesBySpan.get(subspanKey(s.start, s.end))?.loading
  );
  const anySelected = subspans.some(
    (s) => candidatesBySpan.get(subspanKey(s.start, s.end))?.selected !== null
  );
  const canSave = !saving && !anyLoading && anySelected;

  const handleSave = async () => {
    setSaveError(null);
    const overrides: WordOverride[] = [];
    for (const s of subspans) {
      const state = candidatesBySpan.get(subspanKey(s.start, s.end));
      if (!state || state.selected === null) continue;
      const cand = state.candidates[state.selected];
      if (!cand) continue;
      overrides.push({
        start: s.start,
        end: s.end,
        surface: s.surface,
        headword: cand.headword,
        reading: cand.reading ?? "",
        entryId: cand.entryId,
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
              onClear={() => handleClearSelection(s)}
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
  onClear: () => void;
  disabled: boolean;
}

function SubspanPanel({
  subspan,
  state,
  onSelect,
  onClear,
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

  const selected =
    state.selected !== null ? state.candidates[state.selected] : null;
  const hasCandidates = state.candidates.length > 0;

  return (
    <div className="story-override__subspan">
      <div className="story-override__subspan-surface">{subspan.surface}</div>
      {selected ? (
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
        {hasCandidates && (
          <button
            type="button"
            className="story-override__subspan-toggle"
            onClick={() => setExpanded((v) => !v)}
            disabled={disabled}
          >
            {expanded ? "Hide" : `Choose (${state.candidates.length})`}
          </button>
        )}
        {selected && (
          <button
            type="button"
            className="story-override__subspan-clear"
            onClick={onClear}
            disabled={disabled}
            title="Don't write a manual row for this sub-span (let the algorithm decide)"
          >
            Skip
          </button>
        )}
      </div>
      {expanded && hasCandidates && (
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
