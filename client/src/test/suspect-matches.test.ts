// Tracer test for `npm run test:index:suspects` — re-runs the indexer on a
// fixture's content and flags spans whose chosen entry looks low-confidence
// against three heuristics:
//
//   1. `suspicious-misc`   — primary sense carries `chn` / `arch` / `obs` /
//                            `sl` / `vulg` / `derog`. JPDB ranks include
//                            children's/archaic/slang vocab; the indexer's
//                            rank hoist demotes these but only when the
//                            *primary* sense is marked, so a subtler entry
//                            slips through.
//   2. `not-named`         — span aligns with a single kuromoji 固有名詞
//                            token but `isName: false`. The 固有名詞-block
//                            fallback should have caught it; this surfaces
//                            cases where it didn't (e.g. the partition
//                            succeeded coincidentally for a real name).
//   3. `outranked-sibling` — `lookupWord(surface)` exposes a much-better-
//                            ranked entry that the algorithm did *not* pick
//                            — the rank hoist's literal-script partition or
//                            2× threshold may have steered away from it.
//
// Heuristics are intentionally noisy: better to surface a non-issue than to
// hide a real bug. The output is meant to be skimmed and cross-checked
// against `debug:span` when something looks off.

import { describe, it, beforeAll, expect } from "vitest";
import { readFileSync } from "node:fs";

const FIXTURE_PATH = process.env.SUSPECTS_FIXTURE_PATH;
const ACTIVE = FIXTURE_PATH !== undefined;

const SUSPICIOUS_MISC = new Set([
  "chn",
  "arch",
  "obs",
  "sl",
  "vulg",
  "derog",
  "dated",
]);

describe.skipIf(!ACTIVE)("suspect-matches", () => {
  beforeAll(async () => {
    const { setupHeadlessDictionary } = await import("./headlessDictionary");
    const { loadFrequencyIndex } = await import("../lib/frequency");
    await setupHeadlessDictionary();
    await loadFrequencyIndex();
  }, 120_000);

  it("flag", async () => {
    const { extractWordOccurrences } = await import("../lib/storyWordIndex");
    const { tokenizeText, isProperNoun } = await import("../lib/tokenizer");
    const { lookupWord } = await import("../lib/dictionary");
    const { lookupFrequencyByEntrySync } = await import("../lib/frequency");
    const { parseAnnotatedText } = await import("../lib/furigana");

    const fixture = JSON.parse(readFileSync(FIXTURE_PATH!, "utf-8")) as {
      content: string;
    };
    const { cleanText } = parseAnnotatedText(fixture.content);

    const occs = await extractWordOccurrences({ content: fixture.content });
    const tokens = await tokenizeText(cleanText);

    interface Suspect {
      start: number;
      end: number;
      surface: string;
      picked: string;
      reasons: string[];
    }
    const suspects: Suspect[] = [];

    for (const occ of occs) {
      const reasons: string[] = [];

      // (1) suspicious-misc on the picked entry's primary sense.
      if (occ.entryId !== null) {
        const exact = await lookupWord(occ.surface);
        const picked = exact.find((wr) => wr.id === occ.entryId);
        const primaryMisc = picked?.s?.[0]?.misc ?? [];
        const flagged = primaryMisc.filter((m) => SUSPICIOUS_MISC.has(m));
        if (flagged.length > 0) {
          const g = picked?.s?.[0]?.g?.slice(0, 1).map((g) => g.str) ?? [];
          reasons.push(
            `suspicious-misc: primary sense [${flagged.join(", ")}] — "${g.join("; ")}"`
          );
        }
      }

      // (2) single 固有名詞 token + isName: false.
      const blockTokens = tokens.filter(
        (t) => t.start >= occ.start && t.end <= occ.end
      );
      if (
        !occ.isName &&
        blockTokens.length === 1 &&
        isProperNoun(blockTokens[0]!)
      ) {
        reasons.push(`not-named: kuromoji tagged 固有名詞 but isName=false`);
      }

      // (3) outranked sibling in exact lookup. Skip name spans and
      // deinflected hits where the comparison is meaningless.
      if (!occ.isName) {
        const exact = await lookupWord(occ.surface);
        if (exact.length > 1) {
          const pickedRank =
            occ.entryId !== null
              ? (lookupFrequencyByEntrySync(occ.entryId)?.rank ??
                Number.POSITIVE_INFINITY)
              : Number.POSITIVE_INFINITY;
          let bestSibling: {
            id: number;
            rank: number;
            k: string;
            g: string;
          } | null = null;
          for (const wr of exact) {
            if (wr.id === occ.entryId) continue;
            const rank =
              lookupFrequencyByEntrySync(wr.id)?.rank ??
              Number.POSITIVE_INFINITY;
            if (!Number.isFinite(rank)) continue;
            if (rank * 2 >= pickedRank) continue; // require ≥2× better
            if (!bestSibling || rank < bestSibling.rank) {
              bestSibling = {
                id: wr.id,
                rank,
                k:
                  wr.k?.[0]?.ent ??
                  wr.r?.[0]?.ent ??
                  String(wr.id),
                g: wr.s?.[0]?.g?.[0]?.str ?? "",
              };
            }
          }
          if (bestSibling) {
            reasons.push(
              `outranked-sibling: ${bestSibling.k} #${bestSibling.id} ` +
                `(rank ${bestSibling.rank}) "${bestSibling.g}" ` +
                `— picked rank ${
                  Number.isFinite(pickedRank) ? pickedRank : "∞"
                }`
            );
          }
        }
      }

      if (reasons.length > 0) {
        suspects.push({
          start: occ.start,
          end: occ.end,
          surface: occ.surface,
          picked: `${occ.headword}《${occ.reading}》 #${occ.entryId ?? "—"}${occ.isName ? " [NAME]" : ""}`,
          reasons,
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      [
        `\n─ suspect-matches ─ ${suspects.length} flagged out of ${occs.length} spans\n`,
        ...suspects.map((s) =>
          [
            `  [${s.start},${s.end}] ${s.surface} → ${s.picked}`,
            ...s.reasons.map((r) => `    · ${r}`),
          ].join("\n")
        ),
      ].join("\n")
    );
    expect(true).toBe(true);
  });
});
