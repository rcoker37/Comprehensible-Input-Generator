import { describe, it, expect } from "vitest";
import { getTopRareKanji } from "./rareKanji";
import type { Kanji } from "../types";

function k(character: string, grade: number): Kanji {
  return {
    character,
    grade,
    jlpt: null,
    meanings: "",
    readings_on: "",
    readings_kun: "",
  };
}

describe("getTopRareKanji", () => {
  it("sorts by exposure ascending, then grade descending, then character", () => {
    const all = [k("人", 1), k("水", 1), k("湖", 8), k("駅", 3)];
    const allowed = new Set(["人", "水", "湖", "駅"]);
    const exposures = new Map([
      ["人", 10],
      ["水", 5],
      ["湖", 0],
      ["駅", 0],
    ]);
    expect(getTopRareKanji(all, allowed, exposures, 10)).toEqual([
      "湖", // 0 exposure, grade 8
      "駅", // 0 exposure, grade 3
      "水", // 5 exposures
      "人", // 10 exposures
    ]);
  });

  it("treats unseen kanji (missing from exposures) as zero exposure", () => {
    const all = [k("湖", 8), k("人", 1)];
    const allowed = new Set(["湖", "人"]);
    const exposures = new Map([["人", 100]]);
    expect(getTopRareKanji(all, allowed, exposures, 10)).toEqual(["湖", "人"]);
  });

  it("filters to the allowed set", () => {
    const all = [k("人", 1), k("駅", 3), k("湖", 8)];
    const allowed = new Set(["人", "駅"]); // 湖 not allowed
    expect(getTopRareKanji(all, allowed, new Map(), 10)).toEqual(["駅", "人"]);
  });

  it("caps the result at limit", () => {
    const all = [k("人", 1), k("水", 1), k("駅", 3), k("湖", 8)];
    const allowed = new Set(["人", "水", "駅", "湖"]);
    expect(getTopRareKanji(all, allowed, new Map(), 2)).toEqual(["湖", "駅"]);
  });

  it("returns an empty array when the allowed set is empty", () => {
    expect(getTopRareKanji([k("人", 1)], new Set(), new Map(), 10)).toEqual([]);
  });
});
