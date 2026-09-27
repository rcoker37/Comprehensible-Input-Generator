import { describe, expect, it } from "vitest";
import { findIPlusOneSentences } from "./iPlusOne";
import { buildDisplaySegments } from "./storySegments";
import { sentenceCardKey } from "./sentenceCardKey";
import { extractSentenceSnippet } from "./sentenceSnippet";
import { WELL_KNOWN_MIN } from "./comprehensibility";

const ranks: Record<string, number> = { 猫: 1000, 跳躍: 10000, 静寂: 18000, 深淵: 18001 };
const getRank = (word: string) => ranks[word] ?? null;

function check(
  text: string, seen: Record<string, number> = {}, names: string[] = [],
  hasReviewCard?: (start: number, end: number) => boolean
) {
  const occurrences = [...text.matchAll(/猫|跳躍|静寂|深淵|未知|太郎/g)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    surface: m[0],
    headword: m[0],
    isName: names.includes(m[0]),
  }));
  return findIPlusOneSentences(
    buildDisplaySegments(text, []), occurrences, new Map(Object.entries(seen)), getRank, 6000, hasReviewCard
  );
}

describe("i+1 sentences", () => {
  it("finds one unseen stretch word among words treated as familiar", () => {
    expect([...check("猫、跳躍。")]).toEqual([[0, "跳躍"]]);
    expect([...check("未知、跳躍。", { 未知: WELL_KNOWN_MIN })]).toEqual([[0, "跳躍"]]);
  });

  it("does not mark fully familiar or empty sentences", () => {
    expect(check("猫。").size).toBe(0);
    expect(check("跳躍。", { 跳躍: WELL_KNOWN_MIN }).size).toBe(0);
    expect(check("。\n\n！").size).toBe(0);
    expect(check("").size).toBe(0);
  });

  it("counts repeated appearances of one headword only once", () => {
    expect([...check("猫、跳躍、跳躍。")]).toEqual([[0, "跳躍"]]);
  });

  it("rejects two distinct unfamiliar words", () => {
    expect(check("跳躍、静寂。").size).toBe(0);
  });

  it("includes the reach ceiling but rejects rarer and unranked new words", () => {
    expect([...check("猫、静寂。")]).toEqual([[0, "静寂"]]);
    expect(check("猫、深淵。").size).toBe(0);
    expect(check("猫、未知。").size).toBe(0);
    expect(check("跳躍、未知。").size).toBe(0);
  });

  it("does not mistake still-learning words for known background vocabulary", () => {
    expect(check("跳躍。", { 跳躍: 1 }).size).toBe(0);
    expect(check("跳躍、静寂。", { 静寂: WELL_KNOWN_MIN - 1 }).size).toBe(0);
    expect([...check("跳躍、静寂。", { 静寂: WELL_KNOWN_MIN })]).toEqual([[0, "跳躍"]]);
  });

  it("ignores proper names", () => {
    expect([...check("太郎、跳躍。", {}, ["太郎"])]).toEqual([[0, "跳躍"]]);
    expect(check("太郎。", {}, ["太郎"]).size).toBe(0);
  });

  it("keeps sentence offsets aligned across quotes, paragraphs, and newlines", () => {
    const text = "「猫、跳躍。」猫。\n\n静寂。\n深淵。";
    expect([...check(text)]).toEqual([[0, "跳躍"], [text.indexOf("静寂"), "静寂"]]);
  });

  it("excludes saved review sentences and restores them when their card is deleted", () => {
    const text = "「猫、跳躍。」\n\n猫、静寂。";
    const snippet = extractSentenceSnippet(text, [], text.indexOf("跳躍"), text.indexOf("跳躍") + 2)!;
    const source = { kind: "story", storyId: 12 } as const;
    const key = sentenceCardKey(source, snippet.sentenceStart, snippet.sentenceEnd);
    const cards = new Set<string>();
    const hasCard = (start: number, end: number) => cards.has(sentenceCardKey(source, start, end));
    const initial = [...check(text, {}, [], hasCard)];
    expect(initial).toEqual([[0, "跳躍"], [text.indexOf("猫、静寂"), "静寂"]]);
    cards.add(key);
    expect([...check(text, {}, [], hasCard)]).toEqual([initial[1]]);
    cards.delete(key);
    expect([...check(text, {}, [], hasCard)]).toEqual(initial);
  });

  it("does not exclude matching offsets in another story or a different sentence range", () => {
    const text = "猫、跳躍。";
    const cards = new Set([
      sentenceCardKey({ kind: "story", storyId: 13 }, 0, text.length),
      sentenceCardKey({ kind: "story", storyId: 12 }, 0, text.length - 1),
    ]);
    expect([...check(text, {}, [], (start, end) =>
      cards.has(sentenceCardKey({ kind: "story", storyId: 12 }, start, end))
    )]).toEqual([[0, "跳躍"]]);
  });

  it("deduplicates inflected surfaces by their indexed headword", () => {
    const text = "跳んだ、跳ぶ。";
    const occurrences = [
      { start: 0, end: 3, surface: "跳んだ", headword: "跳ぶ", isName: false },
      { start: 4, end: 6, surface: "跳ぶ", headword: "跳ぶ", isName: false },
    ];
    expect([...findIPlusOneSentences(buildDisplaySegments(text, []), occurrences.reverse(), new Map(), () => 10000, 6000)])
      .toEqual([[0, "跳ぶ"]]);
  });
});
