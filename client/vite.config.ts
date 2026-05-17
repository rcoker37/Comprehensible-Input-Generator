import path from 'node:path'
import { defineConfig, configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'

// The word-index fixture suite boots the real JMdict + kuromoji stack (~15s
// populate). It runs on demand via the `word-index` project
// (`npm run test:index`), never on the fast `npm test`.
const HEAVY = ['src/test/wordIndex.fixtures.test.ts']

export default defineConfig({
  plugins: [react()],
  // Read .env.local from the monorepo root so all dev env vars live in a
  // single file shared with the Edge Function env loader
  // (`supabase functions serve --env-file .env.local`).
  envDir: path.resolve(__dirname, '..'),
  server: {
    host: '0.0.0.0',
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          exclude: [...configDefaults.exclude, ...HEAVY],
        },
      },
      {
        extends: true,
        test: {
          name: 'word-index',
          include: HEAVY,
        },
      },
    ],
  },
})
