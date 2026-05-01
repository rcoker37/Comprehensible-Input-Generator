# Frontend Audit — Remaining Recommendations (2026-05-01)

Tier 1 fixes shipped on branch `react-audit-tier-1`: context memoization, `noUncheckedIndexedAccess`, StoryDisplay keyboard accessibility, WordPopover focus trap, mobile input scaling hack removal. The findings below are everything else from the audit, ordered roughly by impact.

---

## Tier 2 — Real issues, fix before next deploy

### 1. ErrorBoundary swallows errors silently in production
**File:** `client/src/components/ErrorBoundary.tsx:14-16` — only `getDerivedStateFromError`, no `componentDidCatch` and no logging.

**Fix:** Add `componentDidCatch(error, info) { console.error("ErrorBoundary:", error, info); }`. If/when you add Sentry or another tracker, route here.

### 2. Generator's progress preview uses array-index keys against a streaming list
**Evidence:** `client/src/components/StoryDisplay.tsx:299` — fallback path `cleanContent.split("\n\n").map((p, i) => <p key={i}>{p}</p>)`. Generator progress display has the same pattern.

**Why it matters:** When the SSE stream extends a paragraph mid-render, React reuses the wrong DOM node — `<ruby>` annotations may flash or duplicate. The main `paragraphs.map` (which uses `pIdx` *post-tokenize*) is fine; the fallback and any progress preview are not.

**Fix:** Key on a hash of the paragraph content (or on a stable id from the tokenizer).

### 3. KanjiManager fetch on mount has no AbortController; route-change races state setters
**File:** `client/src/pages/KanjiManager.tsx:47-71`

**Fix:** Mirror the pattern in `AppLayout.tsx:25-39` — create an AbortController, plumb its signal into `getKanji/getKanjiStats/getReadStoryContents`, abort on cleanup, guard `setState` with `signal.aborted`. Also worth doing in `Stories.tsx`.

### 4. SSE parse errors are dev-only
**File:** `client/src/api/client.ts:256-262` — `if (import.meta.env.DEV) console.debug(...)`. In prod, malformed chunks vanish.

**Fix:** Always log (`console.warn` is fine). When you add error tracking, capture the offending `data` and the parse error.

### 5. SSE reader ignores `signal` between iterations
**File:** `client/src/api/client.ts:220-264` — the `while (true)` loop relies on `reader.read()` throwing on abort.

**Fix:** Add `if (signal?.aborted) break;` at the top of each iteration. Cheap insurance, exits cleanly without surfacing an AbortError.

### 6. Edge function HTTP errors leak raw status codes to users
**File:** `client/src/api/client.ts:208-211` (and 385, 436, etc.) — falls back to `\`HTTP ${response.status}\`` if the body has no `.error`.

**Fix:** Centralize a small mapper: `401 → "Sign in again"`, `402 → "OpenRouter quota exceeded"`, `429 → "Rate limited; try again in a minute"`, `500 → "Server error; please retry"`. CLAUDE.md notes the edge function maps these — confirm and remove the duplicate fallback.

### 7. Re-tokenization runs whenever audio object identity changes
**File:** `client/src/components/StoryDisplay.tsx:171-183` — effect deps are `[audio, cleanContent, rubyAnnotations]`. When `setStoryAudio` updates the story in `GenerationContext` (after audio generation), this re-runs.

**Note:** The `if (audio?.tokens?.length > 0) { ...; return; }` early return prevents the slow kuromoji path; user-visible cost is small. Still a wasted `groupTokens` call.

**Fix:** Memoize on `[audio?.tokens, cleanContent, rubyAnnotations]` — only deps that actually change the result.

### 8. AnimatedDots re-renders 2.5×/sec for a CSS-doable effect
**File:** `client/src/components/AnimatedDots.tsx` — setInterval + setState on 400ms.

**Fix:** Replace with a CSS `@keyframes` animation on a `::after` pseudo-element. Zero JS, zero re-renders.

### 9. KanjiManager grid renders all filtered kanji (~2500) in DOM
**File:** `client/src/pages/KanjiManager.tsx`

**Fix:** `@tanstack/react-virtual` (~5kb gz) virtualizes the grid. Defer until you measure perf, but the data set isn't shrinking.

### 10. computeDifficulty silently drops kanji missing from kanjiMeta
**File:** `client/src/lib/generation.ts:85-107` — `.filter(r => r != null)` swallows missing rows. Count on line 89 is then wrong; no warning fires.

