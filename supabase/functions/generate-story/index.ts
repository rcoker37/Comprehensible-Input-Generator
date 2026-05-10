import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Background story generation: insert a placeholder `stories` row with
// status='generating', return the ID immediately, and run the OpenRouter call
// inside `EdgeRuntime.waitUntil` so the function survives past the HTTP
// response. The Generator page polls the row until it flips to 'complete' or
// 'failed'. Stories list / Story Detail filter to status='complete'.

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ALLOWED_MODELS = new Set([
  "anthropic/claude-opus-4.7",
]);

const THINKING_BUDGET = 6000;
const MAX_TOKENS = 16000;
const OPENROUTER_TIMEOUT_MS = 120_000;
const KANJI_REGEX_G = /[一-龯㐀-䶿]/g;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Mirrors client/src/lib/text.ts cleanGeneratedText — strips markdown the
// model occasionally emits despite being told to output plain Japanese.
function cleanGeneratedText(s: string): string {
  return s
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[-*+]\s+/, "")
        .replace(/^\s*>\s+/, "")
    )
    .join("\n")
    .replace(/\*\*/g, "")
    .replace(/__/g, "");
}

interface KanjiMeta {
  grade: number;
  jlpt: number | null;
}

function computeDifficulty(text: string, kanjiMeta: Map<string, KanjiMeta>) {
  const usedKanji = [...new Set(text.match(KANJI_REGEX_G) || [])];
  if (usedKanji.length === 0) {
    return { uniqueKanji: 0, grade: { max: 0, avg: 0 }, jlpt: { min: 0, avg: 0 } };
  }
  const rows = usedKanji
    .map((k) => kanjiMeta.get(k))
    .filter((r): r is KanjiMeta => r != null);
  const grades = rows.map((r) => r.grade);
  const jlpts = rows.filter((r) => r.jlpt != null).map((r) => r.jlpt!);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    uniqueKanji: usedKanji.length,
    grade: {
      max: grades.length > 0 ? Math.max(...grades) : 0,
      avg: grades.length > 0 ? round1(avg(grades)) : 0,
    },
    jlpt: {
      min: jlpts.length > 0 ? Math.min(...jlpts) : 0,
      avg: jlpts.length > 0 ? round1(avg(jlpts)) : 0,
    },
  };
}

