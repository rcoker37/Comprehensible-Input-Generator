import { supabase } from "../lib/supabase";
import { KANJI_REGEX_G } from "../lib/constants";
import { stripBold } from "../lib/text";
import type { Kanji, KanjiStats, Story, Formality, ContentType, GenerationProgress } from "../types";

// Kanji

export async function getKanji(userId: string): Promise<Kanji[]> {
  const PAGE_SIZE = 1000;
  let results: Kanji[] = [];
  let offset = 0;
  while (true) {
    const { data, error } = await supabase.rpc("get_user_kanji", {
      p_user_id: userId,
    }).range(offset, offset + PAGE_SIZE - 1);
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

// Stories — prompt building & generation

const FORMALITY_INSTRUCTIONS: Record<Formality, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

const GRAMMAR_GUIDANCE: Record<number, string> = {
  5: "Use only basic grammar: て-form, ます-form, basic particles (は, が, を, に, で, へ), です/だ, simple adjectives.",
  4: "Use up to JLPT N4 grammar: conditionals (たら/ば), passive basics, てある/ている, たい-form, ～ことができる.",
  3: "Use up to JLPT N3 grammar: causative, passive, compound sentences, ようにする, ～ために, ～ことにする.",
  2: "Use up to JLPT N2 grammar: ～わけではない, ～に対して, ～ことから, ～一方で, ～とは限らない, formal conjunctions (したがって, それにもかかわらず).",
  1: "You may use any grammar freely, including literary and classical forms.",
};

const CONTENT_TYPE_PREAMBLE: Record<ContentType, string> = {
  story: "You are a Japanese language teacher writing a short story for a student learning Japanese.",
  dialogue: "You are a Japanese language teacher writing a dialogue between two characters for a student learning Japanese.",
  essay: "You are a Japanese language teacher writing a short essay for a student learning Japanese.",
};

const CONTENT_TYPE_LENGTH: Record<ContentType, (n: number) => string> = {
  story: (n) => `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`,
  dialogue: (n) => `Write exactly ${n} exchanges. Each exchange is one back-and-forth between two characters (two lines). Format each line as 「Name：dialogue」 with brief scene or action descriptions between exchanges where natural.`,
  essay: (n) => `Write exactly ${n} paragraphs. Each paragraph should be at least 4-5 sentences long.`,
};

const CONTENT_TYPE_TOPIC_LABEL: Record<ContentType, string> = {
  story: "The story should be about",
  dialogue: "The dialogue should be about",
  essay: "The essay should be about",
};

function buildPrompt(
  contentType: ContentType,
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  grammarLevel: number,
  topic?: string
): string {
  const parts = [
    CONTENT_TYPE_PREAMBLE[contentType],
    "",
    `Allowed kanji: ${kanjiList}`,
    "Rules:",
    "- Try to only use kanji from the list above, minimizing usage of kanji not in the list. Use hiragana and katakana freely.",
    "- Actively use allowed kanji throughout — do not write entirely in hiragana.",
    "- If a word needs kanji not in the list, rephrase with simpler vocabulary rather than writing it in hiragana.",
    "",
    GRAMMAR_GUIDANCE[grammarLevel] || GRAMMAR_GUIDANCE[2],
    "",
    FORMALITY_INSTRUCTIONS[formality],
  ];

  if (topic) {
    parts.push("", `${CONTENT_TYPE_TOPIC_LABEL[contentType]}: ${topic}`);
  }

  parts.push(
    "",
    CONTENT_TYPE_LENGTH[contentType](paragraphs),
    "",
    "Output ONLY the content in Japanese. Start with a short title on the first line. Do not include any English text, explanations, or translations."
  );

  return parts.join("\n");
}

function computeDifficulty(
  text: string,
  kanjiMeta: Map<string, { grade: number; jlpt: number | null }>
) {
  const usedKanji = [...new Set(text.match(KANJI_REGEX_G) || [])];
  if (usedKanji.length === 0) {
    return { uniqueKanji: 0, grade: { max: 0, avg: 0 }, jlpt: { min: 0, avg: 0 } };
  }
  const rows = usedKanji.map((k) => kanjiMeta.get(k)).filter((r) => r != null);
  const grades = rows.map((r) => r.grade);
  const jlpts = rows.filter((r) => r.jlpt != null).map((r) => r.jlpt!);
  return {
    uniqueKanji: usedKanji.length,
    grade: {
      max: grades.length > 0 ? Math.max(...grades) : 0,
      avg: grades.length > 0 ? Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 10) / 10 : 0,
    },
    jlpt: {
      min: jlpts.length > 0 ? Math.min(...jlpts) : 0,
      avg: jlpts.length > 0 ? Math.round((jlpts.reduce((a, b) => a + b, 0) / jlpts.length) * 10) / 10 : 0,
    },
  };
}

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
      } catch {
        // skip malformed chunks
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
    openrouter_api_key?: string | null;
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
