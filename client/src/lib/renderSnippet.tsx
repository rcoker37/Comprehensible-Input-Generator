import type { ReactNode } from "react";
import type { FuriganaAnnotation } from "./furigana";

// Walk the text emitting either ruby (for annotation spans) or plain text,
// wrapping the portion that falls inside the surface in <mark>. Annotations
// and the surface are character-aligned (offsets come from the same source).
// Annotations don't cross sentence boundaries; this snippet is a single
// sentence. `highlightClassName` lets callers theme the surface wrapper
// (WordPopover uses its own BEM class; Review uses the page-local one).
export function renderSnippet(
  text: string,
  annotations: FuriganaAnnotation[],
  surfaceStart: number,
  surfaceEnd: number,
  highlightClassName: string
): ReactNode {
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  // Split [segStart, segEnd) at the surface bounds, returning one node per
  // piece — the portion inside [surfaceStart, surfaceEnd) wrapped in <mark>,
  // the rest in <span>. Used both for plain text and for a ruby's base text,
  // so tapping a sub-span of a multi-kanji ruby block (山手 within
  // 山手線《やまのてせん》) highlights just that portion rather than the whole
  // block.
  const splitBySurface = (segStart: number, segEnd: number): ReactNode[] => {
    const pieces: ReactNode[] = [];
    let s = segStart;
    while (s < segEnd) {
      const next =
        s < surfaceStart && surfaceStart < segEnd
          ? surfaceStart
          : s < surfaceEnd && surfaceEnd < segEnd
            ? surfaceEnd
            : segEnd;
      const content = text.slice(s, next);
      const inSurface = s >= surfaceStart && next <= surfaceEnd;
      pieces.push(
        inSurface ? (
          <mark key={key++} className={highlightClassName}>
            {content}
          </mark>
        ) : (
          <span key={key++}>{content}</span>
        )
      );
      s = next;
    }
    return pieces;
  };

  for (const a of annotations) {
    if (a.start > cursor) {
      out.push(...splitBySurface(cursor, a.start));
    }
    out.push(
      <ruby key={key++}>
        {splitBySurface(a.start, a.end)}
        <rt>{a.reading}</rt>
      </ruby>
    );
    cursor = a.end;
  }
  if (cursor < text.length) {
    out.push(...splitBySurface(cursor, text.length));
  }
  return out;
}
