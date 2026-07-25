// Word-level comprehensibility measurement for the story refinement loop.
//
// After a story is generated we measure, per word, "has the reader ever seen
// this?" and "how rare is it?" — reusing the exact same signals the app
// already computes for the zero-encounter underline (`vocabEncounters` +
// `getWordRank`). A word is a *problem* when the reader has never encountered
// it AND it is rarer than their personal frequency frontier. If a story has
// too many problem words, the `revise-story` Edge Function is asked to swap
// the specific offenders for simpler ones (see RefinementContext).
//
// Pure and React-free (no imports beyond the WordOccurrence *type*), so it
// runs in unit tests against synthetic occurrences.

import type { WordOccurrence } from "./storyWordIndex";

// ── Frontier tuning ────────────────────────────────────────────────────────
// The reader's vocabulary "frontier" is a JPDB rank: the rarer edge of the
// vocabulary they demonstrably know. Words rarer than this that they've never
// seen are the ones worth simplifying.

/** Min encounters for a headword to count toward the frontier estimate. Below
 *  the app's "known" boundary (FURIGANA_UNSEEN_THRESHOLD = 10) on purpose, so
 *  the sample isn't starved, but high enough to exclude one-off exposures. */
export const WELL_KNOWN_MIN = 5;
/** Need at least this many ranked, well-known words before trusting a computed
 *  frontier; below it we fall back to DEFAULT_FRONTIER (cold-start). */
export const MIN_SAMPLE = 30;
/** The frontier is this percentile of the reader's known-word ranks — the
 *  rare edge of their comfort zone, not the median. */
export const FRONTIER_PERCENTILE = 0.75;
/** Cold-start frontier: an upper-beginner (~JLPT N4) reader. */
export const DEFAULT_FRONTIER = 6000;
/** Clamp so a handful of lucky rare exposures can't inflate the level, and so
 *  we never flag genuinely common words as "too hard". */
export const FRONTIER_MIN = 4000;
export const FRONTIER_MAX = 40000;

// ── Reach band (the i+1 "keep" zone) ─────────────────────────────────────────
// Not every unseen word rarer than the frontier is "too hard". There's a band
// just beyond the frontier where a new word is a *teachable stretch* — rare
// enough to be worth learning, close enough to infer from context. Those are
// exactly the words a story should teach, so the repair loop must NOT strip
// them. Only unseen words rarer than this reach ceiling (or unranked) are
// flagged as problems to simplify. Multiplicative because rank is Zipfian
// (log-scaled), so "3× rarer than your comfortable edge" is a fixed stretch
// across ability levels.
export const REACH_MULTIPLIER = 3;

/** The rarity ceiling for a *teachable* new word, given the reader's frontier.
 *  Unseen words at or below this are i+1 material the loop leaves alone; unseen
 *  words rarer than this (or unranked) are the too-hard "problems" it simplifies. */
export function reachRank(frontierRank: number): number {
  return frontierRank * REACH_MULTIPLIER;
}

// ── Loop tuning ──────────────────────────────────────────────────────────
/** Hard cap on repair passes per story (balanced: up to 2). */
export const MAX_REFINE_PASSES = 2;
/** Stop once at least this share of content tokens are familiar. */
export const COMPREHENSIBLE_THRESHOLD = 0.97;
/** Stop once this few distinct problem words remain (residual is acceptable —
 *  the furigana-unseen rendering handles the last few gracefully). */
export const RESIDUAL_OK = 3;
/** Never ask the model to fix more than this many words in one pass. */
export const FLAG_CAP = 15;

// ── i+1 floor tuning ───────────────────────────────────────────────────────
// The repair loop only bounds difficulty from above (removes too-hard words).
// To keep a story from being nothing but already-known vocabulary — which
// teaches nothing — the first-draft prompt is told to introduce a floor of
// genuinely-new words scaled to length. This is a *generation target* the
// model is asked to hit; the settled story's actual new-word count is measured
// and surfaced so a miss is visible.
export const NEW_WORDS_PER_PARAGRAPH = 2;
export const NEW_WORD_FLOOR_MIN = 3;
export const NEW_WORD_FLOOR_MAX = 16;

