import type { ReactNode } from "react";
import { KANJI_REGEX } from "./constants";

// Wrap only the kanji middle of `surface` in <ruby>, stripping matching
// leading/trailing kana so the furigana sits over the actual kanji glyphs
// rather than smearing the whole reading across the kana parts too:
//   大切にする (たいせつにする) → 大切《たいせつ》にする
//   食べる (たべる)             → 食《た》べる
//   お父さん (おとうさん)        → お 父《とう》 さん
//   中 (うち)                   → 中《うち》
//   うち (うち) / pure kana     → plain text (no ruby)
export function renderSurfaceRuby(
  surface: string,
  reading: string | null
): ReactNode {
  if (!reading || surface === reading) return surface;
  const chars = [...surface];
  const readingChars = [...reading];
  let leadLen = 0;
  while (
    leadLen < chars.length &&
    leadLen < readingChars.length &&
    !KANJI_REGEX.test(chars[leadLen]!) &&
    chars[leadLen] === readingChars[leadLen]
  ) {
    leadLen++;
  }
  let trailLen = 0;
  while (
    trailLen < chars.length - leadLen &&
    trailLen < readingChars.length - leadLen &&
    !KANJI_REGEX.test(chars[chars.length - 1 - trailLen]!) &&
    chars[chars.length - 1 - trailLen] ===
      readingChars[readingChars.length - 1 - trailLen]
  ) {
    trailLen++;
  }
  const leading = chars.slice(0, leadLen).join("");
  const trailing = chars.slice(chars.length - trailLen).join("");
  const middleBase = chars.slice(leadLen, chars.length - trailLen).join("");
  const middleReading = readingChars
    .slice(leadLen, readingChars.length - trailLen)
    .join("");
  if (!middleBase || !middleReading || middleBase === middleReading)
    return surface;
  // Nothing to gloss if the middle has no kanji — bail to plain text.
  if (![...middleBase].some((ch) => KANJI_REGEX.test(ch))) return surface;
  return (
    <>
      {leading}
      <ruby>
        {middleBase}
        <rt>{middleReading}</rt>
      </ruby>
      {trailing}
    </>
  );
}
