import { supabase } from "../lib/supabase";
import type { Kanji, KanjiStats, Story, StoryFilters, Formality, GenerateRequest } from "../types";

// Kanji

export async function getKanji(
  userId: string,
  params?: { search?: string; jlpt?: number[]; grade?: number[] }
): Promise<Kanji[]> {
  const { data, error } = await supabase.rpc("get_user_kanji", {
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);

  let results = (data as Kanji[]) || [];

  // Client-side filtering (the RPC returns all kanji sorted by grade)
  if (params?.jlpt && params.jlpt.length > 0) {
    results = results.filter((k) => k.jlpt !== null && params.jlpt!.includes(k.jlpt));
  }
  if (params?.grade && params.grade.length > 0) {
    results = results.filter((k) => params.grade!.includes(k.grade));
  }
  if (params?.search) {
    const s = params.search.toLowerCase();
    results = results.filter(
      (k) =>
        k.character.includes(s) ||
        k.meanings.toLowerCase().includes(s) ||
        k.readings_on.includes(s) ||
        k.readings_kun.includes(s)
    );
  }

  return results;
}

export async function getKanjiStats(userId: string): Promise<KanjiStats> {
  const { count: total } = await supabase
    .from("kanji")
    .select("*", { count: "exact", head: true });

  const { count: known } = await supabase
    .from("user_kanji")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("known", true);

  return { total: total || 0, known: known || 0 };
}

export async function getKanjiCount(
  userId: string,
  params: { knownOnly?: boolean; jlpt?: number[]; grade?: number[] }
): Promise<number> {
  // Use the RPC and filter client-side for count (simpler than complex SQL)
  const all = await getKanji(userId);
  let filtered = all;

  if (params.knownOnly) {
    filtered = filtered.filter((k) => k.known);
  }
  if (params.jlpt && params.jlpt.length > 0) {
    filtered = filtered.filter((k) => k.jlpt !== null && params.jlpt!.includes(k.jlpt));
  }
  if (params.grade && params.grade.length > 0) {
    filtered = filtered.filter((k) => params.grade!.includes(k.grade));
  }

  return filtered.length;
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

// Stories

export async function generateStory(
  userId: string,
  params: {
    paragraphs: number;
    topic?: string;
    formality: Formality;
    filters: StoryFilters;
  }
): Promise<Story> {
  // Build allowed kanji list client-side to avoid DB queries in the edge function
  const allKanji = await getKanji(userId);
  let filtered = allKanji;

  if (params.filters.knownOnly) {
    filtered = filtered.filter((k) => k.known);
  }
  if (params.filters.jlptLevels.length > 0) {
    filtered = filtered.filter(
      (k) => k.jlpt !== null && params.filters.jlptLevels.includes(k.jlpt)
    );
  }
  if (params.filters.grades.length > 0) {
    filtered = filtered.filter((k) => params.filters.grades.includes(k.grade));
  }

  if (filtered.length === 0) {
    throw new Error(
      "No kanji match the current filters. Adjust your filters and try again."
    );
  }

  const allowedKanji = filtered.map((k) => k.character).join("");
  const kanjiMeta: Record<string, { grade: number; jlpt: number | null }> = {};
  for (const k of allKanji) {
    kanjiMeta[k.character] = { grade: k.grade, jlpt: k.jlpt };
  }

  const req: GenerateRequest = {
    ...params,
    allowedKanji,
    kanjiMeta,
  };

  const { data, error } = await supabase.functions.invoke("generate-story", {
    body: req,
  });
  if (error) throw new Error(error.message);
  return data as Story;
}

export async function getStories(): Promise<Story[]> {
  const { data, error } = await supabase
    .from("stories")
    .select(
      "id, title, paragraphs, topic, formality, filters, difficulty, created_at"
    )
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data as Story[]) || [];
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

export async function deleteStory(id: number): Promise<void> {
  const { error } = await supabase.from("stories").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
