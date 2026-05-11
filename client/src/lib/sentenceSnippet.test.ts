import { describe, expect, it } from "vitest";
import { extractSentenceSnippet } from "./sentenceSnippet";
import { parseAnnotatedText } from "./furigana";

function parse(raw: string) {
  return parseAnnotatedText(raw);
}

describe("extractSentenceSnippet", () => {
  it("isolates the sentence containing the span", () => {
    const { cleanText, annotations } = parse("これは一つ目の文。次の文だ。最後の文。");
    // Span on 「次」 (offset 9) in the middle sentence.
    const snippet = extractSentenceSnippet(cleanText, annotations, 9, 10);
    expect(snippet).not.toBeNull();
    expect(snippet!.text).toBe("次の文だ。");
    expect(snippet!.text.slice(snippet!.surfaceStart, snippet!.surfaceEnd)).toBe("次");
  });

  it("rebases annotations to the snippet", () => {
    const { cleanText, annotations } = parse(
      "これは前。日本《にほん》は国だ。これは後。"
    );
    // Find offset of 「日」 in cleanText (after 「これは前。」)
    const nihonOffset = cleanText.indexOf("日本");
    const snippet = extractSentenceSnippet(
      cleanText,
      annotations,
      nihonOffset,
      nihonOffset + 2
    );
    expect(snippet).not.toBeNull();
    expect(snippet!.text).toBe("日本は国だ。");
    expect(snippet!.annotations).toHaveLength(1);
    expect(snippet!.annotations[0]).toEqual({
      start: 0,
      end: 2,
      reading: "にほん",
    });
    expect(snippet!.surfaceStart).toBe(0);
    expect(snippet!.surfaceEnd).toBe(2);
  });

  it("handles the first sentence (no leading text)", () => {
    const { cleanText, annotations } = parse("最初の文。次の文。");
    const snippet = extractSentenceSnippet(cleanText, annotations, 0, 2);
    expect(snippet).not.toBeNull();
    expect(snippet!.text).toBe("最初の文。");
    expect(snippet!.surfaceStart).toBe(0);
    expect(snippet!.surfaceEnd).toBe(2);
  });

  it("preserves trailing closer characters in the sentence", () => {
    const { cleanText, annotations } = parse("彼は「やめろ。」と言った。");
    // 「やめろ。」 is one sentence including the closer 」.
    const yameroOffset = cleanText.indexOf("やめろ");
    const snippet = extractSentenceSnippet(
      cleanText,
      annotations,
      yameroOffset,
      yameroOffset + 3
    );
    expect(snippet).not.toBeNull();
    // Note the storySegments rule: the 」 closer doesn't trigger a new
    // sentence, so it stays attached to the closing-punctuation sentence.
    expect(snippet!.text.endsWith("」")).toBe(true);
  });

  it("returns null for out-of-range spans", () => {
    const { cleanText, annotations } = parse("短い文。");
    expect(extractSentenceSnippet(cleanText, annotations, -1, 1)).toBeNull();
    expect(extractSentenceSnippet(cleanText, annotations, 0, 0)).toBeNull();
    expect(extractSentenceSnippet(cleanText, annotations, 0, 100)).toBeNull();
  });

  it("isolates a sentence in a multi-paragraph story", () => {
    const { cleanText, annotations } = parse(
      "段落一の文一。段落一の文二。\n\n段落二の文一。段落二の文二。"
    );
    const targetOffset = cleanText.indexOf("段落二の文二");
    const snippet = extractSentenceSnippet(
      cleanText,
      annotations,
      targetOffset,
      targetOffset + 6
    );
    expect(snippet).not.toBeNull();
    expect(snippet!.text).toBe("段落二の文二。");
  });
});
