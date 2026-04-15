import { KANJI_REGEX_G } from "./constants";
import type { ContentType, Formality } from "../types";

export const FORMALITY_INSTRUCTIONS: Record<Formality, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

export const GRAMMAR_GUIDANCE: Record<number, string> = {
  5: "Use only basic grammar: て-form, ます-form, basic particles (は, が, を, に, で, へ), です/だ, simple adjectives.",
  4: "Use up to JLPT N4 grammar: conditionals (たら/ば), passive basics, てある/ている, たい-form, ～ことができる.",
  3: "Use up to JLPT N3 grammar: causative, passive, compound sentences, ようにする, ～ために, ～ことにする.",
  2: "Use up to JLPT N2 grammar: ～わけではない, ～に対して, ～ことから, ～一方で, ～とは限らない, formal conjunctions (したがって, それにもかかわらず).",
  1: "You may use any grammar freely, including literary and classical forms.",
};

const CONTENT_TYPE_PREAMBLE: Record<ContentType, string> = {
  story: "You are a Japanese language teacher writing a short story for a student learning Japanese.",
  dialogue: "You are a Japanese language teacher writing a dialogue between two characters for a student learning Japanese.",
  essay: "You are a Japanese language teacher writing a short essay for a student learning Japanese.",
};

const CONTENT_TYPE_LENGTH: Record<ContentType, (n: number) => string> = {
  story: (n) => `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`,
  dialogue: (n) => `Write exactly ${n} exchanges. Each exchange is one back-and-forth between two characters (two lines). Format each line as 「Name：dialogue」 with brief scene or action descriptions between exchanges where natural.`,
  essay: (n) => `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`,
};

const CONTENT_TYPE_TOPIC_LABEL: Record<ContentType, string> = {
  story: "The story should be about",
  dialogue: "The dialogue should be about",
  essay: "The essay should be about",
};

function sanitizeTopic(raw: string): string {
  return raw.replace(/[\n\r#`]/g, "").trim();
}

export function buildPrompt(
  contentType: ContentType,
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  grammarLevel: number,
  topic?: string
): string {
  const parts = [
    CONTENT_TYPE_PREAMBLE[contentType],
    "",
    `Allowed kanji: ${kanjiList}`,
    "Rules:",
    "- Try to only use kanji from the list above, minimizing usage of kanji not in the list. Use hiragana and katakana freely.",
    "- Actively use allowed kanji throughout — do not write entirely in hiragana.",
    "- If a word needs kanji not in the list, rephrase with simpler vocabulary rather than writing it in hiragana.",
    "- For EVERY run of kanji in the output, attach its reading in hiragana immediately after using full-width angle brackets 《…》. Use strict Aozora Bunko ruby notation: the reading covers ONLY the kanji run itself, not any okurigana or particles. Examples: 二人《ふたり》は公園《こうえん》で行《おこな》われた大会《たいかい》を見《み》た。先生《せんせい》は学生《がくせい》に話《はな》しました。新《あたら》しい本《ほん》を読《よ》みました。Annotate every kanji run, even common ones. Do NOT use the pipe character.",
    "",
    GRAMMAR_GUIDANCE[grammarLevel] || GRAMMAR_GUIDANCE[2],
    "",
    FORMALITY_INSTRUCTIONS[formality],
  ];

  if (topic) {
    parts.push("", `${CONTENT_TYPE_TOPIC_LABEL[contentType]}: ${sanitizeTopic(topic)}`);
  }

  parts.push(
    "",
    CONTENT_TYPE_LENGTH[contentType](paragraphs),
    "",
    "Output ONLY the content in Japanese. Start with a short title on the first line — plain text, no leading # or other markdown headings. Do not use markdown formatting of any kind (no #, **, _, -, >, backticks). Do not include any English text, explanations, or translations."
  );

  return parts.join("\n");
}

export function computeDifficulty(
  text: string,
  kanjiMeta: Map<string, { grade: number; jlpt: number | null }>
) {
  const usedKanji = [...new Set(text.match(KANJI_REGEX_G) || [])];
  if (usedKanji.length === 0) {
    return { uniqueKanji: 0, grade: { max: 0, avg: 0 }, jlpt: { min: 0, avg: 0 } };
  }
  const rows = usedKanji.map((k) => kanjiMeta.get(k)).filter((r) => r != null);
  const grades = rows.map((r) => r.grade);
  const jlpts = rows.filter((r) => r.jlpt != null).map((r) => r.jlpt!);
  return {
    uniqueKanji: usedKanji.length,
    grade: {
      max: grades.length > 0 ? Math.max(...grades) : 0,
      avg: grades.length > 0 ? Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 10) / 10 : 0,
    },
    jlpt: {
      min: jlpts.length > 0 ? Math.min(...jlpts) : 0,
      avg: jlpts.length > 0 ? Math.round((jlpts.reduce((a, b) => a + b, 0) / jlpts.length) * 10) / 10 : 0,
    },
  };
}
