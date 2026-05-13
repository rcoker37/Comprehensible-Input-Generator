// Shared text helpers for word-context edge functions.
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
