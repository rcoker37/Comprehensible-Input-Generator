import type { ContentType, Formality } from "../types";

/**
 * Every generated story is fixed at this many paragraphs. The count is no
 * longer user-selectable; `buildPrompt` still takes it as a parameter so the
 * value stays explicit at the call site.
 */
export const PARAGRAPH_COUNT = 3;

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

export type UnseenWordTarget = "none" | "1-2" | "3-5" | "5-10";

const UNSEEN_WORD_RANGES: Record<UnseenWordTarget, [number, number] | null> = {
  none: null,
  "1-2": [1, 2],
  "3-5": [3, 5],
  "5-10": [5, 10],
};

/**
 * How many of the user's most-frequent never-encountered words to hand the
 * model as a candidate pool. The model is nudged to weave a few of them in
 * (see `UNSEEN_WORD_RANGES`); the rest of the pool is just there for choice.
 */
export const UNSEEN_WORD_POOL_SIZE = 50;

export function buildPrompt(
  contentType: ContentType,
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  topic?: string,
  style?: string,
  unseenWordTarget: UnseenWordTarget = "none",
  unseenWords: string[] = []
): string {
  const wordRange = UNSEEN_WORD_RANGES[unseenWordTarget];
  const hasUnseenWords = wordRange != null && unseenWords.length > 0;
  const rules: string[] = ["Rules:"];

  // Kanji scope is loosened to three groups rather than a hard "allowed list
  // only" constraint: the allowed list, kanji carried by the unseen common
  // words we nudge in, and kanji the chosen topic / style genuinely needs.
  // Group 2 is only described when an unseen-words pool is actually supplied.
  const kanjiGroups = [
    "kanji from the allowed list above",
    ...(hasUnseenWords
      ? ["kanji that appear in the unseen common words listed below"]
      : []),
    "kanji genuinely needed for the topic, the writing style, or vocabulary that naturally belongs in this piece",
  ];
  rules.push(
    `- Keep the kanji you use within these groups: ${kanjiGroups
      .map((g, i) => `(${i + 1}) ${g}`)
      .join("; ")}. Outside these groups, prefer simpler wording over reaching for another kanji.`,
    "- Actively use allowed kanji throughout — do not write entirely in hiragana.",
    "- Write every word in its standard modern spelling, with every kanji that spelling uses. Do not substitute kana for a word's kanji — not the whole word when it is normally written with kanji (法律《ほうりつ》, never ほうりつ), and not part of it (法律《ほうりつ》, never 法《ほう》りつ; 医療《いりょう》, never 医《い》りょう). Ordinary okurigana — the べる of 食べる, the しい of 新しい — is part of the standard spelling, not a substitution, so keep it. When a word has more than one kanji form, use the common form rather than a rare or archaic one.",
    "- Once you choose to use a word, all of its kanji are allowed: the kanji groups above limit which words you reach for, not how you spell a word you have already chosen."
  );

  if (wordRange && unseenWords.length > 0) {
    const [min, max] = wordRange;
    rules.push(
      `- Naturally use ${min}–${max} of these common words the reader has not encountered yet, choosing ones that fit the topic and weaving them in normally (do not list them mechanically): ${unseenWords.join("、")}.`,
      "- Those words are only a nudge — keep introducing plenty of other vocabulary the reader likely hasn't seen too; that list is not meant to be the only unfamiliar words in the piece."
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
    "Output ONLY the final content in Japanese. Start with a short title on the first line — plain text, no leading # or other markdown headings. Do not use markdown formatting of any kind (no #, **, _, -, >, backticks). Absolutely no English in the output: no explanations, no translations, no self-corrections, no meta-commentary. If you realize a kanji is not in the allowed list, silently rewrite with simpler vocabulary or keep the word and write it fully in kanji — do NOT narrate the correction. Any English sentence in the output is a failure."
  );

  return parts.join("\n");
}
