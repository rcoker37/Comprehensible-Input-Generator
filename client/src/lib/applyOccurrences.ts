// When `story_word_occurrences` is loaded for a story, we prefer it over a
// local re-regroup pass for rendering tap targets: it carries the exact
// spans the backfill produced (so manual override rows naturally take the
// place of the algorithm rows they replaced), and it round-trips back into
// the popover via the headword stored on each row — which is what makes
// the manual-override flow actually visible to the reader.
//
// The walk is char-by-char rather than part-by-part because a stale
// regrouped WordPart can straddle a manual row's boundary — e.g. the
// regrouper merged 朝ご飯 into one tap target, the user overrides just 朝
// (0,1), and the regrouper is unaware. A part-walk that tried to fit the
// (0,1) occurrence into the (0,3) WordPart would emit both and visibly
// duplicate the 朝 character on the page. Walking chars lets occurrences
// dictate their span, with whatever's left over in the gaps falling back
// to single-char or annotated parts.
import type {
  DisplayParagraph,
  SegmentPart,
} from "./storySegments";
import type { FuriganaAnnotation } from "./furigana";

export interface OccurrenceRow {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string | null;
  manual: boolean;
}

function partStart(p: SegmentPart): number {
  return p.kind === "char" ? p.offset : p.start;
}

function partEnd(p: SegmentPart): number {
  return p.kind === "char" ? p.offset + 1 : p.end;
}

export function applyOccurrences(
  paragraphs: DisplayParagraph[],
  occurrences: OccurrenceRow[],
  cleanText: string,
  annotations: FuriganaAnnotation[]
): DisplayParagraph[] {
  if (occurrences.length === 0) return paragraphs;
  const sorted = [...occurrences].sort((a, b) => a.start - b.start);

  return paragraphs.map((para) => ({
    sentences: para.sentences.map((sent) => {
      if (sent.parts.length === 0) return sent;
      const sentStart = partStart(sent.parts[0]!);
      const sentEnd = partEnd(sent.parts[sent.parts.length - 1]!);

      const out: SegmentPart[] = [];
      let cursor = sentStart;
      let oIdx = 0;
      while (oIdx < sorted.length && sorted[oIdx]!.end <= sentStart) oIdx++;

      while (cursor < sentEnd) {
        // Skip any occurrence that ended at or before the cursor — happens
        // when an earlier emit jumped past it.
        while (oIdx < sorted.length && sorted[oIdx]!.end <= cursor) oIdx++;
        const occ = oIdx < sorted.length ? sorted[oIdx]! : null;

        if (occ && occ.start === cursor && occ.end <= sentEnd) {
          const rubies = annotations.filter(
            (a) => a.start >= occ.start && a.end <= occ.end
          );
          out.push({
            kind: "word",
            start: occ.start,
            end: occ.end,
            surface: cleanText.slice(occ.start, occ.end),
            rubies: rubies.length > 0 ? rubies : undefined,
          });
          cursor = occ.end;
          oIdx++;
          continue;
        }

        // No occurrence anchored at the cursor — fill chars up to the next
        // occurrence start (or the sentence end) with char-level or
        // annotated parts.
        const nextStop = occ ? Math.min(occ.start, sentEnd) : sentEnd;
        while (cursor < nextStop) {
          const ann = annotations.find(
            (a) => a.start === cursor && a.end <= nextStop
          );
          if (ann) {
            out.push({
              kind: "annotated",
              start: ann.start,
              end: ann.end,
              surface: cleanText.slice(ann.start, ann.end),
              reading: ann.reading,
            });
            cursor = ann.end;
            continue;
          }
          const ch = cleanText[cursor];
          if (ch !== undefined && !/\s/.test(ch)) {
            out.push({ kind: "char", offset: cursor, char: ch });
          }
          cursor++;
        }
      }

      return { start: sent.start, parts: out };
    }),
  }));
}
