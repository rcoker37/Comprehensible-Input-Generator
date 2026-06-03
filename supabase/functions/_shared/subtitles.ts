// Subtitle parsing shared by the media-import path. Turns a downloaded .srt or
// .ass file into a clean list of Japanese dialogue lines, which import-media
// joins with newlines into media_episodes.raw_content. annotate-media then
// adds Aozora ruby.

const JP_CHAR = /[぀-ゟ゠-ヿ一-龯㐀-䶿]/;

// Strip inline styling that shows up in both formats:
//  - HTML-ish tags <i> </b> <font ...>
//  - ASS override blocks {\an8}{\pos(...)}
//  - ASS drawing/newline escapes \N \n \h
function stripInline(s: string): string {
  return s
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\\[Nnh]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSrt(text: string): string[] {
  const out: string[] = [];
  // Cues are separated by blank lines. Within a cue, skip the numeric index
  // line and the "00:00 --> 00:00" timing line; the rest is dialogue.
  const blocks = text.replace(/\r/g, "").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const textLines = lines.filter(
      (l) => !/-->/.test(l) && !/^\s*\d+\s*$/.test(l),
    );
    const joined = stripInline(textLines.join(" "));
    if (joined) out.push(joined);
  }
  return out;
}

function parseAss(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  // The Format: line under [Events] tells us which comma-separated field is the
  // text. It's always last, so we can split on the first 9 commas regardless,
  // but we read the format to be safe about non-standard field counts.
  let textIndex = 9;
  for (const line of lines) {
    if (/^Format\s*:/i.test(line) && /\bText\b/i.test(line)) {
      const fields = line.slice(line.indexOf(":") + 1).split(",").map((f) => f.trim());
      const idx = fields.findIndex((f) => /^Text$/i.test(f));
      if (idx >= 0) textIndex = idx;
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line)) continue;
    const payload = line.slice(line.indexOf(":") + 1);
    const parts = payload.split(",");
    const textField = parts.slice(textIndex).join(",");
    const cleaned = stripInline(textField);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

export function parseSubtitle(filename: string, text: string): string[] {
  const lower = filename.toLowerCase();
  const raw = lower.endsWith(".ass") || lower.endsWith(".ssa")
    ? parseAss(text)
    : parseSrt(text);

  // Keep only lines carrying Japanese (drops typeset/sign-only romaji lines)
  // and collapse runs of identical consecutive lines (karaoke/sign spam).
  const out: string[] = [];
  for (const line of raw) {
    if (!JP_CHAR.test(line)) continue;
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out;
}

// Best-effort episode number from a subtitle filename, e.g.
// "Show - 03 [1080p].srt" → 3, "Show.S01E12.ass" → 12.
export function episodeNumberFromName(name: string): number | null {
  const ep = name.match(/(?:[Ee]p?\.?\s*|[Ss]\d+\s*[Ee])(\d{1,3})/);
  if (ep) return parseInt(ep[1], 10);
  const dash = name.match(/[-–]\s*(\d{1,3})(?:\s|\.|\[|$)/);
  if (dash) return parseInt(dash[1], 10);
  return null;
}
