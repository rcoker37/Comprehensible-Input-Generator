import { supabase } from "../lib/supabase";
import { KANJI_REGEX_G } from "../lib/constants";
import { stripBold } from "../lib/text";
import { buildPrompt, computeDifficulty } from "../lib/generation";
import type { Kanji, KanjiStats, Story, Formality, ContentType, GenerationProgress } from "../types";

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
  if (params.jlpt && params.jlpt.length > 0) {
    results = results.filter((k) => k.jlpt !== null && params.jlpt!.includes(Number(k.jlpt)));
  }
  if (params.grade && params.grade.length > 0) {
    results = results.filter((k) => params.grade!.includes(Number(k.grade)));
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

export async function generateStoryStream(
  userId: string,
  params: {
    contentType: ContentType;
    paragraphs: number;
    topic?: string;
    formality: Formality;
    grammarLevel: number;
    model: string;
  },
  onProgress: (progress: GenerationProgress) => void,
  signal?: AbortSignal
): Promise<Story> {
  // Build allowed kanji list from known kanji
  const allKanji = await getKanji(userId);
  const filtered = allKanji.filter((k) => k.known);

  if (filtered.length === 0) {
    throw new Error(
      "You haven't marked any kanji as known yet. Go to Kanji Manager to mark some kanji."
    );
  }

  const allowedSet = new Set(filtered.map((k) => k.character));
  const allowedKanji = [...allowedSet].join("");

  const prompt = buildPrompt(
    params.contentType,
    params.paragraphs,
    allowedKanji,
    params.formality,
    params.grammarLevel,
    params.topic
  );

  // Get auth token for the edge function
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Not authenticated");

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const edgeFunctionUrl = `${supabaseUrl}/functions/v1/generate-story`;

  // Call edge function with raw fetch for streaming
  const response = await fetch(edgeFunctionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, model: params.model }),
      signal,
    });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Generation failed" }));
    throw new Error(body.error || `HTTP ${response.status}`);
  }

  // Read SSE stream
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let fullReasoning = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") continue;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta;
        const reasoning = delta?.reasoning;
        const content = delta?.content;
        if (reasoning) {
          fullReasoning += reasoning;
          onProgress({ phase: "thinking", reasoning: fullReasoning, content: fullText });
        }
        if (content) {
          fullText += content;
          onProgress({ phase: "generating", reasoning: fullReasoning, content: fullText });
        }
      } catch (e) {
        if (import.meta.env.DEV) {
          console.debug("Skipped malformed SSE chunk:", data, e);
        }
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error("No content received from the model");
  }

  // Parse title and content, strip markdown bold markers the model sometimes adds
  const clean = stripBold(fullText);
  const textLines = clean.split("\n").filter((l) => l.trim());
  const title = textLines[0] || "無題";
  const content = textLines.slice(1).join("\n\n");

  // Compute difficulty client-side
  const kanjiMeta = new Map(
    allKanji.map((k) => [k.character, { grade: k.grade, jlpt: k.jlpt }])
  );
  const difficulty = computeDifficulty(fullText, kanjiMeta);

  // Save story directly via Supabase (RLS allows user inserts)
  const { data: story, error: insertError } = await supabase
    .from("stories")
    .insert({
      user_id: userId,
      title,
      content,
      content_type: params.contentType,
      paragraphs: params.paragraphs,
      topic: params.topic || null,
      formality: params.formality,
      filters: { knownOnly: true, jlptLevels: [], grades: [] },
      allowed_kanji: allowedKanji,
      difficulty,
    })
    .select()
    .single();

  if (insertError) throw new Error(`Failed to save story: ${insertError.message}`);
  return story as Story;
}

export async function getStories(): Promise<Story[]> {
  const { data, error } = await supabase
    .from("stories")
    .select(
      "id, title, content, content_type, paragraphs, topic, formality, filters, difficulty, created_at"
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

// Profiles

export async function updateProfile(
  userId: string,
  fields: {
    preferred_model?: string;
    preferred_content_type?: string;
    preferred_formality?: string;
    preferred_grammar_level?: number;
    preferred_paragraphs?: number;
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

export async function getOpenRouterUsage(signal?: AbortSignal): Promise<{
  usage: number;
  limit: number | null;
} | null> {
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) return null;

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const url = `${supabaseUrl}/functions/v1/openrouter-usage`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
    signal,
  });
  if (!response.ok) return null;
  const body = await response.json();
  if (!body?.data) return null;
  return { usage: body.data.usage, limit: body.data.limit ?? null };
}
