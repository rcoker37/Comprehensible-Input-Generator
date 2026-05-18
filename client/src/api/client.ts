import { supabase } from "../lib/supabase";
import {
  buildPrompt,
  PARAGRAPH_COUNT,
  UNSEEN_WORD_POOL_SIZE,
  type UnseenWordTarget,
} from "../lib/generation";
import { getTopUnseenWords, loadFrequencyIndex } from "../lib/frequency";
import { headwordFromHit } from "../lib/headword";
import type { LookupHit } from "../lib/lookupAtCursor";
import { WORD_INDEX_VERSION } from "../lib/storyWordIndex";
import type {
  ContentType,
  Formality,
  Kanji,
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

// All kanji rows (joyo set, ~2140 entries). Paginated because PostgREST caps
// each response at db-max-rows (1000 on Supabase Cloud). Cached in memory
// after the first call — the table is reference data and never changes from
// the client. Used by the Stats browse section.
let allKanjiCache: Kanji[] | null = null;
export async function getAllKanji(): Promise<Kanji[]> {
  if (allKanjiCache) return allKanjiCache;
  const PAGE = 1000;
  const out: Kanji[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("kanji")
      .select("character, grade, jlpt, meanings, readings_on, readings_kun")
      .order("character", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as Kanji[] | null) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  allKanjiCache = out;
  return out;
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
    topic?: string;
    style?: string;
    formality: Formality;
    model: string;
    seenKanji: Set<string>;
    unseenWordTarget: UnseenWordTarget;
    // Headwords (canonical surfaces) the user has encountered in a read
    // story — used to filter the unseen-common-words pool.
    seenWords: Set<string>;
  }
): Promise<{ storyId: number }> {
  // Allowed kanji = (kanji the user has seen in any read story)
  //               ∪ (JLPT N5 baseline, so a brand-new user still has
  //                  enough kanji to produce a readable story).
  const n5 = await getJlptN5Kanji();
  const allowedSet = new Set<string>([...params.seenKanji, ...n5]);
  const allowedKanji = [...allowedSet].join("");

  // Hand the model a pool of the user's most-frequent never-encountered words
  // so it can weave a few in naturally (see buildPrompt). Best-effort: a
  // frequency-index failure just drops the nudge and generation proceeds.
  let unseenWords: string[] = [];
  if (params.unseenWordTarget !== "none") {
    try {
      await loadFrequencyIndex();
      unseenWords = getTopUnseenWords(params.seenWords, UNSEEN_WORD_POOL_SIZE);
    } catch (err) {
      console.warn("Failed to build unseen-common-words pool:", err);
    }
  }

  const prompt = buildPrompt(
    params.contentType,
    PARAGRAPH_COUNT,
    allowedKanji,
    params.formality,
    params.topic,
    params.style,
    params.unseenWordTarget,
    unseenWords
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
      "id, title, content, content_type, topic, formality, difficulty, translations, read_count, first_read_at, last_read_at, status, error_message, word_index_at, created_at"
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

// Returns per-kanji exposure data for every kanji the user has seen in a read
// story: `exposures` is the read_count-weighted count (powers the header
// score and KanjiContext's "seen kanji" set), `lastRead` is the most recent
// read time (epoch ms) of any story containing the kanji (powers the Browse
// "last read" sort). Every contributing story has read_count > 0 so its
// last_read_at is set — `lastRead` has an entry for every seen kanji.
export async function getKanjiExposures(): Promise<{
  exposures: Map<string, number>;
  lastRead: Map<string, number>;
}> {
  const { data, error } = await supabase.rpc("user_underused_kanji", { p_limit: 10000 });
  if (error) throw new Error(error.message);
  const rows =
    (data as { kanji: string; exposures: number; last_read_at: string | null }[]) || [];
  const exposures = new Map<string, number>();
  const lastRead = new Map<string, number>();
  for (const r of rows) {
    exposures.set(r.kanji, r.exposures);
    if (r.last_read_at) lastRead.set(r.kanji, Date.parse(r.last_read_at));
  }
  return { exposures, lastRead };
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
 * stories, plus the most recent read time (epoch ms) of any story containing
 * each headword. `encounters` powers the vocab side of the header total score
 * (see VocabContext + lib/vocabScore.ts); `lastRead` powers the Browse
 * "last read" sort.
 */
export async function getUserWordEncounters(): Promise<{
  encounters: Map<string, number>;
  lastRead: Map<string, number>;
}> {
  const encounters = new Map<string, number>();
  const lastRead = new Map<string, number>();
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .rpc("get_user_word_encounters")
      .order("headword")
      .range(from, from + VOCAB_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows =
      (data as
        | { headword: string; encounters: number; last_read_at: string | null }[]
        | null) ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      encounters.set(r.headword, Number(r.encounters));
      if (r.last_read_at) lastRead.set(r.headword, Date.parse(r.last_read_at));
    }
    from += rows.length;
    if (rows.length < VOCAB_PAGE_SIZE) break;
  }
  return { encounters, lastRead };
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
 * deletes the story's existing non-manual rows, inserts the new set, and
 * stamps `stories.word_index_at` + `word_index_version`. Once `word_index_at`
 * is set the backfill won't touch the story again unless something nulls it
 * (content edit, override save / reset) — a `WORD_INDEX_VERSION` bump no
 * longer forces a re-index; the version is recorded as provenance only.
 * Returns the timestamp the row was stamped with so the client can update
 * its local Story state without a refetch.
 */
export async function indexStoryWords(
  storyId: number,
  occurrences: {
    start: number;
    end: number;
    surface: string;
    headword: string;
    reading: string;
    entryId: number | null;
  }[]
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
 * Returns every complete story whose word index is missing — `word_index_at`
 * is null — oldest first so the backfill processes least-recent stories
 * first. A null stamp means the story was never indexed, or its index was
 * explicitly cleared (content edit, override save / reset, which all null
 * `word_index_at` server-side). An algorithm change alone does NOT re-index
 * already-stamped stories; see `WORD_INDEX_VERSION` in `lib/storyWordIndex.ts`.
 *
 * Read state is intentionally not a gate here — the popover's "other usages"
 * carousel filters to read stories at the SQL layer (`get_word_usages`), but
 * we want the index built ahead of time so the carousel is instant the
 * moment a story is marked read.
 */
export async function getStoriesNeedingIndex(): Promise<
  { id: number; content: string }[]
> {
  const { data, error } = await supabase
    .from("stories")
    .select("id, content")
    .eq("status", "complete")
    .is("word_index_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as { id: number; content: string }[]) || [];
}

// Profiles

// Atomic shallow merge into `profiles.preferences`. Always send a section
// (`generator`, `stories`, or `reader`) in full — the SQL `||` operator
// replaces the entire sub-object, so a partial section clobbers its keys.
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

// Stories — manual overrides + content edit
//
// Both flows touch the same offset-keyed caches (story_word_occurrences,
// word_lookups, stories.translations) and rely on the backfill picking the
// story up via a NULL word_index_at. After calling either, the caller should
// refresh the local Story state (status fields, word_index_at) and trigger
// WordIndexBackfillContext.refresh() so the queue rehydrates.

export interface WordOverride {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string;
  /**
   * JMdict entry id picked from the override editor's candidate list.
   * Null when the user picked the "no dictionary entry" fallback for a
   * surface that has no JMdict hit (e.g. a misspelling like 野さい with
   * no entry of its own — the popover still gets the override's headword
   * but has no entry to hoist).
   */
  entryId: number | null;
  /**
   * True when the user chose "match as name" in the override editor —
   * the span is a proper noun (person, place, etc.) that JMdict would
   * not match. The popover renders a Name header instead of running a
   * dictionary lookup that would only produce false matches.
   */
  isName: boolean;
}

/**
 * One row in `story_word_occurrences` — either an algorithm-derived span
 * stamped by the backfill or a manual row placed via the override UI.
 * Used by StoryDisplay to render tap targets directly from the index so
 * manual overrides take effect immediately without re-tokenising client-side.
 */
export interface StoryOccurrence {
  start: number;
  end: number;
  surface: string;
  headword: string;
  reading: string | null;
  entryId: number | null;
  manual: boolean;
  isName: boolean;
}

export async function getStoryOccurrences(
  storyId: number
): Promise<StoryOccurrence[]> {
  const { data, error } = await supabase
    .from("story_word_occurrences")
    .select("start_offset, end_offset, surface, headword, reading, entry_id, manual, is_name")
    .eq("story_id", storyId)
    .order("start_offset", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    start: r.start_offset,
    end: r.end_offset,
    surface: r.surface,
    headword: r.headword,
    reading: r.reading,
    entryId: r.entry_id,
    manual: r.manual,
    isName: r.is_name,
  }));
}

/**
 * Replaces every occurrence row (manual or algorithm) intersecting
 * [regionStart, regionEnd) with the supplied overrides. Each override is
 * stored with `manual = TRUE` so subsequent re-indexes preserve it.
 */
export async function setStoryWordOverrides(
  storyId: number,
  regionStart: number,
  regionEnd: number,
  overrides: WordOverride[]
): Promise<void> {
  const { error } = await supabase.rpc("set_story_word_overrides", {
    p_story_id: storyId,
    p_region_start: regionStart,
    p_region_end: regionEnd,
    p_overrides: overrides,
  });
  if (error) throw new Error(error.message);
}

/**
 * Drops manual rows intersecting [regionStart, regionEnd) so the algorithm
 * can re-fill the gap on the next index pass.
 */
export async function clearStoryWordOverrides(
  storyId: number,
  regionStart: number,
  regionEnd: number
): Promise<void> {
  const { error } = await supabase.rpc("clear_story_word_overrides", {
    p_story_id: storyId,
    p_region_start: regionStart,
    p_region_end: regionEnd,
  });
  if (error) throw new Error(error.message);
}

/**
 * Drops every manual row for the story (the "reset all overrides" path
 * from StoryDetail) and nulls word_index_at so the algorithm re-fills the
 * full story.
 */
export async function clearAllStoryWordOverrides(
  storyId: number
): Promise<void> {
  const { error } = await supabase.rpc("clear_all_story_word_overrides", {
    p_story_id: storyId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Replaces the story's content and wipes every offset-keyed cache
 * (translations, word_lookups, story_word_occurrences — manual rows
 * included, since their offsets are now stale). The backfill re-indexes
 * the story on its next pass.
 */
export async function updateStoryContent(
  storyId: number,
  content: string
): Promise<void> {
  const { error } = await supabase.rpc("update_story_content", {
    p_story_id: storyId,
    p_content: content,
  });
  if (error) throw new Error(error.message);
}
