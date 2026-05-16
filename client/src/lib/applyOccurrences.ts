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
        // Retire every occurrence that can't anchor a tap target at the
        // cursor before reading the next one. Three cases drop a row:
        //   - it starts before the cursor (an earlier emit already
        //     consumed past its start, or it ended behind us);
        //   - its span runs past this sentence's end;
        //   - it is empty / inverted (end <= start).
        // The middle case is the one a manual "match as name" override can
        // hit: name mode is the only override path that writes a row
        // without a JMdict candidate, so the user can mark a span that
        // straddles a 。 or a line break (the region editor's extend
        // controls hop whitespace, newlines included). Such a row can't be
        // a single tap target inside one sentence — dropping it lets the
        // chars fall back to char-level parts. Without the skip the cursor
        // pins against `occ.start <= cursor` (nextStop never exceeds it)
        // and the walk spins forever, freezing the tab.
        while (
          oIdx < sorted.length &&
          (sorted[oIdx]!.end <= sorted[oIdx]!.start ||
            sorted[oIdx]!.start < cursor ||
            sorted[oIdx]!.end > sentEnd)
        ) {
          oIdx++;
        }
        const occ = oIdx < sorted.length ? sorted[oIdx]! : null;

        if (occ && occ.start === cursor) {
          // The skip-loop guarantees occ.end > occ.start and
          // occ.end <= sentEnd, so this always advances the cursor.
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
        // annotated parts. Any surviving `occ` now starts strictly after
        // the cursor, so `nextStop` is always > cursor and the walk
        // progresses.
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
