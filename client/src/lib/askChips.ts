export type AskChip = { label: string; prompt: string };

export const ASK_CHIPS: readonly AskChip[] = [
  {
    label: "Meaning in Context",
    prompt: "What does this word mean in context?",
  },
  {
    label: "Alternatives",
    prompt:
      "What are some alternatives that would work in this sentence without substantially changing the meaning? Explain the different nuances of each option.",
  },
  {
    label: "Common Mistakes",
    prompt:
      "What are common mistakes learners make with this word? When would using it sound unnatural?",
  },
  {
    label: "Examples",
    prompt:
      "Give me 3 more example sentences using this word in different contexts, with English translations.",
  },
  {
    label: "Grammar",
    prompt:
      "Break down the grammar here. What part of speech is this, and explain any conjugation, particle, or grammatical pattern at work.",
  },
  {
    label: "Nuance",
    prompt:
      "What's the nuance or register of this word in context? Formal vs casual, neutral vs emotionally loaded, common vs literary?",
  },
  {
    label: "Kanji Breakdown",
    prompt:
      "Break down each kanji in this word — what does each component contribute to the meaning, and is the reading on'yomi or kun'yomi?",
  },
  {
    label: "Conjugation",
    prompt:
      "If this is a verb or adjective, show me its key conjugated forms (dictionary, negative, past, te-form, polite).",
  },
  {
    label: "Synonyms",
    prompt:
      "What are some near-synonyms for this word, and how do they differ in meaning, register, or usage?",
  },
  {
    label: "Etymology",
    prompt: "Briefly explain the etymology of this word — where does it come from?",
  },
] as const;