**Fix:** When `rows.length !== usedKanji.length`, `console.warn` the missing characters. They're either a bug in the joyo seed or LLM output containing rare kanji.

---

## Tier 3 — Code-quality wins

### 11. Design tokens leak: hex colors duplicated across CSS files
**Evidence:** `App.css:279-297` defines `#4caf50`, `#ff9800`, `#e94560` inline; `StoryDisplay.css:62, 104`, `PlaybackFooter.css:156`, `Settings.css` repeat these and add `#ffb74d`, `#ff6b6b`, `#f5a524`.

**Fix:** Add `--color-success`, `--color-warning`, `--color-danger`, `--color-ruby` to `:root`. Replace every literal hex. Future theme work (e.g., light mode) becomes trivial.

### 12. Action-button styling duplicated 4× across components
**Evidence:** `StoryActions.css:9-36`, `PlaybackFooter.css:39-94`, `KanjiManager.css:47-59`, `App.css:159-176` — same padding/border/transition/disabled/hover patterns.

**Fix:** One `.action-btn` base in `App.css` with optional modifiers. Stack class names on usage.

### 13. Pre-existing ESLint errors (9) on main
Discovered while running lint during Tier 1 validation. None introduced by Tier 1 — same 9 errors exist on `main`:

- `react-hooks/set-state-in-effect` × 5: `AppLayout.tsx:27`, `StoryDisplay.tsx:154,174`, `KanjiContext.tsx:33`, plus `Generator` (similar pattern).
- `react-refresh/only-export-components` × 4: each context file exports both a provider component and a `useXxx` hook.
- `@typescript-eslint/no-unused-vars`: `client.ts:19` (`_userId` parameter).

