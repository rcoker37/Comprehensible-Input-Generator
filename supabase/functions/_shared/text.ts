// Shared text helpers for word-context edge functions (explain-word, ask-word).
// Keep in sync with client/src/lib/text.ts (stripBold) and
// client/src/lib/furigana.ts (parseAnnotatedText).

const RUBY_RE = /([一-龯㐀-䶿々]+)([぀-ゟ]*)《([^《》]+)》/g;

export function stripBold(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1");
}

export function cleanContent(raw: string): string {
  const withoutBold = stripBold(raw);
  let clean = "";
  let cursor = 0;
  RUBY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUBY_RE.exec(withoutBold)) !== null) {
    const kanjiRun = match[1];
    const okurigana = match[2];
    const reading = match[3];
    clean += withoutBold.slice(cursor, match.index);
    const absorb = okurigana.length > 0 && reading.endsWith(okurigana);
    clean += absorb ? kanjiRun + okurigana : kanjiRun;
    if (!absorb && okurigana.length > 0) clean += okurigana;
    cursor = match.index + match[0].length;
  }
  clean += withoutBold.slice(cursor);
  return clean;
}

// Split on the nearest sentence terminator before `start` and after `end`.
// '\n' is a terminator for passages laid out line-by-line (dialogue) where
// a punctuated terminator may be missing.
const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "\n"]);

export function findSentenceBounds(
  content: string,
  start: number,
  end: number
): { sentenceStart: number; sentenceEnd: number } {
  let sentenceStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (SENTENCE_TERMINATORS.has(content[i])) {
      sentenceStart = i + 1;
      break;
    }
  }
  let sentenceEnd = content.length;
  for (let i = end; i < content.length; i++) {
    if (SENTENCE_TERMINATORS.has(content[i])) {
      sentenceEnd = i + 1;
      break;
    }
  }
  return { sentenceStart, sentenceEnd };
}

export function buildSentenceWithMarker(
  content: string,
  sentenceStart: number,
  sentenceEnd: number,
  targetStart: number,
  targetEnd: number
): string {
  return (
    content.slice(sentenceStart, targetStart) +
    "【" +
    content.slice(targetStart, targetEnd) +
    "】" +
    content.slice(targetEnd, sentenceEnd)
  ).trim();
}
