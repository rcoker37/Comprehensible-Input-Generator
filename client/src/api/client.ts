import { supabase } from "../lib/supabase";
import { buildPrompt, type UnseenKanjiTarget } from "../lib/generation";
import { headwordFromHit } from "../lib/headword";
import type { LookupHit } from "../lib/lookupAtCursor";
import { WORD_INDEX_VERSION } from "../lib/storyWordIndex";
import type {
  ContentType,
  Formality,
  Preferences,
  SentenceTranslation,
  Story,
  StoryReadState,
  WordUsage,
} from "../types";

// Kanji

// Baseline kanji set the LLM is always allowed to use, regardless of what
// the user has read. JLPT N5 (the easiest level) — small, common, and
// sufficient to write something readable for a brand-new user.
let n5KanjiCache: Set<string> | null = null;
export async function getJlptN5Kanji(): Promise<Set<string>> {
  if (n5KanjiCache) return n5KanjiCache;
  const { data, error } = await supabase
    .from("kanji")
    .select("character")
    .eq("jlpt", 5);
  if (error) throw new Error(error.message);
  n5KanjiCache = new Set((data ?? []).map((r) => r.character));
  return n5KanjiCache;
}

// Stories — generation
//
// Generation runs as a background task in the `generate-story` Edge Function:
// the function inserts a placeholder `stories` row with status='generating',
// returns the story_id immediately, then completes the row asynchronously via
// EdgeRuntime.waitUntil. The client polls `getInFlightGeneration` until the
// row flips to 'complete' or 'failed'.

export async function startStoryGeneration(
  _userId: string,
  params: {
    contentType: ContentType;
    paragraphs: number;
    topic?: string;
    style?: string;
    formality: Formality;
    model: string;
    seenKanji: Set<string>;
    prioritizedKanji: string[];
    unseenKanjiTarget: UnseenKanjiTarget;
  }
): Promise<{ storyId: number }> {
  // Allowed kanji = (kanji the user has seen in any read story)
  //               ∪ (JLPT N5 baseline, so a brand-new user still has
  //                  enough kanji to produce a readable story).
  const n5 = await getJlptN5Kanji();
  const allowedSet = new Set<string>([...params.seenKanji, ...n5]);
  const allowedKanji = [...allowedSet].join("");
  const prompt = buildPrompt(
    params.contentType,
    params.paragraphs,
    allowedKanji,
    params.formality,
    params.topic,
    params.style,
    params.prioritizedKanji,
    params.unseenKanjiTarget
  );

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const response = await fetch(`${supabaseUrl}/functions/v1/generate-story`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      model: params.model,
      contentType: params.contentType,
      paragraphs: params.paragraphs,
      topic: params.topic || null,
      formality: params.formality,
      allowedKanji,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Generation failed" }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  const { story_id } = (await response.json()) as { story_id: number };
  return { storyId: story_id };
}

// Returns the user's most recent non-complete story (the in-flight generation
// row, or the most recent failure). Used by GenerationContext to hydrate state
// on mount and to poll until the row flips to a terminal status.
export async function getInFlightGeneration(): Promise<Story | null> {
  const { data, error } = await supabase
    .from("stories")
    .select("*")
    .in("status", ["generating", "failed"])
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return ((data as Story[]) || [])[0] ?? null;
}

// Marks a 'generating' row as failed. Called by GenerationContext when an
// in-flight row exceeds the stale threshold (the Edge Function silently died
// before it could update the row).
export async function markStoryFailed(id: number, errorMessage: string): Promise<void> {
  const { error } = await supabase
    .from("stories")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", id)
    .eq("status", "generating");
  if (error) throw new Error(error.message);
}

export async function getStories(): Promise<Story[]> {
  const { data, error } = await supabase
    .from("stories")
    .select(
      "id, title, content, content_type, paragraphs, topic, formality, difficulty, translations, read_count, first_read_at, last_read_at, status, error_message, word_index_at, created_at"
    )
    .eq("status", "complete")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as Story[]) || [];
}

export async function getReadStoryContents(): Promise<{ content: string; read_count: number }[]> {
  const { data, error } = await supabase
    .from("stories")
    .select("content, read_count")
    .eq("status", "complete")
    .gt("read_count", 0);
  if (error) throw new Error(error.message);
  return (data as { content: string; read_count: number }[]) || [];
}

export async function getStory(id: number): Promise<Story> {
  const { data, error } = await supabase
    .from("stories")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data as Story;
}

export async function markStoryRead(id: number): Promise<StoryReadState> {
  const { data, error } = await supabase.rpc("mark_story_read", { p_story_id: id });
  if (error) throw new Error(error.message);
  const row = (data as StoryReadState[] | null)?.[0];
  if (!row) throw new Error("Story not found");
  return row;
}

