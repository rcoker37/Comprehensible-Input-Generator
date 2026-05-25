---
name: review-fixture
description: >
  Review an uncurated word-index fixture for likely algorithm bugs.
  Use when the user adds a new fixture (under client/src/test/fixtures/word-index/)
  with meta.curated: false (or absent) and asks "find issues", "review this",
  "what looks wrong", or similar.
  Walks the suspect-matches → debug:span → fix → regenerate loop instead of
  eyeballing every span manually.
---

# Reviewing a new word-index fixture

The user has dropped an uncurated fixture and wants to know which stamps
look wrong. Don't read every span by hand; use the dedicated tools.

## Step 0 — confirm what you're looking at

```bash
cat client/src/test/fixtures/word-index/<slug>.json | head -20
```

Verify it has `"curated": false` (or no curated flag) and every entry in
`expected[]` has `"manual": false`. If `meta.curated: true` or any
`manual: true` rows exist, the operator has already done the review work
— ask them what they want before regenerating anything.

## Step 1 — run suspect-matches

```bash
npm run test:index:suspects -- <fixture-substring>
```

Output flags spans where the picked entry is low-confidence under three
heuristics: `suspicious-misc` (primary sense flagged `chn`/`arch`/etc),
`not-named` (single 固有名詞 token without `isName`), and
`outranked-sibling` (a >2× better-ranked exact-match alternative exists).
A handful of hits is normal; each needs a human glance.

## Step 2 — drill into anything that looks wrong

```bash
npm run debug:span -- "@<fixture-slug>" <start> <end>
```

Dumps the full pipeline trace for one span: kuromoji tokens, JMdict exact
hits, deinflection candidates, and the final `lookupAtBoundary` result.
This is what tells you *why* the algorithm picked what it did — read the
`finalHit.results[0]` vs the `exact[]` and `deinflections[]` alternatives.

Walk the `lookupAtBoundary` decision tree in `docs/word-index-debugging.md`
to identify which branch fired and whether the right guard was in place.
Cross-reference `docs/word-index-jmdict-traps.md` to see if this is a
known class.

## Step 3 — propose & implement fixes if the algorithm is wrong

If the issue is genuinely an algorithm bug (not a curator preference):
implement the fix in `client/src/lib/lookupAtCursor.ts` (homophone
arbitration), `client/src/lib/storyWordIndex.ts` (block-level routing,
sub-segmentation), or `client/src/lib/regroupWords.ts` (span boundaries).
Each defense in those files has a specific role — adding a new one is
usually wrong; adjusting an existing rule's guards is usually right.

After implementing, bump `WORD_INDEX_VERSION` in `storyWordIndex.ts`
(the existing docblock is the version history — append an entry).

## Step 4 — re-run the full suite, then regenerate

```bash
npm test                           # 324 unit tests (~250ms)
npm run test:index                 # 11 fixtures (~4–5 min)
```

If existing fixtures changed: review the `behaviour changed` lines (the
diff output now tags `[NAME]` on isName flips, so isName changes are
visible). If genuinely improvements, accept via `npm run test:index:accept`.
If regressions, revisit the fix.

For the uncurated fixture specifically, bless the new expected:

```bash
npm run test:index:regenerate -- <fixture-substring>
```

Then set `meta.curated: true` in the fixture JSON by hand once you're
satisfied with `expected[]`. The fixture is now a real regression check.

## What NOT to do

- **Don't** write one-off vitest trace tests. `debug:span` is faster and
  doesn't pollute git.
- **Don't** eyeball every span in a 200-span fixture. `suspect-matches`
  surfaces the load-bearing ~5 in seconds.
- **Don't** call `test:index:regenerate` before the algorithm is right —
  the bug becomes baked into `expected[]` and the next reviewer has to
  re-discover it.
- **Don't** add a fixture-specific algorithm hack. If a defense's guards
  need adjusting, adjust them generically; if a fixture's stamps are
  ambiguous in context, set `manual: true` on the override (don't change
  the algorithm).
