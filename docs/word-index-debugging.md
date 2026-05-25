# Debugging the word indexer

How to diagnose "why did the indexer pick that entry?" without reading the
algorithm front-to-back. Pair with `docs/word-index-jmdict-traps.md` for the
catalog of homophone footguns this pipeline routinely hits.

## Tools

### `npm run debug:span -- <text|@fixture-slug> <start> [<end>]`

One-shot trace for a single span. Boots the real headless dictionary
(~10s) and dumps a structured JSON trace covering:

- the kuromoji tokens covering the span (with `pos`, `posDetail1`, `basicForm`)
- the kuromoji `posHint` and `baseHint` `lookupAtBoundary` sees
- the full `lookupWord(surface)` exact-match list (with JPDB rank, POS, misc, glosses)
- every deinflection candidate and its hits
- the final `lookupAtBoundary` result with its `base` / `derivations`

Examples:

```bash
# Raw text mode — offsets are into the cleaned text (ruby stripped)
npm run debug:span -- "藤原千花さんは" 2 4

# Fixture mode — load content from a fixture file matched by substring
npm run debug:span -- "@千花" 95 97
```

Replaces the older pattern of writing a one-off vitest trace test, adding
it to `vite.config.ts`'s HEAVY array, force-failing with
`expect(JSON.stringify(x)).toBe('FORCE FAIL')`, and cleaning up. Use it
once and move on; nothing to commit.

### `npm run test:index:suspects -- <fixture-substring>`

Re-runs the indexer on a fixture and flags spans whose chosen entry looks
low-confidence. Three heuristics, intentionally noisy:

- `suspicious-misc` — picked entry's primary sense carries `chn`/`arch`/
  `obs`/`sl`/`vulg`/`derog`/`dated`. The rank hoist demotes these but only
  when the *primary* sense is flagged; this is the looser check.
- `not-named` — span aligns with a single kuromoji 固有名詞 token but
  `isName: false`. The 固有名詞-block fallback should have caught it.
- `outranked-sibling` — `lookupWord(surface)` exposes a >2× better-ranked
  entry that the algorithm didn't pick. Either rank-hoist's literal-script
  partition or the 2× threshold steered away from it; verify which is right
  for the context.

A few hits in this output is normal — every one needs a human glance.
Cross-check with `debug:span`.

### `npm run test:index:regenerate -- <fixture-substring>`

Re-runs `extractWordOccurrences` on a fixture's content and writes the
output as the new `expected[]`, also bumping `meta.wordIndexVersion`. Use
after an algorithm fix that genuinely changed correct behavior, AND only
when no `manual: true` overrides exist (those would be silently wiped).

## When to use which

| Question | Tool |
|---|---|
| "What does the algorithm think is happening at this offset?" | `debug:span` |
| "Did I miss any obvious bad stamps in this fixture?" | `test:index:suspects` |
| "I fixed the algorithm — update the expected[]" | `test:index:regenerate` |
| "Did my fix break any other fixture?" | `test:index` |
| "Bless the diff against the baseline" | `test:index:accept` |

## The `lookupAtBoundary` decision tree

When `debug:span` shows `finalHit.results[0]` is something unexpected, walk
the branches in `lookupAtCursor.ts:lookupAtBoundary` in this order:

1. **Verb-deinflection preempt** (kuromoji 動詞 + exact has no verb POS, or
   exact is only unranked `exp`, or exact is only unranked inflected verbs).
   Deinflects, picks a candidate via `pickDeinflection`, returns it — unless
   `expExactBeatsDeinflection` says a JPDB-ranked fixed-phrase exact wins
   first (this is what catches 「いえ」 → int いえ over 言える).

2. **i-adjective 連用形 preempt** (kuromoji 形容詞/副詞 + exact has no
   `adj-i` POS). Symmetric to (1) for adjectives.

3. **Non-kana exact match wins** — kanji/mixed-script surfaces stamp their
   exact match, after `hoistRankedToFront` reorders by rank.

4. **Pure-kana non-verb content preempt** — kuromoji 名詞/副詞 + exact
   has matching POS → exact wins (stops みんな being deinflected to 見る).

5. **Pure-kana fixed-phrase keeps exact** — `expExactBeatsDeinflection`
   wins on relaxed terms (≤ 10× the deinflection's rank). The fixed-phrase
   entry is hoisted to position 0 via `hoistFixedPhraseToFront`.

6. **Pure-kana exact outranks deinflection** — `exactOutranksDeinflection`
   compares ranks; exact wins if as common or better.

7. **Deinflection wins** — last resort before na-adj prenominal fallback.

8. **na-adj prenominal** (`静かな` → `静か`) — surface-shape rule.

Every successful return runs through `hoistRankedToFront` (or
`hoistFixedPhraseToFront` for the fixed-phrase paths). Within the chosen
hit's `results[]`, those helpers may reorder.

## `hoistRankedToFront` mental model

Sort `hit.results` by JPDB rank ascending so `headwordFromHit` picks the
most common entry. Three guards prevent regressions:

- **Literal-script partition.** Only candidates whose `k` or `r` literally
  matches the compare-key (deinflection base, else surface) are eligible.
  Keeps レイ (kana, literal) above 例 (kanji, reading れい folded onto レイ
  by the IDB's case-folded index).
- **Suspect-misc demotion.** Primary sense flagged `chn`/`arch`/`obs` is
  treated as unranked. Keeps 飯 (`chn` rank 158) from capturing 「まま」 from
  儘 (rank 3074).
- **2× minimum ratio.** Hoist only fires when the would-be winner is at
  least 2× better than what's at position 0. Keeps near-tied homophones
  (レーン "lane" vs "rain" at 1.18×) under jpdict-idb's intrinsic order.

If `debug:span` shows the right entry is in `exact[1+]` but `finalHit.results[0]`
is wrong, check which guard is denying the hoist.

## Common surprises

### Console output disappears in vitest

By default vitest captures stdout; `console.log` inside a test is buffered
and shown only on failure. Pass `--disable-console-intercept` to surface it
live (the tool wrappers already do).

### Trace test "passed" but the data is empty

`describe.skipIf(!ACTIVE)` silently skips when the env var gating it is
unset. Check that `DEBUG_SPAN_TEXT` / `SUSPECTS_FIXTURE_PATH` / etc are
exported in the wrapper — otherwise vitest reports "0 tests" without an
error.

### `import.meta.env` is undefined outside Vite

`tokenizer.ts` reads `VITE_KUROMOJI_DICT_PATH` from `import.meta.env`,
which is populated by Vite at transform time. In plain `tsx` runs it's
`undefined` and the tokenizer falls back to `/dict/` — wrong path. This
is why the debug / regenerate / suspects tools run *through* vitest
rather than as standalone tsx scripts: vitest sets up the same env-injection
the app gets.

### Fixture has `meta.curated: false`

`expected[]` is the raw algorithm output at export time, not human-blessed.
A "regression" against it means "the algorithm output drifted from a
previous algorithm run" — not "broke a curator-blessed pick". Run
`suspect-matches` first to spot likely bugs; fix them; then
`test:index:regenerate` to re-bless and set `curated: true` by hand.
