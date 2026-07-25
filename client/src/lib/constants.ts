/** Matches a single CJK Unified Ideograph (kanji). Use for `.test()` checks. */
export const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/;

/** Matches all CJK Unified Ideographs (kanji) in a string. Use for `.match()` / `.matchAll()`. */
export const KANJI_REGEX_G = /[\u4e00-\u9faf\u3400-\u4dbf]/g;

/**
 * Feature flag for the Chats feature. When false, the nav link and `/chats`
 * routes are hidden and the chat providers aren't mounted, so no chat data is
 * fetched and nothing chat-related renders. All chat code \u2014 pages, components,
 * contexts, `api/client.ts` chat calls, the `chat-message` Edge Function, and
 * the chat-specific RPCs \u2014 stays in the repo untouched, so the feature can be
 * revived by flipping this back to `true` (and reverting the migration that
 * removed the chat arm from the scoring RPCs). While this is off, read chat
 * messages are also excluded from vocab/kanji scoring server-side.
 */
export const CHATS_ENABLED = false;