**Fix:** Two separate refactors:
- Move `useAuth/useDictionary/useGeneration/useKnownKanji` hooks into separate files (e.g., `useAuth.ts`) so context files only export the provider — fixes 4 errors.
- Audit the `set-state-in-effect` warnings individually; some are legitimate (e.g., resetting state on prop change) and may be `// eslint-disable-next-line`'d with a comment, others are real "this should be derived state" bugs. `KanjiContext.tsx:33`'s `refreshKnownKanji()` is fine as an effect (it's syncing user → known kanji).
- Drop unused `_userId` from `getKanji` if truly unused.

### 14. Missing `useCallback` deps; some effects also list nothing they read
**Evidence:**
- `client/src/hooks/useAudioPlayer.ts:141-145` — `useEffect` deps `[playbackRate, url]` reads `audioRef.current` and `playbackRate`. The `url` dep is irrelevant.

**Fix:** Run with `react-hooks/exhaustive-deps` as `error` (currently `warn` via the recommended preset) and address each warning individually.

### 15. ESLint config is minimal
**File:** `client/eslint.config.js` extends `js.configs.recommended`, `tseslint.configs.recommended`, `react-hooks.recommended`, `reactRefresh.configs.vite`. No strict tseslint, no `no-console`, no `no-unused-imports`.

**Fix:**
- Switch `tseslint.configs.recommended` → `tseslint.configs.strict`.
- Add `"no-console": ["warn", { allow: ["warn", "error"] }]`.
- Add `"@typescript-eslint/no-non-null-assertion": "warn"` to flag `!` patterns.
- Run `npm run lint` in CI (no CI config exists currently).

### 16. Magic 280ms in click-vs-doubleclick discrimination
**File:** `client/src/components/StoryDisplay.tsx:216` — `setTimeout(..., 280)`.

**Fix:** Extract `const SINGLE_CLICK_DELAY_MS = 280;` with a comment that it's slightly under the OS double-click threshold.

### 17. Vite has no bundle analyzer, no source-map config
**File:** `client/vite.config.ts` — only `react()` plugin.

**Fix:**
- Add `rollup-plugin-visualizer` to a `npm run analyze` script. Run before any release.
- Set `build.sourcemap: "hidden"` so production gets source-mapped errors in tools like Sentry but `.map` files aren't served publicly.

### 18. No request deduplication / caching
The codebase rolls its own data layer. KanjiManager and WordPopover both fetch kanji independently. Stories list goes stale after edits in another tab.

**Fix (judgment call):** Adopting React Query (`@tanstack/react-query`) is the bigger structural change but pays dividends — automatic dedup, cache, mutation invalidation, optimistic update primitives, devtools. If you don't want that lift now, at least add a tiny LRU around `getKanji` to dedup identical inflight calls.

### 19. ErrorBoundary fallback is non-recoverable for transient errors
**File:** `client/src/components/ErrorBoundary.tsx:24` — "Try again" only resets boundary state. If the error came from a render that re-throws on mount, you bounce right back into the error.

**Fix:** Optionally accept a `resetKey` prop and reset boundary state when it changes (so route changes auto-recover). Lower priority since route-level boundaries cover most cases.

### 20. No content-security-policy / no security headers
The Vite dev server and any production deploy don't appear to set CSP. The app renders LLM-generated content as JSX (safe — no `dangerouslySetInnerHTML` anywhere), but a future contributor adding it would be unguarded.

**Fix:** Set CSP at the hosting layer. At minimum: `default-src 'self'; connect-src 'self' https://*.supabase.co; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:`. Test thoroughly — Supabase and the audio CDN need explicit allow-lists.

---

## Tier 4 — Quick wins (small, mechanical)

| File | Line | Change |
|---|---|---|
| `client/src/components/ErrorBoundary.tsx` | 14 | Add `componentDidCatch` with `console.error` |
| `client/src/components/StoryDisplay.tsx` | 216 | Extract `SINGLE_CLICK_DELAY_MS` constant |
| `client/src/components/StoryDisplay.tsx` | 299 | Use stable keys in fallback paragraph map |
| `client/eslint.config.js` | 12-17 | Switch `recommended` → `strict`; add `no-console` rule |
| `client/src/api/client.ts` | 19 | Drop unused `_userId` param |
| `client/src/lib/generation.ts` | ~89 | `console.warn` when kanji missing from `kanjiMeta` |

---

## Findings checked and rejected

These came up in the audit but didn't survive verification:

- **"App routes lack ErrorBoundary"** — false. Each route in `App.tsx:24-73` is wrapped individually. Reasonable design (one bad route doesn't blank the app).
- **"AppLayout providers re-render the world"** — partial. The providers themselves are stateful components; AppLayout re-rendering doesn't trigger their internal renders. The real problem was provider *value identity* (already fixed in Tier 1).
- **"KanjiContext effect dep array is wrong"** — false. `useEffect(() => { refreshKnownKanji(); preloadTokenizer(); }, [refreshKnownKanji])` is correct: `refreshKnownKanji` is `useCallback([user])`, so the effect re-runs when user changes. Intentional.
- **"useAudioPlayer re-registers RAF every play tick"** — false. `[playing, audio]` deps mean it registers once per play session. Cleanup is correct.
- **"Settings page leaks API key into VITE_ env"** — false. Key flows through the `set_openrouter_api_key()` RPC into Vault; no client-side caching.

---

## Verification plan (when you action a finding)

1. **TypeScript**: `npm run build --workspace=client` should still pass. Tier-1 already enabled `noUncheckedIndexedAccess`.
2. **Lint**: `npm run lint --workspace=client` after ESLint tightening — expect new warnings to triage.
3. **Tests**: `npm test --workspace=client` — pure-lib tests should still pass; if you add a streaming test for `generateStoryStream`, mock fetch via Vitest's `vi.stubGlobal`.
4. **A11y manual check**: tab through StoryDisplay (sentence + word tokens both reachable), open WordPopover (focus trapped, Escape closes, focus returns to opener).
5. **Mobile**: load on iOS Safari, focus a search input — confirm no zoom and inputs render at full size.
6. **Perf**: open the kanji manager, filter to "all", profile re-render counts in React DevTools.

---

## Suggested ordering

1. **Reliability PR** — items #1, #4, #5, #6 (error boundaries log, SSE robustness, friendly HTTP errors). Self-contained and the user-visible reliability win.
2. **Tier 4 quick wins** — bundle into one cleanup PR. Constant extraction, console.warn, etc.
3. **KanjiManager AbortController** (#3) — solves a class of bugs the other pages also suffer from. While there, do `Stories.tsx` too.
4. **ESLint tightening** (#13, #15) — separate PR. Touches many files but mechanically. Then enable in CI.
5. **Design tokens** (#11, #12) — pure CSS refactor; easy to review.
6. **React Query** (#18) — its own initiative. Don't bundle.
7. **Lower-priority deferrable**: virtualization (#9), error tracking (#1 follow-up), CSP (#20).
