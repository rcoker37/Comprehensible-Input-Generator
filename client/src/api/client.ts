import { supabase } from "../lib/supabase";
import { KANJI_REGEX_G } from "../lib/constants";
import { buildPrompt, type UnknownKanjiTarget } from "../lib/generation";
import { headwordFromHit } from "../lib/headword";
import type { LookupHit } from "../lib/lookupAtCursor";
import { WORD_INDEX_VERSION } from "../lib/storyWordIndex";
import type {
  ContentType,
  Formality,
  Kanji,
  KanjiStats,
  Story,
  StoryReadState,
  WordThread,
  WordThreadsByThread,
  WordUsage,
} from "../types";

// Kanji

export async function getKanji(_userId: string): Promise<Kanji[]> {
  const PAGE_SIZE = 1000;
  let results: Kanji[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .rpc("get_user_kanji")
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data as Kanji[]) || [];
    results = results.concat(page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return results;
}

export function filterKanji(
  kanji: Kanji[],
  params: { search?: string; jlpt?: number[]; grade?: number[] }
): Kanji[] {
  let results = kanji;
  const jlptFilter = params.jlpt;
  if (jlptFilter && jlptFilter.length > 0) {
    results = results.filter((k) => k.jlpt !== null && jlptFilter.includes(Number(k.jlpt)));
  }
  const gradeFilter = params.grade;
  if (gradeFilter && gradeFilter.length > 0) {
    results = results.filter((k) => gradeFilter.includes(Number(k.grade)));
  }
  if (params.search) {
    const s = params.search.toLowerCase();
    const kanjiInSearch = s.match(KANJI_REGEX_G);
    if (kanjiInSearch && kanjiInSearch.length > 1) {
      const kanjiSet = new Set(kanjiInSearch);
      results = results.filter((k) => kanjiSet.has(k.character));
    } else {
      results = results.filter(
        (k) =>
          k.character.includes(s) ||
          k.meanings.toLowerCase().includes(s) ||
          k.readings_on.includes(s) ||
          k.readings_kun.includes(s)
      );
    }
  }
  return results;
}

export async function getKanjiStats(userId: string): Promise<KanjiStats> {
  const [{ count: total }, { count: known }] = await Promise.all([
    supabase.from("kanji").select("*", { count: "exact", head: true }),
    supabase
      .from("user_kanji")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("known", true),
  ]);

  return { total: total || 0, known: known || 0 };
}

export async function toggleKanji(
  userId: string,
  character: string,
  currentlyKnown: boolean
): Promise<boolean> {
  const newKnown = !currentlyKnown;

  if (newKnown) {
    // Upsert as known
    const { error } = await supabase
      .from("user_kanji")
      .upsert({ user_id: userId, character, known: true });
    if (error) throw new Error(error.message);
  } else {
    // Delete the row (absence = unknown)
    const { error } = await supabase
      .from("user_kanji")
      .delete()
      .eq("user_id", userId)
      .eq("character", character);
    if (error) throw new Error(error.message);
  }

  return newKnown;
}

export async function bulkUpdateKanji(
  userId: string,
  action: "markKnown" | "markUnknown",
  filter: { grades?: number[]; jlptLevels?: number[] }
): Promise<number> {
  // Get matching kanji characters
  let query = supabase.from("kanji").select("character");
  if (filter.grades && filter.grades.length > 0) {
    query = query.in("grade", filter.grades);
  }
  if (filter.jlptLevels && filter.jlptLevels.length > 0) {
    query = query.in("jlpt", filter.jlptLevels);
  }

  const { data: kanjiRows, error } = await query;
  if (error) throw new Error(error.message);
  if (!kanjiRows || kanjiRows.length === 0) return 0;

  const characters = kanjiRows.map((r) => r.character);

  if (action === "markKnown") {
    // Batch upsert in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < characters.length; i += CHUNK) {
      const chunk = characters.slice(i, i + CHUNK);
      const rows = chunk.map((character) => ({
        user_id: userId,
        character,
        known: true,
      }));
      const { error } = await supabase.from("user_kanji").upsert(rows);
      if (error) throw new Error(error.message);
    }
  } else {
    // Delete rows (absence = unknown)
    const { error } = await supabase
      .from("user_kanji")
      .delete()
      .eq("user_id", userId)
      .in("character", characters);
    if (error) throw new Error(error.message);
  }

  return characters.length;
}