/** How many new words the first draft should aim to introduce, by length. */
export function newWordTarget(paragraphs: number): number {
  return Math.max(
    NEW_WORD_FLOOR_MIN,
    Math.min(NEW_WORD_FLOOR_MAX, Math.round(paragraphs * NEW_WORDS_PER_PARAGRAPH))
  );
}

export interface VocabLevel {
  /** Short human/LLM-facing band, e.g. "upper-beginner (around JLPT N4)". */
  label: string;
  /** One-sentence description the generation prompt can act on. */
  blurb: string;
}

export interface ProblemWord {
  surface: string;
  headword: string;
  reading: string;
  rank: number | null;
}

export interface ComprehensibilityScore {
  /** Non-name Japanese word tokens considered. */
  contentTokens: number;
  /** Tokens that are unseen AND too hard — rarer than the reach ceiling. */
  problemTokens: number;
  /** 0–1 share of content tokens that are not too hard (readable). */
  fraction: number;
  /** Distinct too-hard headwords (unseen + beyond reach), rarest first (null
   *  rank = rarest) — the only words the repair loop simplifies. */
  problemWords: ProblemWord[];
  /**
   * Distinct headwords the reader has never encountered (any rank) — the
   * story's new material. The i+1 signal: `newWords - problemWords.length` is
   * the count of new-but-within-reach words. A story with 0 new words teaches
   * nothing; the pass-1 prompt targets `newWordTarget(paragraphs)`.
   */
  newWords: number;
}

type RankLookup = (headword: string) => number | null;

// Hiragana, katakana, CJK Ext-A, CJK unified, CJK compat. A "content token"
// must contain at least one of these — this drops punctuation, digits, and
// stray latin the tokenizer might emit so they can't be scored as vocabulary.
const JAPANESE_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

function hasJapanese(s: string): boolean {
  return JAPANESE_RE.test(s);
}

/**
 * The reader's frequency frontier — the FRONTIER_PERCENTILE-th percentile of
 * JPDB ranks among headwords they've encountered at least WELL_KNOWN_MIN
 * times. Falls back to DEFAULT_FRONTIER when the sample is too small, and is
 * clamped to [FRONTIER_MIN, FRONTIER_MAX].
 */
export function vocabFrontier(
  vocabEncounters: Map<string, number>,
  getWordRank: RankLookup
): number {
  const ranks: number[] = [];
  for (const [headword, count] of vocabEncounters) {
    if (count < WELL_KNOWN_MIN) continue;
    const rank = getWordRank(headword);
    if (rank === null) continue;
    ranks.push(rank);
  }
  if (ranks.length < MIN_SAMPLE) return DEFAULT_FRONTIER;
  ranks.sort((a, b) => a - b);
  const idx = Math.floor(FRONTIER_PERCENTILE * (ranks.length - 1));
  const p = ranks[idx]!;
  return Math.min(FRONTIER_MAX, Math.max(FRONTIER_MIN, p));
}

/**
 * Map a frontier rank to a JLPT-flavoured level label + a natural-language
 * blurb the generation prompt can act on. The JLPT anchors are approximate
 * (JPDB rank is frequency, not a JLPT list) — they exist because the model
 * has strong priors about "write for an N4 learner" and none about rank
 * numbers. Never surface this label to the user as their real JLPT level.
 */
