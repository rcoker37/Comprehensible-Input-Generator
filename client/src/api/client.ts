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
  Chat,
  ChatMessage,
  ChatMessageMarkUpdate,
  ChatMessageReadState,
  ContentType,
  Formality,
  Kanji,
  PerChatPayoutRow,
  Preferences,
  SentenceTranslation,
  Story,
  StoryReadState,
  WordUsage,
  WordUsageSource,
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
 * Translate a single sentence within a story or a chat message to natural
 * English. The translation is cached server-side on the source row's
 * `translations` JSONB keyed by the sentence's character offsets, so other
 * taps within the same sentence (and reopens) return instantly. Pass
 * `regenerate=true` to overwrite the cached translation with a fresh
 * model call.
 */
export async function translateSentence(
  source: { storyId: number } | { chatMessageId: number },
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
      ...("storyId" in source ? { story_id: source.storyId } : {}),
      ...("chatMessageId" in source ? { chat_message_id: source.chatMessageId } : {}),
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
  source: { storyId: number } | { chatMessageId: number },
  hit: LookupHit
): Promise<void> {
  const headword = headwordFromHit(hit);
  if (!headword) return;
  const { error } = await supabase.rpc("record_word_lookup", {
    p_story_id: "storyId" in source ? source.storyId : null,
    p_chat_message_id: "chatMessageId" in source ? source.chatMessageId : null,
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
 * read sources (read stories + read assistant chat messages), newest first
 * with in-text order within each source. `lookedUpAt` / `lookupCount` are
 * populated when the user has previously tapped the span (LEFT JOIN over
 * `word_lookups`) and otherwise null / 0.
 */
interface WordUsageRow {
  occurrence_id: number;
  source_type: WordUsageSource;
  story_id: number | null;
  chat_id: number | null;
  chat_message_id: number | null;
  source_title: string;
  source_content: string;
  source_created_at: string;
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
    sourceType: r.source_type,
    storyId: r.story_id,
    chatId: r.chat_id,
    chatMessageId: r.chat_message_id,
    sourceTitle: r.source_title,
    sourceContent: r.source_content,
    sourceCreatedAt: r.source_created_at,
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
 * stories. Powers the vocab side of the header total score (see VocabContext
 * + lib/vocabScore.ts).
 */
export async function getUserWordEncounters(): Promise<Map<string, number>> {
  const encounters = new Map<string, number>();
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .rpc("get_user_word_encounters")
      .order("headword")
      .range(from, from + VOCAB_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows =
      (data as { headword: string; encounters: number }[] | null) ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      encounters.set(r.headword, Number(r.encounters));
    }
    from += rows.length;
    if (rows.length < VOCAB_PAGE_SIZE) break;
  }
  return encounters;
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
 * stamps `stories.word_index_at` + `word_index_version`. The backfill won't
 * touch the story again unless something nulls `word_index_at` (content edit,
 * override save / reset) or `WORD_INDEX_VERSION` is bumped above the stamped
 * version. Returns the timestamp the row was stamped with so the client can
 * update its local Story state without a refetch.
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
    isName: boolean;
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
 * Returns every complete story whose word index is missing or stale, oldest
 * first so the backfill processes least-recent stories first. A story needs
 * (re)indexing when:
 *   - `word_index_at` is null — never indexed, or explicitly cleared by a
 *     content edit / override save / override reset; or
 *   - `word_index_version` is null or below the current `WORD_INDEX_VERSION`
 *     — indexed by an older generation of the pipeline.
 * So bumping `WORD_INDEX_VERSION` re-indexes the whole library on the next
 * backfill pass; the re-index re-stamps the version so each story drops out
 * of this query once it catches up. See `WORD_INDEX_VERSION` in
 * `lib/storyWordIndex.ts`.
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
    .or(
      `word_index_at.is.null,word_index_version.is.null,word_index_version.lt.${WORD_INDEX_VERSION}`
    )
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
   * True when the span is flagged as a proper noun (person, place, etc.)
   * that JMdict would not match. Set either by the indexer's auto-detection
   * of a 固有名詞 ruby block or by a "match as name" manual override. The
   * popover renders a Name header instead of running a dictionary lookup
   * that would only produce false matches.
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

// ─────────────────────────────────────────────────────────────────────────
// Chats
// ─────────────────────────────────────────────────────────────────────────

export async function getChats(): Promise<Chat[]> {
  const { data, error } = await supabase.rpc("get_chats_with_read_stats");
  if (error) throw new Error(error.message);
  return (data as Chat[]) || [];
}

export async function getChat(id: number): Promise<Chat> {
  const { data, error } = await supabase
    .from("chats")
    .select("id, title, created_at, last_activity_at")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return {
    ...(data as Omit<Chat, "min_assistant_read_count" | "last_read_at">),
    min_assistant_read_count: null,
    last_read_at: null,
  };
}

export async function getChatMessages(chatId: number): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select(
      "id, chat_id, role, content, status, error_message, read_count, first_read_at, last_read_at, word_index_at, translations, created_at"
    )
    .eq("chat_id", chatId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as ChatMessage[]) || [];
}

export async function getChatMessage(id: number): Promise<ChatMessage> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select(
      "id, chat_id, role, content, status, error_message, read_count, first_read_at, last_read_at, word_index_at, translations, created_at"
    )
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data as ChatMessage;
}

export interface SendChatMessageResult {
  chatId: number;
  userMessageId: number;
  assistantMessageId: number;
  chatCreated: boolean;
}

/**
 * Calls the `chat-message` Edge Function. Synchronously creates the chat
 * (if needed), the user message, and the assistant placeholder; returns
 * their IDs. The assistant body fills in asynchronously — poll
 * `getChatMessage(assistantMessageId)` until `status` flips off `pending`.
 */
export async function sendChatMessage(params: {
  chatId: number | null;
  userText: string;
  seenKanji: Set<string>;
  formality: Formality;
}): Promise<SendChatMessageResult> {
  const n5 = await getJlptN5Kanji();
  const allowedSet = new Set<string>([...params.seenKanji, ...n5]);
  const allowedKanji = [...allowedSet].join("");

  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const response = await fetch(`${supabaseUrl}/functions/v1/chat-message`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: params.chatId,
      user_text: params.userText,
      allowed_kanji: allowedKanji,
      formality: params.formality,
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Chat send failed" }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  const raw = (await response.json()) as {
    chat_id: number;
    user_message_id: number;
    assistant_message_id: number;
    chat_created: boolean;
  };
  return {
    chatId: raw.chat_id,
    userMessageId: raw.user_message_id,
    assistantMessageId: raw.assistant_message_id,
    chatCreated: raw.chat_created,
  };
}

export async function markChatMessageRead(messageId: number): Promise<ChatMessageReadState> {
  const { data, error } = await supabase.rpc("mark_chat_message_read", {
    p_message_id: messageId,
  });
  if (error) throw new Error(error.message);
  const row = (data as { read_count: number; first_read_at: string | null; last_read_at: string | null }[] | null)?.[0];
  if (!row) throw new Error("Chat message not found");
  return row;
}

export async function undoChatMessageRead(messageId: number): Promise<ChatMessageReadState> {
  const { data, error } = await supabase.rpc("undo_chat_message_read", {
    p_message_id: messageId,
  });
  if (error) throw new Error(error.message);
  const row = (data as { read_count: number; first_read_at: string | null; last_read_at: string | null }[] | null)?.[0];
  if (!row) throw new Error("Chat message not found");
  return row;
}

// Chat-level fan-out mark. Increments every complete assistant message in
// the chat by 1, subject to the per-message 5× cap and 24h cooldown.
// Returns one row per message that actually changed (cap/cooldown rows
// no-op and are omitted from the result). Empty array = nothing landed.
export async function markChatRead(chatId: number): Promise<ChatMessageMarkUpdate[]> {
  const { data, error } = await supabase.rpc("mark_chat_read", { p_chat_id: chatId });
  if (error) throw new Error(error.message);
  return (data as ChatMessageMarkUpdate[]) ?? [];
}

// Targeted decrement for the per-session undo affordance. `messageIds`
// is the list returned by the matching markChatRead call this session.
export async function undoChatRead(
  chatId: number,
  messageIds: number[],
): Promise<ChatMessageMarkUpdate[]> {
  const { data, error } = await supabase.rpc("undo_chat_read", {
    p_chat_id: chatId,
    p_message_ids: messageIds,
  });
  if (error) throw new Error(error.message);
  return (data as ChatMessageMarkUpdate[]) ?? [];
}

// Per-chat aggregated headword + kanji counts for every message that
// would actually contribute to the next chat-level mark. The Chats list
// page and ChatDetail's mark button both consume this to compute the
// `+X` payout via vocabScoreDelta / kanjiCountsDelta.
//
// Pages through PostgREST's `db-max-rows` cap (1000) — a healthy chat
// history easily blows past that across (chat × kind × key) tuples, and
// silent truncation was severely undercounting the score preview.
export async function getPerChatPayout(): Promise<PerChatPayoutRow[]> {
  const out: PerChatPayoutRow[] = [];
  for (let from = 0; ; ) {
    const { data, error } = await supabase
      .rpc("get_per_chat_payout")
      .order("chat_id")
      .order("kind")
      .order("key")
      .range(from, from + VOCAB_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data as PerChatPayoutRow[] | null) ?? [];
    if (rows.length === 0) break;
    for (const r of rows) {
      out.push({ ...r, count: Number(r.count) });
    }
    from += rows.length;
    if (rows.length < VOCAB_PAGE_SIZE) break;
  }
  return out;
}

export async function deleteChat(id: number): Promise<void> {
  const { error } = await supabase.rpc("delete_chat", { p_chat_id: id });
  if (error) throw new Error(error.message);
}

/**
 * Nulls `word_index_at` on every assistant message in the chat so the
 * backfill re-indexes them on its next pass. Analog of StoryDetail's
 * "reset overrides" ↻ button (chats have no per-region overrides, so this
 * is the only word-index affordance).
 */
export async function resetChatWordIndex(chatId: number): Promise<void> {
  const { error } = await supabase.rpc("reset_chat_word_index", {
    p_chat_id: chatId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Bulk-replace the assistant message's word-occurrence index. Analog of
 * `indexStoryWords`. Server stamps `chat_messages.word_index_at` +
 * `word_index_version` on success.
 */
export async function indexChatMessageWords(
  messageId: number,
  occurrences: {
    start: number;
    end: number;
    surface: string;
    headword: string;
    reading: string;
    entryId: number | null;
    isName: boolean;
  }[]
): Promise<string> {
  const { data, error } = await supabase.rpc("index_chat_message_words", {
    p_message_id: messageId,
    p_occurrences: occurrences,
    p_version: WORD_INDEX_VERSION,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/**
 * Per-occurrence rows in `story_word_occurrences` for one chat message —
 * used by ChatAssistantMessage to render tap targets directly from the index
 * (parallels `getStoryOccurrences`). Manual rows aren't possible for chats
 * in v1; `manual` will always be FALSE here.
 */
export async function getChatMessageOccurrences(
  messageId: number
): Promise<
  {
    start: number;
    end: number;
    surface: string;
    headword: string;
    reading: string | null;
    entryId: number | null;
    isName: boolean;
  }[]
> {
  const { data, error } = await supabase
    .from("story_word_occurrences")
    .select(
      "start_offset, end_offset, surface, headword, reading, entry_id, is_name"
    )
    .eq("chat_message_id", messageId)
    .order("start_offset", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    start: r.start_offset,
    end: r.end_offset,
    surface: r.surface,
    headword: r.headword,
    reading: r.reading,
    entryId: r.entry_id,
    isName: r.is_name,
  }));
}

export async function getChatMessageWordEncounters(
  messageId: number
): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc(
    "get_chat_message_word_encounters",
    { p_message_id: messageId }
  );
  if (error) throw new Error(error.message);
  const rows =
    (data as
      | { start_offset: number; end_offset: number; encounters: number }[]
      | null) ?? [];
  const map = new Map<string, number>();
  for (const r of rows) {
    map.set(`${r.start_offset}-${r.end_offset}`, Number(r.encounters));
  }
  return map;
}

/**
 * Assistant messages that need (re)indexing. Same criteria as
 * `getStoriesNeedingIndex` but on the chat_messages side. Filters to
 * status='complete' so pending placeholders are skipped.
 */
export async function getChatMessagesNeedingIndex(): Promise<
  { id: number; content: string }[]
> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, content")
    .eq("role", "assistant")
    .eq("status", "complete")
    .or(
      `word_index_at.is.null,word_index_version.is.null,word_index_version.lt.${WORD_INDEX_VERSION}`
    )
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data as { id: number; content: string }[]) || [];
}

/**
 * Any in-flight (`pending`) assistant messages owned by the caller. Used by
 * ChatGenerationContext on mount to resume polling for messages whose
 * generation was kicked off in a previous tab.
 */
export async function getPendingChatAssistantMessages(): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select(
      "id, chat_id, role, content, status, error_message, read_count, first_read_at, last_read_at, word_index_at, translations, created_at"
    )
    .eq("role", "assistant")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as ChatMessage[]) || [];
}

/**
 * Marks a 'pending' chat message as failed. Analog of `markStoryFailed`;
 * called by ChatGenerationContext when an in-flight assistant message
 * exceeds the stale threshold (the Edge Function died before flipping it).
 */
export async function markChatMessageFailed(
  id: number,
  errorMessage: string
): Promise<void> {
  const { error } = await supabase
    .from("chat_messages")
    .update({ status: "failed", error_message: errorMessage })
    .eq("id", id)
    .eq("status", "pending");
  if (error) throw new Error(error.message);
}
