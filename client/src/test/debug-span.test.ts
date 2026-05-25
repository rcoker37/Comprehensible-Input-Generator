// Tracer test for `npm run debug:span` — dumps every step of the indexer
// pipeline for a single span (kuromoji tokens, exact JMdict hits, deinflection
// candidates, the final `lookupAtBoundary` result).
//
// Driven by env vars set by scripts/debug-span.mjs. When the env vars are
// absent (e.g. `npm test`), the test suite skips itself so the headless dict
// boot doesn't slow other runs.

import { describe, it, beforeAll, expect } from "vitest";

const TEXT = process.env.DEBUG_SPAN_TEXT;
const START = process.env.DEBUG_SPAN_START
  ? Number(process.env.DEBUG_SPAN_START)
  : null;
const END = process.env.DEBUG_SPAN_END
  ? Number(process.env.DEBUG_SPAN_END)
  : null;
const ACTIVE = TEXT !== undefined && START !== null && END !== null;

describe.skipIf(!ACTIVE)("debug:span", () => {
  beforeAll(async () => {
    const { setupHeadlessDictionary } = await import("./headlessDictionary");
    const { loadFrequencyIndex } = await import("../lib/frequency");
    await setupHeadlessDictionary();
    await loadFrequencyIndex();
  }, 120_000);

  it("trace", async () => {
    const { lookupAtBoundary } = await import("../lib/lookupAtCursor");
    const { lookupWord } = await import("../lib/dictionary");
    const { posHintAtOffset, baseHintAtOffset, tokenizeText } = await import(
      "../lib/tokenizer"
    );
    const { lookupFrequencyByEntrySync } = await import("../lib/frequency");
    const { deinflect } = await import("../lib/japaneseDeinflect");
    const { parseAnnotatedText } = await import("../lib/furigana");

    const text = TEXT!;
    const start = START!;
    const end = END!;

    // Allow the caller to pass either raw text or annotated text — strip
    // ruby first so offsets are into the cleaned content (what every
    // downstream module operates on).
    const { cleanText, annotations } = parseAnnotatedText(text);
    const surface = cleanText.slice(start, end);

    const posHint = await posHintAtOffset(cleanText, start);
    const baseHint = await baseHintAtOffset(cleanText, start);
    const tokens = await tokenizeText(cleanText);
    const insideTokens = tokens.filter(
      (t) => t.start >= start && t.end <= end
    );

    const fmtResult = (wr: {
      id: number;
      k?: { ent: string }[];
      r?: { ent: string }[];
      s?: {
        pos?: string[];
        misc?: string[];
        g?: { str: string }[];
      }[];
    }): Record<string, unknown> => ({
      id: wr.id,
      rank: lookupFrequencyByEntrySync(wr.id)?.rank ?? null,
      k: wr.k?.map((kk) => kk.ent) ?? [],
      r: wr.r?.map((rr) => rr.ent) ?? [],
      pos: wr.s?.[0]?.pos ?? [],
      misc: wr.s?.[0]?.misc ?? [],
      g: wr.s?.[0]?.g?.slice(0, 2).map((g) => g.str) ?? [],
    });

    const exact = await lookupWord(surface);
    const deinflections: unknown[] = [];
    for (const c of deinflect(surface)) {
      const hits = await lookupWord(c.base);
      if (hits.length === 0) continue;
      deinflections.push({
        base: c.base,
        derivations: c.derivations,
        consumed: c.consumed,
        hits: hits.slice(0, 3).map(fmtResult),
      });
    }
    const finalHit = await lookupAtBoundary(
      cleanText,
      start,
      end,
      annotations,
      posHint,
      baseHint
    );

    const trace = {
      input: {
        rawText: text,
        cleanText,
        start,
        end,
        surface,
        annotationsCovering: annotations.filter(
          (a) => a.start < end && a.end > start
        ),
      },
      kuromoji: {
        posHint: posHint ?? null,
        baseHint: baseHint ?? null,
        insideTokens: insideTokens.map((t) => ({
          surface: t.surface,
          start: t.start,
          end: t.end,
          pos: t.pos,
          posDetail1: t.posDetail1,
          basicForm: t.basicForm,
        })),
        allTokens: tokens
          .map((t) => `${t.surface}/${t.pos}-${t.posDetail1}`)
          .join(" "),
      },
      exact: exact.slice(0, 6).map(fmtResult),
      deinflections,
      finalHit: finalHit
        ? {
            base: finalHit.base ?? null,
            derivations: finalHit.derivations ?? null,
            preferredReading: finalHit.preferredReading ?? null,
            results: finalHit.results.slice(0, 4).map(fmtResult),
          }
        : null,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(trace, null, 2));
    expect(true).toBe(true);
  });
});
