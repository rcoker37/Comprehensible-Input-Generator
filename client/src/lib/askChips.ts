export type AskChip = { id: string; label: string; prompt: string };

export const ASK_CHIPS: readonly AskChip[] = [
  {
    id: "meaning-in-context",
    label: "Meaning in Context",
    prompt:
      "Give a short English gloss of this word, then explain how this sentence narrows or shades that meaning.",
  },
  {
    id: "alternatives",
    label: "Alternatives",
    prompt:
      "Give a numbered list of exactly 5 word choices that could fill this position in the sentence. Item 1 is the original word — explain its specific nuance in this context. Items 2–5 are alternate words that would also fit; for each, explain how using it would shift the meaning or nuance of the sentence compared to the original.",
  },
  {
    id: "common-mistakes",
    label: "Common Mistakes",
    prompt:
      "Give a numbered list of exactly 5 common mistakes learners make with this word, including situations where its use sounds unnatural.",
  },
  {
    id: "examples",
    label: "Examples",
    prompt:
      "Give a numbered list of exactly 5 example sentences using this word in different contexts. After each Japanese sentence, put the English translation on the next line.",
  },
] as const;