export async function undoStoryRead(id: number): Promise<StoryReadState> {
  const { data, error } = await supabase.rpc("undo_story_read", { p_story_id: id });
  if (error) throw new Error(error.message);
  const row = (data as StoryReadState[] | null)?.[0];
  if (!row) throw new Error("Story not found");
  return row;
}

export async function getUnderusedKanji(limit = 20): Promise<string[]> {
  const { data, error } = await supabase.rpc("user_underused_kanji", { p_limit: limit });
  if (error) throw new Error(error.message);
  return ((data as { kanji: string }[]) || []).map((r) => r.kanji);
}

// Returns exposure counts (read_count-weighted) for every kanji the user has
// seen in a read story. Powers the header total score, per-story score
// sorting, and the derived "seen kanji" set in KanjiContext.
export async function getKanjiExposures(): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc("user_underused_kanji", { p_limit: 10000 });
  if (error) throw new Error(error.message);
  const rows = (data as { kanji: string; exposures: number }[]) || [];
  return new Map(rows.map((r) => [r.kanji, r.exposures]));
}

export async function deleteStory(id: number): Promise<void> {
  const { error } = await supabase.from("stories").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Stories — sentence translations

/**
 * Translate a single sentence within a story to natural English. The
 * translation is cached server-side on `stories.translations` keyed by the
 * sentence's character offsets, so other taps within the same sentence
 * (and reopens) return instantly. Pass `regenerate=true` to overwrite the
 * cached translation with a fresh model call.
 */
export async function translateSentence(
  storyId: number,
  sentenceStart: number,
  sentenceEnd: number,
  regenerate = false
): Promise<SentenceTranslation> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const response = await fetch(`${supabaseUrl}/functions/v1/translate-sentence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      story_id: storyId,
      sentence_start: sentenceStart,
      sentence_end: sentenceEnd,
      ...(regenerate && { regenerate: true }),
    }),
  });

  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: "Translation failed" }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  const { translation } = await response.json();
  return translation as SentenceTranslation;
}

// Stories — word lookup history

/**
 * Records the user's lookup of a span. No-ops when the hit has no JMdict
 * results AND no deinflection base — we don't want to populate the history
 * with single-character "no entry" fallbacks. Errors are swallowed so a
 * failure here never blocks the popover render.
 */
export async function recordWordLookup(
  storyId: number,
  hit: LookupHit
): Promise<void> {
  const headword = headwordFromHit(hit);
  if (!headword) return;
  const { error } = await supabase.rpc("record_word_lookup", {
    p_story_id: storyId,
    p_start: hit.start,
    p_end: hit.end,
    p_surface: hit.surface,
    p_headword: headword.headword,
    p_reading: headword.reading ?? "",
  });
  if (error) {
    // Lookup history is best-effort; log but don't surface to the UI.
    console.warn("recordWordLookup failed:", error.message);
  }
}

/**
 * Returns every occurrence of the given headword across the user's tokenized
 * stories (newest stories first, in-text order within each story).
 * `lookedUpAt` / `lookupCount` are populated when the user has previously
 * tapped the span (LEFT JOIN over `word_lookups`) and otherwise null / 0.
 */
interface WordUsageRow {
  occurrence_id: number;
  story_id: number;
  story_title: string;
  story_content: string;
  story_created_at: string;
  start_offset: number;
  end_offset: number;
  surface: string;
  reading: string | null;
  looked_up_at: string | null;
  lookup_count: number;
}

export async function getWordUsages(headword: string): Promise<WordUsage[]> {
  const { data, error } = await supabase.rpc("get_word_usages", {
    p_headword: headword,
  });
  if (error) throw new Error(error.message);
  const rows = (data as WordUsageRow[] | null) ?? [];
  return rows.map((r) => ({
    occurrenceId: r.occurrence_id,
    storyId: r.story_id,
    storyTitle: r.story_title,
    storyContent: r.story_content,
    storyCreatedAt: r.story_created_at,
    startOffset: r.start_offset,
    endOffset: r.end_offset,
    surface: r.surface,
    reading: r.reading || null,
    lookedUpAt: r.looked_up_at,
    lookupCount: r.lookup_count,
  }));
}

/**
 * Total read-count-weighted encounters of `headword` across the user's
 * read stories (every read counts separately, mirroring kanji exposures).
 * Returns 0 when the user has never read a story containing it.
 */
export async function getWordEncounters(headword: string): Promise<number> {
  const { data, error } = await supabase.rpc("get_word_encounters", {
    p_headword: headword,
  });
  if (error) throw new Error(error.message);
  const n = typeof data === "number" ? data : Number(data ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Per-occurrence encounter counts for a single story — one row per indexed
 * span. Used by StoryDisplay to mark zero-encounter spans as new. Spans
 * that haven't been indexed yet are absent, so the caller defaults to
 * "unknown / don't highlight" for missing entries.
 */
export async function getStoryWordEncounters(
  storyId: number
): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc("get_story_word_encounters", {
    p_story_id: storyId,
  });
  if (error) throw new Error(error.message);
  const rows =
    (data as { start_offset: number; end_offset: number; encounters: number }[] | null) ?? [];
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.start_offset}-${r.end_offset}`, Number(r.encounters));
  }
  return map;
}

