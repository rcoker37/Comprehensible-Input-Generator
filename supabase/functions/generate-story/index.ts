import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Formality = "impolite" | "casual" | "polite" | "keigo";

interface StoryFilters {
  knownOnly: boolean;
  jlptLevels: number[];
  grades: number[];
}

interface GenerateRequest {
  paragraphs: number;
  topic?: string;
  formality: Formality;
  filters: StoryFilters;
}

interface DifficultyEstimate {
  uniqueKanji: number;
  grade: { max: number; avg: number };
  jlpt: { min: number; avg: number };
}

// --- Prompt building (ported from server/src/services/ollama.ts) ---

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
    "You may freely use hiragana and katakana. Do NOT use any kanji not in the list above.",
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

// --- Validation (ported from server/src/services/validation.ts) ---

const KANJI_REGEX = /[\u4e00-\u9faf\u3400-\u4dbf]/g;

function extractKanji(text: string): string[] {
  return [...new Set(text.match(KANJI_REGEX) || [])];
}

function validate(
  story: string,
  allowedKanji: Set<string>
): { valid: boolean; violations: string[] } {
  const usedKanji = extractKanji(story);
  const violations = usedKanji.filter((k) => !allowedKanji.has(k));
  return { valid: violations.length === 0, violations };
}

// --- OpenRouter API ---

async function callOpenRouter(
  apiKey: string,
  model: string,
  prompt: string,
  temperature: number
): Promise<string> {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature,
        max_tokens: 4096,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// --- Main handler ---

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client for reading user data (service role bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

    // Get user from JWT
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get profile (API key + model)
    const { data: profile, error: profileError } = await supabaseAdmin
      .from("profiles")
      .select("openrouter_api_key, preferred_model")
      .eq("user_id", user.id)
      .single();

    if (profileError || !profile?.openrouter_api_key) {
      return new Response(
        JSON.stringify({
          error: "Please configure your OpenRouter API key in Settings.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const apiKey = profile.openrouter_api_key;
    const model = profile.preferred_model || "deepseek/deepseek-r1";

    // Parse request
    const body: GenerateRequest = await req.json();
    const { paragraphs, topic, formality, filters } = body;

    // Build kanji allow-list
    const allowedKanji = await buildKanjiList(
      supabaseAdmin,
      user.id,
      filters
    );

    if (allowedKanji.length === 0) {
      return new Response(
        JSON.stringify({
          error:
            "No kanji match the current filters. Adjust your filters and try again.",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // Determine grammar level
    const grammarLevel =
      filters.jlptLevels.length > 0 ? Math.min(...filters.jlptLevels) : 2;

    const kanjiList = allowedKanji.join("");
    const basePrompt = buildPrompt(
      paragraphs,
      kanjiList,
      formality,
      grammarLevel,
      topic
    );

    // Generate with retry
    const allowedSet = new Set(allowedKanji);
    let storyText: string | null = null;
    let bestAttempt = { text: "", violationCount: Infinity };
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let prompt = basePrompt;
      let temp = 0.7;

      if (attempt > 1) {
        const violations = validate(bestAttempt.text, allowedSet).violations;
        prompt = `${basePrompt}\n\nIMPORTANT CORRECTION: Your previous story contained these disallowed kanji: ${violations.join(", ")}. You MUST NOT use these characters. Rewrite without them. Only use kanji from the allowed list.`;
        temp = 0.5;
      }

      const text = await callOpenRouter(apiKey, model, prompt, temp);
      const result = validate(text, allowedSet);

      if (result.valid) {
        storyText = text;
        break;
      }

      if (result.violations.length < bestAttempt.violationCount) {
        bestAttempt = { text, violationCount: result.violations.length };
      }
    }

    const finalText = storyText || bestAttempt.text;
    const finalValidation = validate(finalText, allowedSet);

    // Parse title and content
    const lines = finalText.split("\n").filter((l: string) => l.trim());
    const title = lines[0] || "無題";
    const content = lines.slice(1).join("\n\n");

    // Compute difficulty
    const difficulty = await computeDifficulty(supabaseAdmin, finalText);

    // Save story
    const { data: story, error: insertError } = await supabaseAdmin
      .from("stories")
      .insert({
        user_id: user.id,
        title,
        content,
        paragraphs,
        topic: topic || null,
        formality,
        filters,
        allowed_kanji: kanjiList,
        difficulty,
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to save story: ${insertError.message}`);
    }

    return new Response(
      JSON.stringify({
        ...story,
        violations: finalValidation.valid ? [] : finalValidation.violations,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// --- Helpers ---

async function buildKanjiList(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  filters: StoryFilters
): Promise<string[]> {
  // Get all kanji with user's known state
  const { data } = await supabase.rpc("get_user_kanji", {
    p_user_id: userId,
  });

  if (!data) return [];

  let results = data as Array<{
    character: string;
    grade: number;
    jlpt: number | null;
    known: boolean;
  }>;

  if (filters.knownOnly) {
    results = results.filter((k) => k.known);
  }
  if (filters.jlptLevels.length > 0) {
    results = results.filter(
      (k) => k.jlpt !== null && filters.jlptLevels.includes(k.jlpt)
    );
  }
  if (filters.grades.length > 0) {
    results = results.filter((k) => filters.grades.includes(k.grade));
  }

  return results.map((k) => k.character);
}

async function computeDifficulty(
  supabase: ReturnType<typeof createClient>,
  story: string
): Promise<DifficultyEstimate> {
  const usedKanji = extractKanji(story);

  if (usedKanji.length === 0) {
    return {
      uniqueKanji: 0,
      grade: { max: 0, avg: 0 },
      jlpt: { min: 0, avg: 0 },
    };
  }

  const { data: rows } = await supabase
    .from("kanji")
    .select("grade, jlpt")
    .in("character", usedKanji);

  if (!rows || rows.length === 0) {
    return {
      uniqueKanji: usedKanji.length,
      grade: { max: 0, avg: 0 },
      jlpt: { min: 0, avg: 0 },
    };
  }

  const grades = rows.map((r: { grade: number }) => r.grade);
  const jlpts = rows
    .filter((r: { jlpt: number | null }) => r.jlpt != null)
    .map((r: { jlpt: number }) => r.jlpt);

  return {
    uniqueKanji: usedKanji.length,
    grade: {
      max: grades.length > 0 ? Math.max(...grades) : 0,
      avg:
        grades.length > 0
          ? Math.round(
              (grades.reduce((a: number, b: number) => a + b, 0) /
                grades.length) *
                10
            ) / 10
          : 0,
    },
    jlpt: {
      min: jlpts.length > 0 ? Math.min(...jlpts) : 0,
      avg:
        jlpts.length > 0
          ? Math.round(
              (jlpts.reduce((a: number, b: number) => a + b, 0) /
                jlpts.length) *
                10
            ) / 10
          : 0,
    },
  };
}
