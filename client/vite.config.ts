/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Read .env.local from the monorepo root so all dev env vars (VITE_*,
  // AZURE_SPEECH_*) live in a single file shared with the Edge Function
  // env loader (`supabase functions serve --env-file .env.local`).
  envDir: path.resolve(__dirname, '..'),
  server: {
    host: '0.0.0.0',
  },
  test: {
    setupFiles: ['./src/test/setup.ts'],
  },
})
