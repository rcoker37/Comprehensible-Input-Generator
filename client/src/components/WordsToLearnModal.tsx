import { useEffect, useState, type ReactNode } from "react";
import Modal from "./Modal";
import WordPopover from "./WordPopover";
import AnimatedDots from "./AnimatedDots";
import {
  getChatMessage,
  getChatMessageOccurrences,
  getChatMessageWordEncounters,
  getStory,
  getStoryOccurrences,
  getStoryWordEncounters,
} from "../api/client";
import { parseAnnotatedText, type FuriganaAnnotation } from "../lib/furigana";
import { stripBold } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import { extractSentenceSnippet } from "../lib/sentenceSnippet";
import { lookupWord } from "../lib/dictionary";
import "./WordsToLearnModal.css";

// Walk text emitting plain spans and <ruby> for any annotation ranges.
// Annotations must be sorted by start and non-overlapping (the
// parseAnnotatedText output is).
function renderWithRuby(
  text: string,
  annotations: FuriganaAnnotation[]
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const a of annotations) {
    if (a.start > cursor) out.push(text.slice(cursor, a.start));
    out.push(
      <ruby key={key++}>
        {text.slice(a.start, a.end)}
        <rt>{a.reading}</rt>
      </ruby>
    );
    cursor = a.end;
  }
  if (cursor < text.length) out.push(text.slice(cursor));
  return out;
}

// All-kanji surfaces are safe to overlay with the stored `reading` even
// when the LLM's per-char rubies didn't fall inside our span (the indexer
// often peels a counter out of a larger numeric block like 一九二五年,
// inheriting the partition-assigned reading ねん). A surface with embedded
// kana is risky because the stored reading can be the lemma's (e.g. 食べた
// → たべる, which doesn't read 食べた), so we skip the fallback there.
function surfaceIsAllKanji(surface: string): boolean {
  for (const ch of surface) {
    if (!KANJI_REGEX.test(ch)) return false;
  }
  return surface.length > 0;
}

// Rows with this many or more encounters across the user's read sources are
// considered familiar enough to drop from the list. Matches the hard cap on
// `rarity.ts`'s per-kanji exposure curve.
const FAMILIAR_THRESHOLD = 10;

interface ContextSnippet {
  text: string;
  surfaceStart: number;
  surfaceEnd: number;
}

interface Row {
  /** Surface as it appears in the source — what the user actually saw. */
  surface: string;
  /** Ruby annotations within the surface, rebased to start at 0. */
  surfaceAnnotations: FuriganaAnnotation[];
  headword: string;
  reading: string | null;
  entryId: number | null;
  encounters: number;
  /** Sentence containing the first occurrence; null if extraction failed. */
  context: ContextSnippet | null;
}

interface OccurrenceLike {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string | null;
  entryId: number | null;
  isName: boolean;
}

interface ContentBatch {
  cleanText: string;
  annotations: FuriganaAnnotation[];
  occurrences: OccurrenceLike[];
  encounters: Map<string, number>;
}

export type WordsToLearnSource =
  | { kind: "story"; storyId: number }
  | { kind: "chat"; messageIds: number[] };

interface Props {
  source: WordsToLearnSource;
  open: boolean;
  onClose: () => void;
}

// Aggregate batches into one row per unique non-name headword with
// `encounters < FAMILIAR_THRESHOLD`. Encounter counts are global per
// headword, so the first occurrence stands in — and that first occurrence's
// surface (the exact form the reader saw) + containing sentence are
// captured for the row. Insertion order is preserved by `Map`, so the
// returned list is in reading order: batch-by-batch, then by start offset.
function aggregate(batches: ContentBatch[]): Row[] {
  const byHeadword = new Map<string, Row>();
  for (const batch of batches) {
    for (const o of batch.occurrences) {
      if (o.isName || !o.headword) continue;
      if (byHeadword.has(o.headword)) continue;
      const snippet = extractSentenceSnippet(
        batch.cleanText,
        batch.annotations,
        o.start,
        o.end
      );
      // Surface-relative annotations. Prefer LLM ruby blocks that fall
      // entirely inside [o.start, o.end), rebased to the surface — those
      // are guaranteed to match the surface (including inflected forms
      // like 食《た》べた, which the stored lemma reading たべる can't
      // describe). Fall back to the stored `reading` when the surface is
      // all kanji and the LLM rubied a wider phrase (the indexer-assigned
      // reading for a peeled span is correct in that case — 一九二五年's
      // 年 inherits ねん).
      let surfaceAnnotations = batch.annotations
        .filter((a) => a.start >= o.start && a.end <= o.end)
        .map((a) => ({
          start: a.start - o.start,
          end: a.end - o.start,
          reading: a.reading,
        }));
      if (
        surfaceAnnotations.length === 0 &&
        o.reading &&
        surfaceIsAllKanji(o.surface)
      ) {
        surfaceAnnotations = [
          { start: 0, end: o.surface.length, reading: o.reading },
        ];
      }
      byHeadword.set(o.headword, {
        surface: o.surface,
        surfaceAnnotations,
        headword: o.headword,
        reading: o.reading,
        entryId: o.entryId,
        encounters: batch.encounters.get(`${o.start}-${o.end}`) ?? 0,
        context: snippet
          ? {
              text: snippet.text,
              surfaceStart: snippet.surfaceStart,
              surfaceEnd: snippet.surfaceEnd,
            }
          : null,
      });
    }
  }
  return [...byHeadword.values()].filter(
    (r) => r.encounters < FAMILIAR_THRESHOLD
  );
}

