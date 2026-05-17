import { describe, it, expect, vi, beforeEach } from "vitest";
import { rankToTier } from "./frequency";

describe("rankToTier", () => {
  it("buckets ranks into tiers", () => {
    expect(rankToTier(1)).toBe("very-common");
    expect(rankToTier(1500)).toBe("very-common");
    expect(rankToTier(1501)).toBe("common");
    expect(rankToTier(5000)).toBe("common");
    expect(rankToTier(5001)).toBe("uncommon");
    expect(rankToTier(15000)).toBe("uncommon");
    expect(rankToTier(15001)).toBe("rare");
    expect(rankToTier(30000)).toBe("rare");
    expect(rankToTier(30001)).toBe("very-rare");
    expect(rankToTier(null)).toBe("very-rare");
  });
});

function stubIndex(index: Record<string, Array<[string | null, number]>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(index),
      })
    )
  );
}

describe("lookupBestFrequency", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("picks the lowest rank across candidate orthographies", async () => {
    stubIndex({
      "お供え": [["おそなえ", 32269]],
      "御供": [["おとも", 71408]],
    });
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency(
      ["御供え", "お供え"],
      "おそなえ"
    );
    expect(result).toEqual({
      rank: 32269,
      tier: "very-rare",
      headword: "お供え",
    });
  });

  it("returns very-rare when no candidate is in the index", async () => {
    stubIndex({ "別の語": [["べつのご", 5000]] });
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency(["御供え"], "おそなえ");
    expect(result).toEqual({ rank: null, tier: "very-rare", headword: null });
  });

  it("deduplicates candidates", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ "あなた": [[null, 121]] }),
      })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency(
      ["あなた", "あなた", ""],
      null
    );
    expect(result).toEqual({
      rank: 121,
      tier: "very-common",
      headword: "あなた",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns very-rare when no candidates are supplied", async () => {
    stubIndex({});
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency([], "おそなえ");
    expect(result).toEqual({ rank: null, tier: "very-rare", headword: null });
  });

  it("prefers a common kana variant over the canonical kanji form", async () => {
    stubIndex({
      "貴方": [["あなた", 3151]],
      "あなた": [[null, 121]],
    });
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency(["貴方", "あなた"], "あなた");
    expect(result).toEqual({
      rank: 121,
      tier: "very-common",
      headword: "あなた",
    });
  });
});

interface RawEntryRecord {
  rank: number;
  headword: string;
  reading: string | null;
  canonical: string;
}

function stubBothIndices(
  surface: Record<string, Array<[string | null, number]>>,
  byEntry: Record<string, RawEntryRecord>
) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const payload = url.includes("jpdb-by-entry") ? byEntry : surface;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(payload),
      });
    })
  );
}

