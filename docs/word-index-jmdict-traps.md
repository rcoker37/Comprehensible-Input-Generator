# JMdict / JPDB stamping traps

Homophone surfaces where JMdict's intrinsic sort, kuromoji's tokenization, or
JPDB's frequency data can produce a wrong stamp without an algorithm defense.
Each entry lists the surface, the wrong pick, the right pick, and the
defense the indexer uses. Pair with `docs/word-index-debugging.md` when an
unfamiliar surprise turns up.

The catalog is non-exhaustive — JMdict is large and the long tail is wide.
Add to it when an audit surfaces a new class.

## Pure-kana surface, rank-better but semantically wrong sibling

JPDB's frequency data sometimes ranks a homophone you don't want for the
common interpretation. `hoistRankedToFront` would surface the rank winner
within the literal-script partition; three guards keep it conservative
(see `word-index-debugging.md`).

| Surface | Wrong pick | Right pick | Defense |
|---|---|---|---|
| まま | 飯 #2024490 (rank 158, `chn` "food, children's") | 儘 #1585410 (rank 3074, "as is, remaining") | `chn` primary-sense demotion in `rankForHoist` |
| レーン | 1144490 "lane" (rank 32536) | depends on context; near tie with #2850586 "rain" (27563) | 2× minimum-ratio guard keeps order at jpdict-idb's intrinsic sort |
| いえ | 家 #1191730 (rank 136, "house") | depends; in 「いえ、」 reply context the int いえ #1583250 (rank 573, "no") | `hoistFixedPhraseToFront` when the verb branch's `expExactBeatsDeinflection` fires |

## Verb deinflection beats a fixed-phrase exact

When kuromoji tags 動詞 and the exact match has no verb POS,
`lookupAtBoundary` deinflects. A fixed-phrase exact (int / conj / exp)
that's much more common than the deinflection's lemma should preempt the
deinflection, but it didn't until the post-`pickDeinflection` check was
added.

| Surface | Kuromoji says | Wrong deinflection | Right fixed-phrase exact | Defense |
|---|---|---|---|---|
| いえ | 動詞 (continuative of 言える) | 言える #1008860 (rank 9596) | int いえ #1583250 (rank 573) | `expExactBeatsDeinflection` re-runs after `pickDeinflection`; `hoistFixedPhraseToFront` returns the int |

## JMdict's intrinsic sort floats a rare entry first

`lookupWord(surface)` returns results in jpdict-idb's order, which mixes
JMdict priority tags and headword-type heuristics. Sometimes the head of
the list is a rare entry the reader doesn't mean.

| Surface | Head of jpdict-idb's sort | What we want | Defense |
|---|---|---|---|
| はず | 巴豆 #2461070 (unranked, "purging croton" — Chinese medicine) | 筈 #1476430 (rank 206, "should/bound to") | `hoistRankedToFront` (unranked → ranked) |
| やさしい (deinflected from やさしく) | 易しい #1157000 (rank 4588, "easy") | 優しい #1539040 (rank 543, "kind, gentle") | `hoistRankedToFront` (8.4× rank improvement passes the 2× threshold) |
| くる (deinflected from inflected form) | 佝僂 #1585500 (unranked, medical term) | 来る #1547720 (rank 25, "to come") | `hoistVerbToFrontWhen` (kuromoji 動詞 + verb-POS hoist) |

## Reading-folded kanji entry steals a katakana surface

The IDB folds katakana to hiragana for its index, so a katakana name like
レイ matches kanji 例 (reading れい). `lookupWord` already calls
`preferExactScriptMatch` to put literal matches first; `hoistRankedToFront`
runs only within that partition, so a folded sibling can't capture rank.

| Surface | Folded match | Literal match (kept) | Defense |
|---|---|---|---|
| レイ | 例 #1585230 (rank 1025, "example", reading れい) | レイ #1144530 (rank 13197, "lei", kana-only) | `hoistRankedToFront` literal-script partition |
| でも | デモ (loanword "demonstration") | でも (conjunction) | `preferExactScriptMatch` in `lookupWord` |

## Standalone 固有名詞 kanji block JMdict can't reconstruct

Kuromoji's IPADIC has a names dictionary; some surnames / given names are
tagged 固有名詞 even when JMdict has nothing whole-span for them. The
sub-segment fallback (split on character / kuromoji boundary, partition
the LLM ruby) can fail when a piece's reading isn't in JMdict's standalone
entry for that kanji.

| Surface | Sub-segment failure | Pre-defense outcome | Defense |
|---|---|---|---|
| 藤原 | わら isn't a JMdict reading of 原 | dropped entirely | name-span fallback when partition fails |
| 千花 | か isn't 花's standalone reading | survived as one span via the numeral path (千 ∈ NUMERAL_CHARS), but with `isName: false` | name-span fallback fires before the numeral check; `isNumberAtom` excludes `isName`; `splitNumberRun` preserves `isName` defensively |

Compound nouns that *do* partition cleanly stay split — 森中《もりじゅう》 in
「森中に声が広がった」 ("throughout the forest") becomes 森 もり + 中 じゅう
because じゅう is a valid JMdict reading of 中.

## Particle-poisoned conjunctive entry

JMdict entries with both `prt` and `conj` POS (e.g. 「し」 #2086640 — the
conjunctive particle "and besides") function as context-dependent particles,
not standalone fixed phrases. They shouldn't trigger the fixed-phrase
preempt against verb deinflections.

| Surface | Trap | Right pick | Defense |
|---|---|---|---|
| し (in 「〜にしながらも」) | the `prt+conj` entry 2086640 (rank 58) would beat する's deinflection (rank 11) via `expExactBeatsDeinflection` | する deinflection from 為る #1157170 (rank 11) | prt-poison in `expExactBeatsDeinflection` and `hoistFixedPhraseToFront` |

## な-adjective prenominal な

JMdict has no entry for the prenominal な that attaches to na-adjectives
(静か+な). The standalone な exact-matches the prohibitive particle
(#2029110, "don't"), and 静か+な used to split into 静か + な (prohibitive).

| Surface | Wrong split | Right merge | Defense |
|---|---|---|---|
| 静かな | 静か + な (prohibitive #2029110) | 静か as adj-na, merged | `naAdjPrenominalHit` surface-shape rule |
