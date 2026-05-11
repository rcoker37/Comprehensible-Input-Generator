export type AskChip = { id: string; label: string; prompt: string };

// `id` is the persisted thread key in stories.explanations JSONB and must not
// change once shipped, otherwise threads from older sessions become orphaned.
// `label` and `prompt` can evolve freely.
export const ASK_CHIPS: readonly AskChip[] = [
  {
    id: "alternatives",
    label: "Alternative Word Choices",
    prompt:
      "List exactly 5 word choices that could fill the bracketed word's slot in the sentence while keeping it grammatical — match the part of speech and inflection class so the surrounding particles and conjugation still work. Item 1 is the bracketed word itself; in one sentence, explain what it means in this particular sentence — the precise sense it carries given the surrounding context (not a generic dictionary gloss). Items 2–5 are realistic alternates a Japanese learner would actually encounter — avoid obscure or archaic synonyms unless the original is itself literary. For each alternate, give one short sentence describing how it would shift the sentence compared to item 1: in meaning (broader, narrower, a different angle), in register (more casual, more polite, more literary), or in emotional tone (warmer, harsher, more neutral).",
  },
] as const;
