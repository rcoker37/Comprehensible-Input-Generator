import { describe, it, expect } from "vitest";
import {
  isCopulaToken,
  isProperNoun,
  verbHintAt,
  type KuromojiTokenInfo,
} from "./tokenizer";

// Build a KuromojiTokenInfo list from compact specs. `basicForm` defaults to
// the surface and `posDetail1` to "*" (kuromoji's empty marker) when omitted.
function toks(
  specs: Array<{
    surface: string;
    pos: string;
    basicForm?: string;
    posDetail1?: string;
  }>
): KuromojiTokenInfo[] {
  const out: KuromojiTokenInfo[] = [];
  let cursor = 0;
  for (const s of specs) {
    out.push({
      surface: s.surface,
      start: cursor,
      end: cursor + s.surface.length,
      pos: s.pos,
      posDetail1: s.posDetail1 ?? "*",
      basicForm: s.basicForm ?? s.surface,
    });
    cursor += s.surface.length;
  }
  return out;
}

describe("isCopulaToken", () => {
  it("flags the copula だ / です auxiliaries", () => {
    expect(
      isCopulaToken({
        surface: "だっ",
        start: 0,
        end: 2,
        pos: "助動詞",
        posDetail1: "*",
        basicForm: "だ",
      })
    ).toBe(true);
    expect(
      isCopulaToken({
        surface: "です",
        start: 0,
        end: 2,
        pos: "助動詞",
        posDetail1: "*",
        basicForm: "です",
      })
    ).toBe(true);
  });

  it("rejects verb-conjugation auxiliaries and non-助動詞 tokens", () => {
    for (const basicForm of ["た", "ます", "ない"]) {
      expect(
        isCopulaToken({
          surface: basicForm,
          start: 0,
          end: 1,
          pos: "助動詞",
          posDetail1: "*",
          basicForm,
        })
      ).toBe(false);
    }
    expect(
      isCopulaToken({
        surface: "だ",
        start: 0,
        end: 1,
        pos: "名詞",
        posDetail1: "*",
        basicForm: "だ",
      })
    ).toBe(false);
    expect(isCopulaToken(undefined)).toBe(false);
  });
});

describe("isProperNoun", () => {
  it("flags a 名詞・固有名詞 token", () => {
    const [yamate] = toks([
      { surface: "山手", pos: "名詞", posDetail1: "固有名詞" },
    ]);
    expect(isProperNoun(yamate)).toBe(true);
  });

  it("rejects ordinary nouns and non-名詞 tokens", () => {
    const [futsuu, ga] = toks([
      { surface: "普通", pos: "名詞", posDetail1: "一般" },
      { surface: "が", pos: "助詞", posDetail1: "固有名詞" },
    ]);
    expect(isProperNoun(futsuu)).toBe(false);
    expect(isProperNoun(ga)).toBe(false);
    expect(isProperNoun(undefined)).toBe(false);
  });
});

describe("verbHintAt", () => {
  it("drops the 動詞 hint for a 連用形 noun before the copula (終わり + だった)", () => {
    // 物語 / の / 終わり / だっ / た
    const tokens = toks([
      { surface: "物語", pos: "名詞" },
      { surface: "の", pos: "助詞" },
      { surface: "終わり", pos: "動詞", basicForm: "終わる" },
      { surface: "だっ", pos: "助動詞", basicForm: "だ" },
      { surface: "た", pos: "助動詞", basicForm: "た" },
    ]);
    expect(verbHintAt(tokens, 2)).toBeUndefined();
  });

  it("keeps the 動詞 hint when a verb-conjugation aux follows (終わり + ます)", () => {
    const tokens = toks([
      { surface: "終わり", pos: "動詞", basicForm: "終わる" },
      { surface: "ます", pos: "助動詞", basicForm: "ます" },
    ]);
    expect(verbHintAt(tokens, 0)).toBe("動詞");
  });

  it("keeps the 動詞 hint for a continuative verb before a comma", () => {
    const tokens = toks([
      { surface: "なり", pos: "動詞", basicForm: "なる" },
      { surface: "、", pos: "記号" },
    ]);
    expect(verbHintAt(tokens, 0)).toBe("動詞");
  });

  it("passes through non-動詞 POS unchanged, even before the copula", () => {
    const tokens = toks([
      { surface: "本当", pos: "名詞" },
      { surface: "だ", pos: "助動詞", basicForm: "だ" },
    ]);
    expect(verbHintAt(tokens, 0)).toBe("名詞");
  });

  it("returns undefined for an out-of-range index", () => {
    expect(verbHintAt(toks([{ surface: "あ", pos: "名詞" }]), 5)).toBeUndefined();
  });
});
