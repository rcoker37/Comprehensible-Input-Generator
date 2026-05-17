# Word-index regression fixtures

Each `*.json` here freezes a story whose word index you have curated to your
liking. `npm run test:index` re-runs the *genuine* detection pipeline against
the vendored JMdict snapshot (`client/src/test/jpdict/`) and flags any change.

## Adding a fixture

1. Open a story; fix its word boundaries with the override editor until the
   index reads the way you want.
2. Click **Export test fixture** on the story detail page.
3. Drop the downloaded `<slug>.json` into this directory.
4. Run `npm run test:index` — the baseline (`<slug>.baseline.json`) is created
   automatically on the first run. Commit both files.

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