async function loadKanjiMeta(): Promise<Map<string, KanjiMeta>> {
  const PAGE = 1000;
  const out = new Map<string, KanjiMeta>();
  let from = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from("kanji")
      .select("character, grade, jlpt")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Failed to load kanji metadata: ${error.message}`);
    const rows = (data || []) as { character: string; grade: number; jlpt: number | null }[];
    for (const r of rows) out.set(r.character, { grade: r.grade, jlpt: r.jlpt });
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

// Stream from OpenRouter and accumulate the full content. Reasoning chunks are
// requested (so Claude's extended thinking budget is preserved) but discarded —
// we only persist the final story text.
async function streamOpenRouterContent(args: {
  apiKey: string;
  model: string;
  prompt: string;
}): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      messages: [{ role: "user", content: args.prompt }],
      stream: true,
      reasoning: { max_tokens: THINKING_BUDGET },
      max_tokens: MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
  });

  if (!res.ok) {
    const status = res.status;
    const body = await res.text();
    const message =
      status === 401 ? "Invalid OpenRouter API key. Please check your key in Settings." :
      status === 402 ? "Insufficient OpenRouter credits." :
      status === 429 ? "Rate limited by OpenRouter. Please wait and try again." :
      `OpenRouter ${status}: ${body.slice(0, 300)}`;
    throw new Error(message);
  }

  if (!res.body) throw new Error("No response body from OpenRouter");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
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
      let parsed: {
        error?: { message?: string; code?: string };
        choices?: { finish_reason?: string; delta?: { content?: string } }[];
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.error) {
        const msg = parsed.error.message || parsed.error.code || "Model error";
        throw new Error(`Model error: ${msg}`);
      }
      const finishReason = parsed.choices?.[0]?.finish_reason;
      if (finishReason === "length" && !fullText.trim()) {
        throw new Error(
          "The model hit its token limit while thinking and produced no output."
        );
      }
      const content = parsed.choices?.[0]?.delta?.content;
      if (content) fullText += content;
    }
  }

  if (!fullText.trim()) throw new Error("No content received from the model");
  return fullText;
}

async function runGeneration(args: {
  storyId: number;
  apiKey: string;
  model: string;
  prompt: string;
}) {
  try {
    const fullText = await streamOpenRouterContent(args);
    const clean = cleanGeneratedText(fullText);
    const lines = clean.split("\n").filter((l) => l.trim());
    const title = lines[0] || "無題";
    const content = lines.slice(1).join("\n\n");
    const kanjiMeta = await loadKanjiMeta();
    const difficulty = computeDifficulty(fullText, kanjiMeta);

    const { error } = await supabaseAdmin
      .from("stories")
      .update({
        title,
        content,
        difficulty,
        status: "complete",
      })
      .eq("id", args.storyId);
    if (error) {
      console.error("generate-story: complete update failed", error);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    console.error("generate-story: generation failed", message);
    const { error } = await supabaseAdmin
      .from("stories")
      .update({ status: "failed", error_message: message })
      .eq("id", args.storyId);
    if (error) {
      console.error("generate-story: failure update failed", error);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return jsonResponse({ error: "Unauthorized" }, 401);

    const { data: apiKey, error: keyError } = await supabaseAdmin.rpc(
      "get_openrouter_api_key_for_user",
      { p_user_id: user.id }
    );
    if (keyError || !apiKey) {
      return jsonResponse(
        { error: "Please configure your OpenRouter API key in Settings." },
        400
      );
    }

    const body = await req.json();
    const {
      prompt,
      model,
      contentType,
      paragraphs,
      topic,
      formality,
      allowedKanji,
    } = body as {
      prompt?: string;
      model?: string;
      contentType?: string;
      paragraphs?: number;
      topic?: string | null;
      formality?: string;
      allowedKanji?: string;
    };

    if (!prompt || !model) return jsonResponse({ error: "Missing prompt or model" }, 400);
    if (!ALLOWED_MODELS.has(model)) return jsonResponse({ error: "Unsupported model" }, 400);
    if (!contentType || !paragraphs || !formality || typeof allowedKanji !== "string") {
      return jsonResponse({ error: "Missing story params" }, 400);
    }

    // One in-flight generation per user.
    const { count, error: countError } = await supabaseAdmin
      .from("stories")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "generating");
    if (countError) return jsonResponse({ error: countError.message }, 500);
    if ((count ?? 0) > 0) {
      return jsonResponse({ error: "A generation is already in progress." }, 409);
    }

    // Placeholder row — title/content/difficulty will be filled in by
    // runGeneration. The NOT NULL columns get empty / zero defaults; the
    // client filters status != 'complete' rows out of the Stories list, so
    // these placeholders are never user-visible.
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("stories")
      .insert({
        user_id: user.id,
        title: "",
        content: "",
        content_type: contentType,
        paragraphs,
        topic: topic || null,
        formality,
        filters: { knownOnly: true, jlptLevels: [], grades: [] },
        allowed_kanji: allowedKanji,
        difficulty: { uniqueKanji: 0, grade: { max: 0, avg: 0 }, jlpt: { min: 0, avg: 0 } },
        status: "generating",
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      return jsonResponse(
        { error: insertError?.message || "Failed to create story row" },
        500
      );
    }

    EdgeRuntime.waitUntil(
      runGeneration({
        storyId: inserted.id,
        apiKey: apiKey as string,
        model,
        prompt,
      })
    );

    return jsonResponse({ story_id: inserted.id }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    return jsonResponse({ error: message }, 500);
  }
});
