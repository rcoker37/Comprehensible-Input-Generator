#!/usr/bin/env node
//
// Import a story into local from an exported word-index fixture JSON (the
// "Export test fixture" download). Does three things:
//
//   1. Inserts it straight into the running local Supabase DB — no db reset —
//      so you can iterate on overrides in the app immediately.
//   2. Appends it to supabase/seed_dev.sql so it survives a full `db reset`.
//   3. Copies the JSON into client/src/test/fixtures/word-index/ so
//      `npm run test:index` picks it up as a regression fixture.
//
//   node scripts/import-story-local.mjs <fixture.json>
//   node scripts/import-story-local.mjs <fixture.json> --no-seed     # skip step 2
//   node scripts/import-story-local.mjs <fixture.json> --no-db       # skip step 1
//   node scripts/import-story-local.mjs <fixture.json> --no-fixture  # skip step 3
//
// Re-running with the same title replaces the previous import in both places
// (the DB row's occurrence/lookup rows cascade away; the seed block is keyed
// by BEGIN/END marker comments), so it is safe to run repeatedly.

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';

const DEV_USER = '00000000-0000-0000-0000-000000000001';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEED_PATH = join(ROOT, 'supabase', 'seed_dev.sql');
const FIXTURE_DIR = join(ROOT, 'client', 'src', 'test', 'fixtures', 'word-index');

const args = process.argv.slice(2);
const fixturePath = args.find((a) => !a.startsWith('--'));
const skipSeed = args.includes('--no-seed');
const skipDb = args.includes('--no-db');
const skipFixture = args.includes('--no-fixture');

if (!fixturePath) {
  console.error('usage: node scripts/import-story-local.mjs <fixture.json> [--no-seed] [--no-db] [--no-fixture]');
  process.exit(1);
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
const content = fixture.content;
if (typeof content !== 'string') {
  console.error(`✗ ${fixturePath} has no string "content" field`);
  process.exit(1);
}
const title = fixture.meta?.title ?? 'Imported story';
if (content.includes('$STORY$') || title.includes('$TITLE$')) {
  console.error('✗ content/title collides with a dollar-quote tag — rename the tag in this script');
  process.exit(1);
}

// The VALUES tuple, dollar-quoted so newlines / 《》 / quotes need no escaping.
const tuple = `('${DEV_USER}'::uuid, $TITLE$${title}$TITLE$, $STORY$${content}$STORY$,
   'fiction', 3, 'import', 'polite',
   '{"knownOnly": true, "jlptLevels": [], "grades": [1,2,3]}'::jsonb,
   '', '{}'::jsonb, now())`;
const COLUMNS = `(user_id, title, content, content_type, paragraphs, topic,
   formality, filters, allowed_kanji, difficulty, created_at)`;

// --- Step 1: live insert into the running container -------------------------
if (!skipDb) {
  const container = execFileSync('docker', [
    'ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}',
  ]).toString().trim().split('\n')[0];
  if (!container) {
    console.error('✗ No running supabase_db container — run `npx supabase start`.');
    process.exit(1);
  }
  const sql = `
DELETE FROM stories
 WHERE user_id = '${DEV_USER}'::uuid AND title = $TITLE$${title}$TITLE$;
INSERT INTO stories ${COLUMNS}
VALUES ${tuple}
RETURNING id, title;
`;
  const out = execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
     '-v', 'ON_ERROR_STOP=1'],
    { input: sql },
  ).toString();
  process.stdout.write(out);
  console.log('✓ Inserted into local DB — reload the app, the backfill will index it.');
}

// --- Step 2: append (or replace) a marked block in seed_dev.sql -------------
if (!skipSeed) {
  const begin = `  -- BEGIN imported: ${title}`;
  const end = `  -- END imported: ${title}`;
  const block = `${begin}
  INSERT INTO stories ${COLUMNS}
  VALUES ${tuple};
${end}
`;
  let seed = readFileSync(SEED_PATH, 'utf8');

  // Drop any prior block for this title (idempotent re-runs).
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existing = new RegExp(`${esc(begin)}[\\s\\S]*?${esc(end)}\\n`);
  const wasPresent = existing.test(seed);
  seed = seed.replace(existing, '');

  // Splice the block in just before the DO block's `END $$;`.
  if (!seed.includes('\nEND $$;')) {
    console.error('✗ Could not find `END $$;` in seed_dev.sql — aborting seed edit.');
    process.exit(1);
  }
  // Function replacement: a plain string would let `$$` in the block be
  // interpreted as a replacement special and corrupt `END $$;`.
  seed = seed.replace('\nEND $$;', () => `\n${block}END $$;`);
  writeFileSync(SEED_PATH, seed);
  console.log(`✓ ${wasPresent ? 'Updated' : 'Added'} block in supabase/seed_dev.sql.`);
}

// --- Step 3: copy the JSON into the word-index fixtures directory -----------
if (!skipFixture) {
  const dest = join(FIXTURE_DIR, basename(fixturePath));
  if (resolve(fixturePath) === resolve(dest)) {
    console.log('✓ Fixture already in client/src/test/fixtures/word-index/.');
  } else {
    copyFileSync(fixturePath, dest);
    console.log(`✓ Copied fixture → client/src/test/fixtures/word-index/${basename(fixturePath)}`);
    console.log('  Run `npm run test:index` to record its baseline.');
  }
}
