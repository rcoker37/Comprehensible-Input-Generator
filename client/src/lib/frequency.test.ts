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
    expect(result).toEqual({ rank: 32269, tier: "very-rare" });
  });

  it("returns very-rare when no candidate is in the index", async () => {
    stubIndex({ "別の語": [["べつのご", 5000]] });
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency(["御供え"], "おそなえ");
    expect(result).toEqual({ rank: null, tier: "very-rare" });
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
    expect(result).toEqual({ rank: 121, tier: "very-common" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns very-rare when no candidates are supplied", async () => {
    stubIndex({});
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency([], "おそなえ");
    expect(result).toEqual({ rank: null, tier: "very-rare" });
  });

  it("prefers a common kana variant over the canonical kanji form", async () => {
    stubIndex({
      "貴方": [["あなた", 3151]],
      "あなた": [[null, 121]],
    });
    const { lookupBestFrequency } = await import("./frequency");
    const result = await lookupBestFrequency(["貴方", "あなた"], "あなた");
    expect(result).toEqual({ rank: 121, tier: "very-common" });
  });
});