describe("by-entry frequency lookups", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("returns the entry's resolved rank for an EID hit", async () => {
    stubBothIndices(
      {},
      {
        "1154330": {
          rank: 881,
          headword: "暗い",
          reading: "くらい",
          canonical: "暗い",
        },
      }
    );
    const { lookupFrequencyByEntry } = await import("./frequency");
    const result = await lookupFrequencyByEntry(1154330);
    expect(result).toEqual({
      rank: 881,
      tier: "very-common",
      headword: "暗い",
      reading: "くらい",
    });
  });

  it("does not let a homophone in a different entry steal 暗い's rank", async () => {
    // The bug we're fixing: tapping 暗い should NOT come back with くらい as
    // the displayed headword. 暗い's entry (1154330) has rank 881; the
    // unrelated 位/「approximately」 entry (1154340) keys くらい at rank 189.
    // Looking up by EID lands in 暗い's bucket and never sees 1154340.
    stubBothIndices(
      {},
      {
        "1154330": {
          rank: 881,
          headword: "暗い",
          reading: "くらい",
          canonical: "暗い",
        },
        "1154340": {
          rank: 189,
          headword: "くらい",
          reading: null,
          canonical: "くらい",
        },
      }
    );
    const { lookupFrequencyByEntry } = await import("./frequency");
    const result = await lookupFrequencyByEntry(1154330);
    expect(result?.headword).toBe("暗い");
    expect(result?.rank).toBe(881);
  });

  it("returns null when the entry id isn't in the index", async () => {
    stubBothIndices({}, {});
    const { lookupFrequencyByEntry } = await import("./frequency");
    expect(await lookupFrequencyByEntry(9999999)).toBeNull();
  });

  it("looks up a canonical-stamp via lookupFrequencyByCanonicalSync", async () => {
    stubBothIndices(
      {},
      {
        "1223615": {
          rank: 121,
          headword: "あなた",
          reading: null,
          canonical: "貴方",
        },
      }
    );
    const {
      loadFrequencyIndex,
      lookupFrequencyByCanonicalSync,
    } = await import("./frequency");
    await loadFrequencyIndex();
    const result = lookupFrequencyByCanonicalSync("貴方");
    expect(result).toEqual({
      rank: 121,
      tier: "very-common",
      headword: "あなた",
      reading: null,
    });
  });

  it("resolves canonical-surface collisions to the lowest-rank entry", async () => {
    // 〇 is shared between まる (rank 2658 for ゼロ in JPDB), れい (12720),
    // and ゼロ (2658) — three JMdict entries with the same canonical surface.
    // The lowest-rank entry wins; subsequent encounter scoring then uses
    // that entry's resolved variant rank.
    stubBothIndices(
      {},
      {
        "1000090": { rank: 8217, headword: "丸", reading: null, canonical: "〇" },
        "1557630": { rank: 12720, headword: "零", reading: null, canonical: "〇" },
        "2839962": { rank: 2658, headword: "ゼロ", reading: null, canonical: "〇" },
      }
    );
    const {
      loadFrequencyIndex,
      lookupFrequencyByCanonicalSync,
    } = await import("./frequency");
    await loadFrequencyIndex();
    const result = lookupFrequencyByCanonicalSync("〇");
    expect(result?.rank).toBe(2658);
    expect(result?.headword).toBe("ゼロ");
  });

  it("returns null for unknown canonical surfaces", async () => {
    stubBothIndices({}, {});
    const {
      loadFrequencyIndex,
      lookupFrequencyByCanonicalSync,
    } = await import("./frequency");
    await loadFrequencyIndex();
    expect(lookupFrequencyByCanonicalSync("nonexistent")).toBeNull();
  });

  it("resolves the の particle's entry to の rather than its sK kanji form", async () => {
    // JMdict entry 1469800 (の particle) has k=[乃 sK, 之 sK], r=[の]. After
    // the sK filter in the build script, canonical/headword for this entry
    // are both 'の' — the bug was lookupFrequencyByCanonicalSync('の') missing
    // and the popover header showing 乃 from a stale (乃, の) rank.
    stubBothIndices(
      {},
      {
        "1469800": {
          rank: 1,
          headword: "の",
          reading: null,
          canonical: "の",
        },
      }
    );
    const {
      loadFrequencyIndex,
      lookupFrequencyByCanonicalSync,
    } = await import("./frequency");
    await loadFrequencyIndex();
    expect(lookupFrequencyByCanonicalSync("の")).toEqual({
      rank: 1,
      tier: "very-common",
      headword: "の",
      reading: null,
    });
    expect(lookupFrequencyByCanonicalSync("乃")).toBeNull();
  });
});

describe("getCanonicalFrequencyEntriesSync", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("flattens the by-entry index to one entry per canonical, rank-sorted", async () => {
    stubBothIndices(
      {},
      {
        "1": { rank: 300, headword: "もの", reading: null, canonical: "物" },
        "2": { rank: 100, headword: "こと", reading: null, canonical: "事" },
        "3": {
          rank: 200,
          headword: "食べる",
          reading: "たべる",
          canonical: "食べる",
        },
      }
    );
    const { loadFrequencyIndex, getCanonicalFrequencyEntriesSync } =
      await import("./frequency");
    await loadFrequencyIndex();
    expect(getCanonicalFrequencyEntriesSync()).toEqual([
      { canonical: "事", headword: "こと", reading: null, rank: 100 },
      { canonical: "食べる", headword: "食べる", reading: "たべる", rank: 200 },
      { canonical: "物", headword: "もの", reading: null, rank: 300 },
    ]);
  });

  it("keeps the canonical distinct from the display headword for uk words", async () => {
    // The browse-card bug: keying a card on the JPDB display surface (こと)
    // can't find encounters the word indexer stamped under the canonical (事).
    stubBothIndices(
      {},
      {
        "1313580": {
          rank: 79,
          headword: "こと",
          reading: null,
          canonical: "事",
        },
      }
    );
    const { loadFrequencyIndex, getCanonicalFrequencyEntriesSync } =
      await import("./frequency");
    await loadFrequencyIndex();
    expect(getCanonicalFrequencyEntriesSync()).toEqual([
      { canonical: "事", headword: "こと", reading: null, rank: 79 },
    ]);
  });

  it("collapses canonical collisions to the lowest-rank entry", async () => {
    stubBothIndices(
      {},
      {
        "1000090": { rank: 8217, headword: "丸", reading: null, canonical: "〇" },
        "2839962": {
          rank: 2658,
          headword: "ゼロ",
          reading: null,
          canonical: "〇",
        },
      }
    );
    const { loadFrequencyIndex, getCanonicalFrequencyEntriesSync } =
      await import("./frequency");
    await loadFrequencyIndex();
    expect(getCanonicalFrequencyEntriesSync()).toEqual([
      { canonical: "〇", headword: "ゼロ", reading: null, rank: 2658 },
    ]);
  });
});
