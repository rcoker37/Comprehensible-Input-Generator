/** Matches a single CJK Unified Ideograph (kanji). Use for `.test()` checks. */
export const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/;

/** Matches all CJK Unified Ideographs (kanji) in a string. Use for `.match()` / `.matchAll()`. */
export const KANJI_REGEX_G = /[\u4e00-\u9faf\u3400-\u4dbf]/g;

/** Annotation schema version the client expects. Bumped in lock-step with
 * `ANNOTATION_VERSION` in supabase/functions/annotate-story/index.ts. Stories
 * whose stored annotations predate this are re-annotated on next tap. */
export const CURRENT_ANNOTATION_VERSION = 4;
