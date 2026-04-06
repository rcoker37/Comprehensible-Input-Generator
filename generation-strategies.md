# Story Generation Strategies for Kanji Compliance

This document captures brainstormed approaches for ensuring generated stories only use kanji the user knows. **Currently implemented: Hybrid post-process (#7).**

## 1. Post-processing: Replace violations with furigana

After generation, scan for kanji not in the allowed set and replace with hiragana readings using a static kanji-to-reading dictionary.

- **Pros**: 100% reliable, works with any model, preserves streaming UX
- **Cons**: Needs a reading dictionary; context-dependent readings make static lookup inaccurate (e.g., 生 = せい/しょう/なま); mixed kanji/hiragana in a word looks odd (e.g., 経けん)
- **Variant**: Replace entire words instead of individual characters to avoid partial-word artifacts

## 2. Hiragana-first, then promote to kanji

Ask the LLM to write entirely in hiragana. A second pass (deterministic or LLM) converts words to kanji only where the kanji is in the allowed set.

- **Pros**: Eliminates violations by construction — constraint is enforced by code, not the LLM
- **Cons**: Two-pass = slower + more tokens; hiragana-to-kanji conversion is non-trivial (ambiguous segmentation); needs a morphological analyzer like kuromoji (available as WASM, ~5MB)
- **Variant**: Write in romaji first, then convert via morphological analysis

## 3. Negative list (shorter disallowed list)

When the user knows most kanji, send the disallowed list instead of the allowed list. "Do NOT use these kanji: [short list]" is easier for the LLM to follow.

- **Pros**: Trivial to implement, shorter constraint = better compliance
- **Cons**: Still prompt-based, still imperfect; only helpful when user knows the majority of kanji
- **Best as**: A complement to other approaches, not standalone
- **Status**: Implemented as part of #7

## 4. Real-time stream filtering

Intercept the SSE stream and replace violating kanji with hiragana before displaying to the user. The LLM doesn't see the replacement (it's display-side only).

- **Pros**: Clean UX — user never sees violations even during streaming
- **Cons**: Same context-dependent reading problem as #1; token boundaries don't align cleanly with character boundaries; more complex stream processing

## 5. Chunked generation with validation gates

Generate one paragraph (or sentence) at a time. After each chunk, validate. If violations found, retry just that chunk with explicit corrections.

- **Pros**: Catches violations early, limits retry scope, can still stream each chunk
- **Cons**: More API calls, story coherence may suffer at chunk boundaries, complex orchestration

## 6. Smarter retry loop

Restore the old validation + retry logic (removed when streaming was added) but improved: validate after streaming, include specific violations and their hiragana alternatives on retry, lower temperature, fall back to post-processing if retries exhausted.

- **Pros**: Gives the LLM a fair shot, guaranteed fallback
- **Cons**: Retries are slow and expensive, user waits longer

## 7. Hybrid: prompt optimization + post-process (IMPLEMENTED)

Combines the best of several approaches:

1. **Prompt optimization**: Include negative list when it's shorter than the allowed list
2. **Stream normally**: Full streaming UX preserved
3. **Post-process after streaming**: Detect violations, use a small LLM call to get context-correct readings, annotate with `<ruby>` furigana tags
4. **Educational display**: Violations shown with ruby text so the user sees both the kanji and its reading, highlighted distinctively

- **Pros**: Minimal architecture change, 100% compliance display, streaming UX preserved, educational
- **Cons**: Small additional API call for readings when violations exist