// PostgREST caps RPC responses at `db-max-rows` (1000 on Supabase Cloud)
// regardless of the query's actual size. Both vocab RPCs can exceed that
// once a user has a healthy reading history, so we page through with an
// ORDER BY (for stable pagination) and stop when we get a short page.
const VOCAB_PAGE_SIZE = 1000;

/**
 * Per-headword read-count-weighted encounter totals across the user's read
 * stories. Powers the vocab side of the header total score (see
 * VocabContext + lib/vocabScore.ts).
 */
export async function getUserWordEncounters(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .rpc("get_user_word_encounters")
      .order("headword")
      .range(from, from + VOCAB_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows =
      (data as { headword: string; encounters: number }[] | null) ?? [];
    if (rows.length === 0) break;
    for (const r of rows) map.set(r.headword, Number(r.encounters));
    from += rows.length;
    if (rows.length < VOCAB_PAGE_SIZE) break;
  }
  return map;
}

/**
 * Per-story per-headword raw within-story occurrence counts (NOT
 * read_count-weighted). Used by Compositions to compute the vocab payout
 * for each story card. Returns one Map per story keyed by headword.
 */
export async function getPerStoryWordOccurrences(): Promise<
  Map<number, Map<string, number>>
> {
  const out = new Map<number, Map<string, number>>();
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .rpc("get_per_story_word_occurrences")
      .order("story_id")
      .order("headword")
      .range(from, from + VOCAB_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows =
      (data as
        | { story_id: number; headword: string; occurrences: number }[]
        | null) ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      let inner = out.get(r.story_id);
      if (!inner) {
        inner = new Map<string, number>();
        out.set(r.story_id, inner);
      }
      inner.set(r.headword, Number(r.occurrences));
    }
    from += rows.length;
    if (rows.length < VOCAB_PAGE_SIZE) break;
  }
  return out;
}

/**
 * Bulk-replace the calling user's word-occurrence index for a story. Server
 * deletes existing rows for the story, inserts the new set, and stamps
 * `stories.word_index_at` + `word_index_version` so the indexer doesn't
 * re-run on subsequent reads unless `WORD_INDEX_VERSION` has since moved
 * past the stamped value. Returns the timestamp the row was stamped with
 * so the client can update its local Story state without a refetch.
 */
export async function indexStoryWords(
  storyId: number,
  occurrences: { start: number; end: number; surface: string; headword: string; reading: string }[]
): Promise<string> {
  const { data, error } = await supabase.rpc("index_story_words", {
    p_story_id: storyId,
    p_occurrences: occurrences,
    p_version: WORD_INDEX_VERSION,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * Returns every complete story whose word index is missing OR was stamped
 * against an older `WORD_INDEX_VERSION` — oldest first so the backfill
 * processes least-recent stories first. Read state is intentionally not a
 * gate here — the popover's "other usages" carousel filters to read
 * stories at the SQL layer (`get_word_usages`), but we want the index
 * built ahead of time so the carousel is instant the moment a story is
 * marked read.
 */
export async function getStoriesNeedingIndex(): Promise<
  { id: number; content: string }[]
> {
  const { data, error } = await supabase
    .from("stories")
    .select("id, content")
    .eq("status", "complete")
    .or(
      `word_index_at.is.null,word_index_version.is.null,word_index_version.lt.${WORD_INDEX_VERSION}`
    )
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as { id: number; content: string }[]) || [];
}

// Profiles

// Atomic shallow merge into `profiles.preferences`. Always send a section
// (`generator` or `stories`) in full — the SQL `||` operator replaces the
// entire sub-object, so a partial section would clobber unrelated keys.
export async function updatePreferences(patch: Preferences): Promise<void> {
  const { error } = await supabase.rpc("update_preferences", { p_patch: patch });
  if (error) throw new Error(error.message);
}

export async function setOpenRouterApiKey(key: string): Promise<void> {
  const { error } = await supabase.rpc("set_openrouter_api_key", { p_key: key });
  if (error) throw new Error(error.message);
}

export async function clearOpenRouterApiKey(): Promise<void> {
  const { error } = await supabase.rpc("clear_openrouter_api_key");
  if (error) throw new Error(error.message);
}
