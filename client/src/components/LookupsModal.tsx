import { useEffect, useMemo, useState, type ReactNode } from "react";
import Modal from "./Modal";
import WordPopover from "./WordPopover";
import { parseAnnotatedText, type FuriganaAnnotation } from "../lib/furigana";
import { stripBold } from "../lib/text";
import { KANJI_REGEX } from "../lib/constants";
import { extractSentenceSnippet } from "../lib/sentenceSnippet";
import { lookupWord } from "../lib/dictionary";
import "./LookupsModal.css";

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

function surfaceIsAllKanji(surface: string): boolean {
  for (const ch of surface) {
    if (!KANJI_REGEX.test(ch)) return false;
  }
  return surface.length > 0;
}

export interface LookupOccurrence {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string | null;
  entryId: number | null;
  isName: boolean;
}

interface ContextSnippet {
  text: string;
  surfaceStart: number;
  surfaceEnd: number;
}

interface Row {
  surface: string;
  surfaceAnnotations: FuriganaAnnotation[];
  headword: string;
  reading: string | null;
  entryId: number | null;
  context: ContextSnippet | null;
}

interface Props {
  /** Raw passage content (with Aozora ruby) for sentence-snippet extraction. */
  content: string;
  /** Every indexed occurrence in the passage; the modal filters to marked headwords. */
  occurrences: LookupOccurrence[];
  /** Set of headwords the user tapped in the body — these are the rows to show. */
  markedHeadwords: Set<string>;
  open: boolean;
  onClose: () => void;
}

function buildRows(
  content: string,
  occurrences: LookupOccurrence[],
  markedHeadwords: Set<string>
): Row[] {
  const { cleanText, annotations } = parseAnnotatedText(stripBold(content));
  const byHeadword = new Map<string, Row>();
  for (const o of occurrences) {
    if (o.isName || !o.headword) continue;
    if (!markedHeadwords.has(o.headword)) continue;
    if (byHeadword.has(o.headword)) continue;
    const snippet = extractSentenceSnippet(
      cleanText,
      annotations,
      o.start,
      o.end
    );
    let surfaceAnnotations = annotations
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
      context: snippet
        ? {
            text: snippet.text,
            surfaceStart: snippet.surfaceStart,
            surfaceEnd: snippet.surfaceEnd,
          }
        : null,
    });
  }
  return [...byHeadword.values()];
}

export default function LookupsModal({
  content,
  occurrences,
  markedHeadwords,
  open,
  onClose,
}: Props) {
  const [activeWord, setActiveWord] = useState<Row | null>(null);
  const [meanings, setMeanings] = useState<Map<string, string>>(new Map());

  const rows = useMemo(
    () => (open ? buildRows(content, occurrences, markedHeadwords) : []),
    [open, content, occurrences, markedHeadwords]
  );

  useEffect(() => {
    if (!open) {
      /* eslint-disable react-hooks/set-state-in-effect -- one-shot
         reset when the modal closes; the cascading render is desired. */
      setActiveWord(null);
      setMeanings(new Map());
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [open]);

  useEffect(() => {
    if (!open || rows.length === 0) return;
    const missing = rows.filter((r) => !meanings.has(r.headword));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (r) => {
        try {
          const results = await lookupWord(r.headword);
          const entry =
            (r.entryId !== null && results.find((w) => w.id === r.entryId)) ||
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
  }, [open, rows, meanings]);

  return (
    <>
      <Modal
        open={open && activeWord === null}
        onClose={onClose}
        className="lookups-modal"
      >
        <div className="lookups-body">
          <h2 className="lookups-title">Lookups</h2>
          {rows.length === 0 ? (
            <div className="lookups-status">
              Tap words in the passage to add them here.
            </div>
          ) : (
            <ul className="lookups-list">
              {rows.map((r) => (
                <li key={r.headword}>
                  <button
                    type="button"
                    className="lookups-row"
                    onClick={() => setActiveWord(r)}
                  >
                    <div className="lookups-row-top">
                      <span className="lookups-surface">
                        {renderWithRuby(r.surface, r.surfaceAnnotations)}
                      </span>
                      {meanings.get(r.headword) && (
                        <span className="lookups-meaning">
                          {meanings.get(r.headword)}
                        </span>
                      )}
                    </div>
                    {r.context && (
                      <div className="lookups-context">
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
          )}
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
