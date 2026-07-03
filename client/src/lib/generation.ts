import type { Formality, StoryContentType } from "../types";

/**
 * Paragraph count options surfaced in the Generator modal. 3 is the default;
 * the upper bound is a soft cap on how much text the model is asked to
 * produce in one shot.
 */
export const PARAGRAPH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const DEFAULT_PARAGRAPH_COUNT = 3;

/**
 * The model every client-initiated generation requests. Must stay within the
 * `ALLOWED_MODELS` allow-list in `supabase/functions/generate-story/index.ts`.
 */
export const GENERATION_MODEL = "anthropic/claude-fable-5";

export const FORMALITY_INSTRUCTIONS: Record<Formality, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

const CONTENT_TYPE_PREAMBLE: Record<StoryContentType, string> = {
  fiction: "You are a Japanese language teacher writing a short story for a student learning Japanese.",
  nonfiction: "You are a Japanese language teacher writing a short non-fiction, factual, educational essay for a student learning Japanese. The essay should present accurate information on a real-world topic in an informative, expository style — not a personal narrative or fictional piece.",
};

const CONTENT_TYPE_TOPIC_LABEL: Record<StoryContentType, string> = {
  fiction: "The story should be about",
  nonfiction: "The essay should be about",
};

const paragraphInstruction = (n: number) =>
  `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`;

// Rules shared between the topic/style prompt and the learn-word prompt.
const RULE_USE_KANJI =
  "- Actively use allowed kanji throughout — do not write entirely in hiragana.";
const RULE_STANDARD_SPELLING =
  "- Write every word in its standard modern spelling, with every kanji that spelling uses. Do not substitute kana for a word's kanji — not the whole word when it is normally written with kanji (法律《ほうりつ》, never ほうりつ), and not part of it (法律《ほうりつ》, never 法《ほう》りつ; 医療《いりょう》, never 医《い》りょう). Ordinary okurigana — the べる of 食べる, the しい of 新しい — is part of the standard spelling, not a substitution, so keep it. When a word has more than one kanji form, use the common form rather than a rare or archaic one.";
const RULE_CHOSEN_WORD_KANJI =
  "- Once you choose to use a word, all of its kanji are allowed: the kanji groups above limit which words you reach for, not how you spell a word you have already chosen.";
const RULE_RUBY =
  "- For EVERY run of kanji in the output, attach its reading in hiragana immediately after using full-width angle brackets 《…》. Use strict Aozora Bunko ruby notation: the reading covers ONLY the kanji run itself, not any okurigana or particles. Examples: 二人《ふたり》は公園《こうえん》で行《おこな》われた大会《たいかい》を見《み》た。先生《せんせい》は学生《がくせい》に話《はな》しました。新《あたら》しい本《ほん》を読《よ》みました。Annotate every kanji run, even common ones. Do NOT use the pipe character.";
const OUTPUT_FOOTER =
  "Output ONLY the final content in Japanese. Start with a short title on the first line — plain text, no leading # or other markdown headings. Do not use markdown formatting of any kind (no #, **, _, -, >, backticks). Absolutely no English in the output: no explanations, no translations, no self-corrections, no meta-commentary. If you realize a kanji is not in the allowed list, silently rewrite with simpler vocabulary or keep the word and write it fully in kanji — do NOT narrate the correction. Any English sentence in the output is a failure.";

function sanitizeUserText(raw: string): string {
  return raw.replace(/[\n\r#`]/g, "").trim();
}

export function buildPrompt(
  contentType: StoryContentType,
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  topic?: string,
  style?: string
): string {
  const parts = [
    CONTENT_TYPE_PREAMBLE[contentType],
    "",
    `Allowed kanji: ${kanjiList}`,
    "Rules:",
    "- Keep the kanji you use within these groups: (1) kanji from the allowed list above; (2) kanji and vocabulary that the chosen topic or writing style naturally calls for — domain-specific terms, characteristic expressions, and the words a piece on this subject genuinely lives on. Outside these groups, prefer simpler wording over reaching for another kanji.",
    "- When a topic or writing style is provided, lean into the concrete vocabulary and kanji that anchor a piece in that subject or voice — reach for the topical words rather than paraphrasing around them with generic language. Treat group (2) as an invitation, not just permission.",
    RULE_USE_KANJI,
    RULE_STANDARD_SPELLING,
    RULE_CHOSEN_WORD_KANJI,
    RULE_RUBY,
    "",
    FORMALITY_INSTRUCTIONS[formality],
  ];

  if (topic) {
    parts.push("", `${CONTENT_TYPE_TOPIC_LABEL[contentType]}: ${sanitizeUserText(topic)}`);
  }

  if (style) {
    parts.push("", `Writing style: ${sanitizeUserText(style)}`);
  }

  parts.push("", paragraphInstruction(paragraphs), "", OUTPUT_FOOTER);

  return parts.join("\n");
}

/**
 * Prompt for a "Learn Word" generation: a short lesson, in Japanese, that
 * teaches a single vocabulary word. The kanji-scope rule is stricter than
 * the story prompt's — there is no open-ended topical group, only the
 * allowed list plus the target word's own kanji.
 */
export function buildLearnWordPrompt(
  targetWord: string,
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  reading?: string | null
): string {
  const word = sanitizeUserText(targetWord);
  // The reading pins the right homograph (辛い is からい or つらい — two
  // different words). Omitted when it adds nothing (kana-only headwords).
  const readingNote =
    reading && reading !== word ? `（${sanitizeUserText(reading)}）` : "";
  return [
    "You are a Japanese language teacher writing a short lesson, entirely in Japanese, that teaches a student one vocabulary word.",
    "",
    `The word to teach: 「${word}」${readingNote}`,
    "",
    `Allowed kanji: ${kanjiList}`,
    "Rules:",
    `- Explain what 「${word}」 means and how it is used: its nuance, the situations it fits, words and phrases it commonly appears with, and how it differs from near-synonyms the student may confuse it with. Weave several example sentences naturally into the paragraphs, and use 「${word}」 itself repeatedly so the student sees it in varied contexts.`,
    `- Keep the kanji you use within these groups: (1) kanji from the allowed list above; (2) the kanji of 「${word}」 itself. This restriction is strict — outside these two groups, do not reach for other kanji; rewrite with simpler words instead.`,
    RULE_USE_KANJI,
    RULE_STANDARD_SPELLING,
    RULE_CHOSEN_WORD_KANJI,
    RULE_RUBY,
    "",
    FORMALITY_INSTRUCTIONS[formality],
    "",
    paragraphInstruction(paragraphs),
    "",
    `${OUTPUT_FOOTER} The title on the first line should contain 「${word}」.`,
  ].join("\n");
}
