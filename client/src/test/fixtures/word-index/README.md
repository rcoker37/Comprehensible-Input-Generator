# Word-index regression fixtures

Each `*.json` here freezes a story whose word index you have curated to your
liking. `npm run test:index` re-runs the *genuine* detection pipeline against
the vendored JMdict snapshot (`client/src/test/jpdict/`) and flags any change.

## Adding a fixture (curated path — the common case)

1. Open a story; fix its word boundaries with the override editor until the
   index reads the way you want.
2. Click **Export test fixture** on the story detail page.
3. Drop the downloaded `<slug>.json` into this directory. Set
   `meta.curated: true` in the file (the exporter doesn't add this flag yet).
4. Run `npm run test:index` — the baseline (`<slug>.baseline.json`) is created
   automatically on the first run. Commit both files.

## Adding a fixture (uncurated path — for review workflows)

When you don't want to hand-fix every span before exporting (e.g. you're
adding a fixture to *find* algorithm bugs, not to pin perfect behavior):

1. Export from the app as above, **without** running the override editor.
2. Drop the file in; either leave `meta.curated` absent or set it to `false`.
3. Review:

   ```bash
   npm run test:index:suspects -- <fixture-substring>
   ```

   Flags spans where the picked entry's primary sense has restrictive misc
   (`chn` / `arch` / etc.), a single 固有名詞 kuromoji token is missing
   `isName`, or a much-better-ranked sibling exists in the exact lookup.

4. For anything flagged that looks wrong, drill in:

   ```bash
   npm run debug:span -- "@<fixture-substring>" <start> <end>
   ```

   Dumps kuromoji tokens, JMdict exact hits, deinflection candidates, and
   the final `lookupAtBoundary` result for that span — same data the older
   workflow extracted by writing a one-off vitest trace test.

5. Fix the algorithm (or accept the existing pick), then:

   ```bash
   npm run test:index:regenerate -- <fixture-substring>
   ```

   Re-runs the indexer on the fixture's content and writes the result as
   the new `expected[]`. Caveat: this silently overwrites any `manual: true`
   overrides — so only run it on a fixture with no hand-fixes. Bump
   `meta.curated: true` once you're satisfied.

See `docs/word-index-debugging.md` for the full debugging guide and
`docs/word-index-jmdict-traps.md` for known JMdict footguns.

## The loop

- `npm run test:index` — fails if detection changed since the baseline, or if
  the algorithm broke a span the fixture says it once got right.
- `npm run test:index:accept` — after reviewing a diff, blesses the current
  output as the new baseline.
- Spans you hand-fixed in the override editor (`manual: true`) are tracked as
  *known gaps*: reported, never a failure. When the algorithm catches up to one
  it is flagged as an *improvement* — re-export the fixture to drop the now
  unnecessary override.

`<slug>.json` is hand-sourced (the export); `<slug>.baseline.json` is
machine-managed (the test, and `--accept`). Never edit a baseline by hand.

## Fixture meta

Beyond `title` / `sourceStoryId` / etc., one optional flag matters for the
review workflow:

- `meta.curated: true` — the operator has hand-reviewed `expected[]` and
  fixed any algorithm bugs. The test runner trusts the fixture as a
  regression check.
- `meta.curated: false` (or absent) — `expected[]` is the raw algorithm
  output at export time. The test runner prints a `⚠ uncurated` warning
  on every run so the operator doesn't mistake algorithm drift for a real
  regression against curator intent.