// Stories — generation
//
// Generation runs as a background task in the `generate-story` Edge Function:
// the function inserts a placeholder `stories` row with status='generating',
// returns the story_id immediately, then completes the row asynchronously via
// EdgeRuntime.waitUntil. The client polls `getInFlightGeneration` until the
// row flips to 'complete' or 'failed'.

export async function startStoryGeneration(
  userId: string,
  params: {
    contentType: ContentType;
    paragraphs: number;
    topic?: string;
    style?: string;
    formality: Formality;
    model: string;
    prioritizedKanji: string[];
    unknownKanjiTarget: UnknownKanjiTarget;
  }
): Promise<{ storyId: number }> {
  const allKanji = await getKanji(userId);
  const filtered = allKanji.filter((k) => k.known);

  if (filtered.length === 0) {
    throw new Error(
      "You haven't marked any kanji as known yet. Go to Kanji Manager to mark some kanji."
    );
  }

  const allowedKanji = [...new Set(filtered.map((k) => k.character))].join("");
  const prompt = buildPrompt(
    params.contentType,
    params.paragraphs,
    allowedKanji,
    params.formality,
    params.topic,
    params.style,
    params.prioritizedKanji,
    params.unknownKanjiTarget
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
      "id, title, content, content_type, paragraphs, topic, formality, filters, difficulty, read_count, first_read_at, last_read_at, word_index_at, created_at"
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

// Returns exposure counts (read_count-weighted) for every known kanji. Used by
// rarity-based story sorting. The RPC orders by exposure ASC, so passing a
// limit larger than the joyo set returns the full known-kanji exposure map.
export async function getKnownKanjiExposures(): Promise<Map<string, number>> {
  const { data, error } = await supabase.rpc("user_underused_kanji", { p_limit: 10000 });
  if (error) throw new Error(error.message);
  const rows = (data as { kanji: string; exposures: number }[]) || [];
  return new Map(rows.map((r) => [r.kanji, r.exposures]));
}

export async function deleteStory(id: number): Promise<void> {
  const { error } = await supabase.from("stories").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

// Stories — word conversation threads

export async function askWord(
  storyId: number,
  startOffset: number,
  endOffset: number,
  threadId: string,
  question: string,
  regenerate = false
): Promise<WordThread> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const response = await fetch(`${supabaseUrl}/functions/v1/ask-word`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      story_id: storyId,
      start_offset: startOffset,
      end_offset: endOffset,
      thread_id: threadId,
      question,
      ...(regenerate && { regenerate: true }),
    }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Ask failed" }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  const { thread } = await response.json();
  return thread as WordThread;
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
 * stories (newest stories first, in-text order within each story). Each row
 * carries any chip threads stored at that span; `lookedUpAt` / `lookupCount`
 * are populated when the user has previously tapped the span (LEFT JOIN over
 * `word_lookups`) and otherwise null / 0.
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
  threads: WordThreadsByThread | null;
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
    threads: r.threads ?? {},
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

export async function updateProfile(
  userId: string,
  fields: {
    preferred_model?: string;
    preferred_content_type?: string;
    preferred_formality?: string;
    preferred_paragraphs?: number;
    preferred_unknown_kanji_target?: string;
    preferred_prioritize_rare_kanji?: boolean;
  }
): Promise<void> {
  const { error } = await supabase
    .from("profiles")
    .update(fields)
    .eq("user_id", userId);
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