async function loadBatches(source: WordsToLearnSource): Promise<ContentBatch[]> {
  if (source.kind === "story") {
    const [story, occurrences, encounters] = await Promise.all([
      getStory(source.storyId),
      getStoryOccurrences(source.storyId),
      getStoryWordEncounters(source.storyId),
    ]);
    const { cleanText, annotations } = parseAnnotatedText(
      stripBold(story.content)
    );
    return [{ cleanText, annotations, occurrences, encounters }];
  }
  return Promise.all(
    source.messageIds.map(async (id) => {
      const [msg, occs, encs] = await Promise.all([
        getChatMessage(id),
        getChatMessageOccurrences(id),
        getChatMessageWordEncounters(id),
      ]);
      const { cleanText, annotations } = parseAnnotatedText(
        stripBold(msg.content)
      );
      return { cleanText, annotations, occurrences: occs, encounters: encs };
    })
  );
}

export default function WordsToLearnModal({ source, open, onClose }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeWord, setActiveWord] = useState<Row | null>(null);
  // Per-headword English gloss, fetched lazily from JMdict once rows are
  // visible. Mirrors KanjiInlineDetail's "Words using X" pattern.
  const [meanings, setMeanings] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRows(null);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setError(null);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveWord(null);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMeanings(new Map());
      return;
    }
    let cancelled = false;
    loadBatches(source)
      .then((batches) => {
        if (!cancelled) setRows(aggregate(batches));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load words");
      });
    return () => {
      cancelled = true;
    };
  }, [open, source]);

  // Lazy-load English meanings. Prefer the JMdict entry the indexer
  // actually chose (matched by `entryId`); fall back to `results[0]` for
  // older rows that pre-date entry-id stamping. Senses join with "; "
  // matching the kanji-popover "Words using X" rows.
  useEffect(() => {
    if (!rows || rows.length === 0) return;
    const missing = rows.filter((r) => !meanings.has(r.headword));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (r) => {
        try {
          const results = await lookupWord(r.headword);
          const entry =
            (r.entryId !== null &&
              results.find((w) => w.id === r.entryId)) ||
            results[0];
          if (!entry) return [r.headword, ""] as const;
          const gloss =
            entry.s[0]?.g
              .map((g: { str: string }) => g.str)
              .join("; ") ?? "";
          return [r.headword, gloss] as const;
        } catch {
          return [r.headword, ""] as const;
        }
      })
    ).then((pairs) => {
      if (cancelled) return;
      setMeanings((prev) => {
        const next = new Map(prev);
        for (const [hw, gloss] of pairs) next.set(hw, gloss);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [rows, meanings]);

  return (
    <>
      <Modal
        open={open && activeWord === null}
        onClose={onClose}
        className="words-to-learn-modal"
      >
        <div className="words-to-learn-body">
          <h2 className="words-to-learn-title">Words to learn</h2>
          {error && <div className="error">{error}</div>}
          {rows === null && !error ? (
            <div className="words-to-learn-status">
              Loading
              <AnimatedDots />
            </div>
          ) : rows && rows.length === 0 ? (
            <div className="words-to-learn-status">
              No unfamiliar words here.
            </div>
          ) : rows ? (
            <ul className="words-to-learn-list">
              {rows.map((r) => (
                <li key={r.headword}>
                  <button
                    type="button"
                    className="words-to-learn-row"
                    onClick={() => setActiveWord(r)}
                  >
                    <div className="words-to-learn-row-top">
                      <span className="words-to-learn-surface">
                        {renderWithRuby(r.surface, r.surfaceAnnotations)}
                      </span>
                      {meanings.get(r.headword) && (
                        <span className="words-to-learn-meaning">
                          {meanings.get(r.headword)}
                        </span>
                      )}
                      <span className="words-to-learn-count">
                        {r.encounters === 0
                          ? "new"
                          : `${Math.round(r.encounters)}×`}
                      </span>
                    </div>
                    {r.context && (
                      <div className="words-to-learn-context">
                        {r.context.text.slice(0, r.context.surfaceStart)}
                        <mark>
                          {r.context.text.slice(
                            r.context.surfaceStart,
                            r.context.surfaceEnd
                          )}
                        </mark>
                        {r.context.text.slice(r.context.surfaceEnd)}
                      </div>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Modal>
      <WordPopover
        mode={{
          kind: "headword",
          headword: activeWord?.headword ?? "",
          entryId: activeWord?.entryId ?? null,
          reading: activeWord?.reading ?? null,
        }}
        open={activeWord !== null}
        onOpenChange={(o) => {
          if (!o) setActiveWord(null);
        }}
      />
    </>
  );
}
