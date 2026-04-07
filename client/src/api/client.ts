import { supabase } from "../lib/supabase";
import type { Kanji, KanjiStats, Story, Formality, GenerationProgress } from "../types";

// Kanji

export async function getKanji(
  userId: string,
  params?: { search?: string; jlpt?: number[]; grade?: number[] }
): Promise<Kanji[]> {
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

  // Client-side filtering (the RPC returns all kanji sorted by grade)
  if (params?.jlpt && params.jlpt.length > 0) {
    results = results.filter((k) => k.jlpt !== null && params.jlpt!.includes(Number(k.jlpt)));
  }
  if (params?.grade && params.grade.length > 0) {
    results = results.filter((k) => params.grade!.includes(Number(k.grade)));
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
    filtered = filtered.filter((k) => k.jlpt !== null && params.jlpt!.includes(Number(k.jlpt)));
  }
  if (params.grade && params.grade.length > 0) {
    filtered = filtered.filter((k) => params.grade!.includes(Number(k.grade)));
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
  2: "You may use advanced grammar freely.",
  1: "You may use advanced grammar freely.",
};

function buildPrompt(
  paragraphs: number,
  kanjiList: string,
  formality: Formality,
  grammarLevel: number,
  topic?: string
): string {
  const parts = [
    "You are a Japanese language teacher writing a short story for a student learning Japanese.",
    "",
    `CRITICAL RULE: You MUST only use the following kanji characters: ${kanjiList}`,
    "You may freely use hiragana and katakana. Do NOT use any kanji not in the list above, and do NOT repeat the entire list in your thinking tokens.",
    "IMPORTANT: You MUST actively use kanji from the allowed list throughout the story. Do not write entirely in hiragana — use the allowed kanji wherever they would naturally appear in Japanese text.",
    "",
    GRAMMAR_GUIDANCE[grammarLevel] || GRAMMAR_GUIDANCE[2],
    "",
    FORMALITY_INSTRUCTIONS[formality],
  ];

  if (topic) {
    parts.push("", `The story should be about: ${topic}`);
  }

  parts.push(
    "",
    `Write exactly ${paragraphs} paragraphs.`,
    "",
    "Output ONLY the story in Japanese. Start with a short title on the first line. Do not include any English text, explanations, or translations."
  );

  return parts.join("\n");
}

const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/g;

function findViolations(text: string, allowedKanji: Set<string>): string[] {
  const allKanji = text.match(KANJI_REGEX) || [];
  return [...new Set(allKanji.filter((k) => !allowedKanji.has(k)))];
}

async function getViolationReadings(
  text: string,
  violations: string[],
  edgeFunctionUrl: string,
  accessToken: string
): Promise<Record<string, string>> {
  // Extract sentences containing violations for context
  const violationSet = new Set(violations);
  const sentences = text.split(/[。！？\n]/).filter((s) =>
    [...s].some((ch) => violationSet.has(ch))
  );
  const contextText = sentences.join("。");

  const prompt = [
    "Given this Japanese text, provide the hiragana reading for each of the listed kanji AS USED IN THIS CONTEXT.",
    "",
    `Text: ${contextText}`,
    "",
    `Kanji to read: ${violations.join(", ")}`,
    "",
    "Return ONLY a JSON object mapping each kanji character to its hiragana reading in this context.",
    'Example: {"経": "けい", "験": "けん"}',
    "Output ONLY the JSON, nothing else.",
  ].join("\n");

  const response = await fetch(edgeFunctionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt, model: "deepseek/deepseek-v3.2", stream: false }),
  });

  if (!response.ok) return {};

  const body = await response.json();
  const content = body.choices?.[0]?.message?.content || "";

  try {
    // Extract JSON from response (model might wrap in ```json blocks)
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]);
  } catch {
    return {};
  }
}

export function annotateWithRuby(
  text: string,
  readings: Record<string, string>
): string {
  let result = "";
  for (const ch of text) {
    if (readings[ch]) {
      result += `<ruby>${ch}<rt>${readings[ch]}</rt></ruby>`;
    } else {
      result += ch;
    }
  }
  return result;
}

function computeDifficulty(
  text: string,
  kanjiMeta: Map<string, { grade: number; jlpt: number | null }>
) {
  const usedKanji = [...new Set(text.match(KANJI_REGEX) || [])];
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
    paragraphs: number;
    topic?: string;
    formality: Formality;
  },
  onProgress: (progress: GenerationProgress) => void
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
    params.paragraphs,
    allowedKanji,
    params.formality,
    2,
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
      body: JSON.stringify({ prompt, model: "deepseek/deepseek-r1-0528" }),
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

  onProgress({ phase: "checking", reasoning: fullReasoning, content: fullText });

  // Parse title and content
  const textLines = fullText.split("\n").filter((l) => l.trim());
  const title = textLines[0] || "無題";
  const content = textLines.slice(1).join("\n\n");

  // Detect kanji violations
  const violations = findViolations(fullText, allowedSet);
  let violationReadings: Record<string, string> = {};

  if (violations.length > 0) {
    violationReadings = await getViolationReadings(
      fullText,
      violations,
      edgeFunctionUrl,
      accessToken
    );
  }

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
      paragraphs: params.paragraphs,
      topic: params.topic || null,
      formality: params.formality,
      filters: { knownOnly: true, jlptLevels: [], grades: [] },
      allowed_kanji: allowedKanji,
      difficulty,
      violations,
      violation_readings: violationReadings,
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
