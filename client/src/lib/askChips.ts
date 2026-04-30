export type AskChip = { id: string; label: string; prompt: string };

export const ASK_CHIPS: readonly AskChip[] = [
  {
    id: "meaning-in-context",
    label: "Meaning in Context",
    prompt: "What does this word mean in context?",
  },
  {
    id: "alternatives",
    label: "Alternatives",
    prompt:
      "What are some alternatives that would work in this sentence without substantially changing the meaning? Explain the different nuances of each option.",
  },
  {
    id: "common-mistakes",
    label: "Common Mistakes",
    prompt:
      "What are common mistakes learners make with this word? When would using it sound unnatural?",
  },
  {
    id: "examples",
    label: "Examples",
    prompt:
      "Give me 3 more example sentences using this word in different contexts, with English translations.",
  },
] as const;
