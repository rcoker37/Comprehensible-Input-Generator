import type { Formality } from "../types/index.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "gemma4:26b";

const FORMALITY_INSTRUCTIONS: Record<Formality, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

const GRAMMAR_GUIDANCE: Record<number, string> = {
  5: "Use only basic grammar: て-form, ます-form, basic particles (は, が, を, に, で, へ), です/だ, simple adjectives.",
  4: "Use up to JLPT N4 grammar: conditionals (たら/ば), passive basics, てある/ている, たい-form, ～ことができる.",
  3: "Use up to JLPT N3 grammar: causative, passive, compound sentences, ようにする, ～ために, ～ことにする.",
  2: "You may use advanced grammar freely.",
  1: "You may use advanced grammar freely.",
};

export interface GenerateOptions {
  paragraphs: number;
  topic?: string;
  formality: Formality;
  allowedKanji: string[];
  grammarLevel: number;
}

export async function generateStory(
  options: GenerateOptions
): Promise<string> {
  const { paragraphs, topic, formality, allowedKanji, grammarLevel } = options;

  const kanjiList = allowedKanji.join("");

  const prompt = buildPrompt(
    paragraphs,
    kanjiList,
    formality,
    grammarLevel,
    topic
  );

  console.log("[ollama] === FULL PROMPT ===");
  console.log(prompt);
  console.log("[ollama] === END PROMPT ===");
  console.log(`[ollama] Prompt length: ${prompt.length} chars, Allowed kanji count: ${allowedKanji.length}`);

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: 4096, num_ctx: 128000 },
      think: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("[ollama] Error response:", body);
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  console.log("[ollama] === RAW JSON (first 2000 chars) ===");
  console.log(raw.slice(0, 2000));
  console.log("[ollama] === END RAW ===");

  const data = JSON.parse(raw) as Record<string, unknown>;
  console.log("[ollama] Keys:", Object.keys(data));
  console.log("[ollama] response type:", typeof data.response);
  console.log("[ollama] response value:", JSON.stringify(data.response));
  console.log("[ollama] done:", data.done, "done_reason:", data.done_reason);

  return String(data.response || "").trim();

  return data.response.trim();
}

export async function retryWithFeedback(
  options: GenerateOptions,
  violations: string[]
): Promise<string> {
  const { paragraphs, topic, formality, allowedKanji, grammarLevel } = options;

  const kanjiList = allowedKanji.join("");
  const basePrompt = buildPrompt(
    paragraphs,
    kanjiList,
    formality,
    grammarLevel,
    topic
  );

  const prompt = `${basePrompt}

IMPORTANT CORRECTION: Your previous story contained these disallowed kanji: ${violations.join(", ")}. You MUST NOT use these characters. Rewrite without them. Only use kanji from the allowed list.`;

  console.log("[ollama] Retry prompt:\n", prompt.slice(0, 300), "...");

  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.5, num_predict: 4096, num_ctx: 128000 },
      think: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("[ollama] Retry error response:", body);
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  console.log("[ollama] Retry raw response length:", raw.length);
  console.log("[ollama] Retry response (first 500 chars):", raw.slice(0, 500));

  const data = JSON.parse(raw) as { response: string; done: boolean };
  return data.response.trim();
}

function buildPrompt(
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  grammarLevel: number,
  topic?: string
): string {
  const parts = [
    "You are a Japanese language teacher writing a short story for a student learning Japanese.",
    "",
    `CRITICAL RULE: You MUST only use the following kanji characters: ${kanjiList}`,
    "You may freely use hiragana and katakana. Do NOT use any kanji not in the list above.",
    "",
    GRAMMAR_GUIDANCE[grammarLevel] || GRAMMAR_GUIDANCE[2],
    "",
    FORMALITY_INSTRUCTIONS[formality],
  ];

  if (topic) {
    parts.push("", `The story should be about: ${topic}`);
  }

  parts.push(
    "",
    `Write exactly ${paragraphs} paragraphs.`,
    "",
    "Output ONLY the story in Japanese. Start with a short title on the first line. Do not include any English text, explanations, or translations."
  );

  return parts.join("\n");
}
