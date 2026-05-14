import type { ContentType, Formality } from "../types";

export const FORMALITY_INSTRUCTIONS: Record<Formality, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

const CONTENT_TYPE_PREAMBLE: Record<ContentType, string> = {
  fiction: "You are a Japanese language teacher writing a short story for a student learning Japanese.",
  nonfiction: "You are a Japanese language teacher writing a short non-fiction, factual, educational essay for a student learning Japanese. The essay should present accurate information on a real-world topic in an informative, expository style — not a personal narrative or fictional piece.",
};

const CONTENT_TYPE_LENGTH: Record<ContentType, (n: number) => string> = {
  fiction: (n) => `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`,
  nonfiction: (n) => `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`,
};

const CONTENT_TYPE_TOPIC_LABEL: Record<ContentType, string> = {
  fiction: "The story should be about",
  nonfiction: "The essay should be about",
};

function sanitizeUserText(raw: string): string {
  return raw.replace(/[\n\r#`]/g, "").trim();
}

export type UnseenKanjiTarget = "none" | "1-2" | "3-5" | "5-10";

const UNSEEN_KANJI_RANGES: Record<UnseenKanjiTarget, [number, number] | null> = {
  none: null,
  "1-2": [1, 2],
  "3-5": [3, 5],
  "5-10": [5, 10],
};

export function buildPrompt(
  contentType: ContentType,
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  topic?: string,
  style?: string,
  unseenKanjiTarget: UnseenKanjiTarget = "none"
): string {
  const range = UNSEEN_KANJI_RANGES[unseenKanjiTarget];
  const rules: string[] = ["Rules:"];

  if (range) {
    const [min, max] = range;
    rules.push(
      `- Include ${min}–${max} unique kanji that are NOT in the allowed list ("stretch kanji"). Pick ones natural to the topic; weave them in normally.`,
      "- Actively use allowed kanji throughout — do not write entirely in hiragana.",
      "- Beyond those stretch kanji, only use kanji from the allowed list. If a word would need a non-allowed, non-stretch kanji, rephrase with simpler vocabulary rather than writing it in hiragana."
    );
  } else {
    rules.push(
      "- Try to only use kanji from the list above, minimizing usage of kanji not in the list. Use hiragana and katakana freely.",
      "- Actively use allowed kanji throughout — do not write entirely in hiragana.",
      "- If a word needs kanji not in the list, rephrase with simpler vocabulary rather than writing it in hiragana."
    );
  }

  rules.push(
    "- For EVERY run of kanji in the output, attach its reading in hiragana immediately after using full-width angle brackets 《…》. Use strict Aozora Bunko ruby notation: the reading covers ONLY the kanji run itself, not any okurigana or particles. Examples: 二人《ふたり》は公園《こうえん》で行《おこな》われた大会《たいかい》を見《み》た。先生《せんせい》は学生《がくせい》に話《はな》しました。新《あたら》しい本《ほん》を読《よ》みました。Annotate every kanji run, even common ones. Do NOT use the pipe character."
  );

  const parts = [
    CONTENT_TYPE_PREAMBLE[contentType],
    "",
    `Allowed kanji: ${kanjiList}`,
    ...rules,
    "",
    FORMALITY_INSTRUCTIONS[formality],
  ];

  if (topic) {
    parts.push("", `${CONTENT_TYPE_TOPIC_LABEL[contentType]}: ${sanitizeUserText(topic)}`);
  }

  if (style) {
    parts.push("", `Writing style: ${sanitizeUserText(style)}`);
  }

  parts.push(
    "",
    CONTENT_TYPE_LENGTH[contentType](paragraphs),
    "",
    "Output ONLY the final content in Japanese. Start with a short title on the first line — plain text, no leading # or other markdown headings. Do not use markdown formatting of any kind (no #, **, _, -, >, backticks). Absolutely no English in the output: no explanations, no translations, no self-corrections, no meta-commentary. If you realize a kanji is not in the allowed list, silently rewrite with simpler vocabulary — do NOT narrate the correction. Any English sentence in the output is a failure."
  );

  return parts.join("\n");
}