export function rankToLevel(frontierRank: number): VocabLevel {
  if (frontierRank <= 3000)
    return {
      label: "beginner (around JLPT N5)",
      blurb:
        "a beginner who reliably knows only the most common everyday words",
    };
  if (frontierRank <= 6000)
    return {
      label: "upper-beginner (around JLPT N4)",
      blurb:
        "an upper-beginner comfortable with common daily-life vocabulary but not yet specialized, literary, or abstract words",
    };
  if (frontierRank <= 12000)
    return {
      label: "lower-intermediate (around JLPT N3)",
      blurb:
        "a lower-intermediate reader who knows most common vocabulary and some less-common words, but still trips on rare, technical, or literary terms",
    };
  if (frontierRank <= 22000)
    return {
      label: "intermediate (around JLPT N2)",
      blurb:
        "an intermediate reader comfortable with a broad everyday vocabulary and many uncommon words; only rare, literary, or technical terms are unfamiliar",
    };
  return {
    label: "advanced (around JLPT N1)",
    blurb:
      "an advanced reader for whom almost all ordinary vocabulary is familiar; only genuinely rare or specialist terms need simplifying",
  };
}

/** Convenience: compute the reader's level in one call. */
export function vocabLevel(
  vocabEncounters: Map<string, number>,
  getWordRank: RankLookup
): VocabLevel {
  return rankToLevel(vocabFrontier(vocabEncounters, getWordRank));
}

/**
 * Score one story's word occurrences against the reader's vocabulary. A
 * content token is a non-name occurrence whose surface contains Japanese.
 *
 * A *problem* token is one that is both unseen (`vocabEncounters` count === 0)
 * and rarer than the reader's **reach ceiling** (`reachRank(frontierRank)`), or
 * unranked — i.e. genuinely too hard. Unseen words within reach
 * (`frontier < rank ≤ reach`) are the desirable i+1 stretch: they count as
 * `newWords` (new material) but are NOT problems, so the repair loop leaves
 * them in the story instead of sanding it down to only-already-known vocabulary.
 */
export function scoreComprehensibility(
  occurrences: WordOccurrence[],
  vocabEncounters: Map<string, number>,
  getWordRank: RankLookup,
  frontierRank: number
): ComprehensibilityScore {
  const reach = reachRank(frontierRank);
  let contentTokens = 0;
  let problemTokens = 0;
  const problems = new Map<string, ProblemWord>();
  const newHeadwords = new Set<string>();

  for (const o of occurrences) {
    if (o.isName) continue;
    if (!hasJapanese(o.surface)) continue;
    contentTokens++;

    const seen = vocabEncounters.get(o.headword) ?? 0;
    if (seen > 0) continue;
    // Any unseen content word is new material (i+1), whether common or rare.
    newHeadwords.add(o.headword);
    const rank = getWordRank(o.headword);
    // Within reach → a teachable stretch, keep it. Only past the reach ceiling
    // (or unranked) is it too hard and worth simplifying.
    if (rank !== null && rank <= reach) continue;

    problemTokens++;
    if (!problems.has(o.headword)) {
      problems.set(o.headword, {
        surface: o.surface,
        headword: o.headword,
        reading: o.reading,
        rank,
      });
    }
  }

  // Rarest first (unranked = rarest) so a FLAG_CAP slice keeps the hardest.
  const problemWords = [...problems.values()].sort(
    (a, b) =>
      (b.rank ?? Number.POSITIVE_INFINITY) - (a.rank ?? Number.POSITIVE_INFINITY)
  );
  const fraction =
    contentTokens === 0 ? 1 : 1 - problemTokens / contentTokens;

  return {
    contentTokens,
    problemTokens,
    fraction,
    problemWords,
    newWords: newHeadwords.size,
  };
}

/**
 * Whether the refinement loop should stop on this story. Stops when the story
 * is comprehensible enough, only a residual few hard words remain, the pass
 * cap is hit, or a pass failed to reduce the distinct problem count
 * (anti-oscillation — a repair can introduce new rare words). `prevProblemCount`
 * is the distinct problem count from before this pass (Infinity on first eval).
 */
export function shouldSettle(
  score: ComprehensibilityScore,
  pass: number,
  prevProblemCount: number
): boolean {
  if (score.fraction >= COMPREHENSIBLE_THRESHOLD) return true;
  if (score.problemWords.length <= RESIDUAL_OK) return true;
  if (pass >= MAX_REFINE_PASSES) return true;
  if (score.problemWords.length >= prevProblemCount) return true;
  return false;
}
