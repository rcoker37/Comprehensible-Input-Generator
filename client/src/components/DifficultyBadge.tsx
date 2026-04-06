import type { DifficultyEstimate } from "../types";

interface Props {
  difficulty: DifficultyEstimate;
}

export default function DifficultyBadge({ difficulty }: Props) {
  const label =
    difficulty.jlpt.min >= 4
      ? "Beginner"
      : difficulty.jlpt.min >= 3
        ? "Intermediate"
        : difficulty.jlpt.min >= 2
          ? "Advanced"
          : difficulty.jlpt.min >= 1
            ? "Expert"
            : "Mixed";

  return (
    <span className={`difficulty-badge level-${difficulty.jlpt.min || "mixed"}`}>
      {label} ({difficulty.uniqueKanji} kanji)
    </span>
  );
}
