// Generates per-token learner annotations for a story by running the full
// tokenized passage through a cheap LLM (Claude Haiku via OpenRouter).
//
// Two actions, one endpoint:
//   POST { story_id, content, tokens }
//     Full batched pass. Skips if annotations already present unless force.
//     tokens[] comes from the client's kuromoji pipeline and carries surface,
//     reading, and POS — we pass those through to the stored annotations so
//     the reader never has to re-tokenize.
//     content is the ruby-stripped passage the client is rendering from;
//     concatenating tokens[].s reproduces content, so the LLM's numbered
//     references stay aligned with what the learner sees.
//
//   POST { story_id, action: "explain", token_idx }
//     On-demand context explanation for a single token. Cached into
//     annotations.explanations so subsequent opens are free.
//
// Output shape matches client/src/types/index.ts StoryAnnotations.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ANNOTATION_MODEL = "anthropic/claude-haiku-4.5";
const ANNOTATION_VERSION = 4;
const MAX_TOKENS_FULL = 8000;
const MAX_TOKENS_EXPLAIN = 400;
const MAX_INPUT_CHARS = 6000;
const FULL_ANNOTATION_ATTEMPTS = 2;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

interface IncomingToken {
  s: string;
  r?: string;
  b?: string;
  pos?: string;
  isContent?: boolean;
}

interface StoredToken {
  idx: number;
  s: string;
  r?: string;
  b?: string;
  pos?: string;
  gloss?: string;
  note?: string;
  isContent: boolean;
}

interface StoredAnnotations {
  version: number;
  model: string;
  generated_at: string;
  tokens: StoredToken[];
  sentences: { start_token: number; end_token: number }[];
  explanations: Record<string, { text: string; generated_at: string }>;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function callOpenRouter(
  apiKey: string,
  prompt: string,
  maxTokens: number
): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANNOTATION_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }
  const parsed = await res.json();
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("Empty model response");
  }
  return content;
}

// Claude may wrap JSON in ```json fences despite instructions. Strip defensively.
function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) return fence[1].trim();
  return raw.trim();
}

function buildAnnotationPrompt(storyText: string, tokens: IncomingToken[]): string {
  const tokenLines = tokens
    .map((t, i) => {
      const posTag = t.pos ? ` [${t.pos}]` : "";
      return `[${i}] ${t.s}${posTag}`;
    })
    .join("\n");

  return `You are annotating a short Japanese passage for a Japanese learner. You will receive the passage and a numbered morphological tokenization.

For each CONTENT token (nouns, verbs, adjectives, adverbs, interjections — NOT particles, auxiliaries, copulas, punctuation, symbols), produce:
- "gloss": a brief contextual English gloss (1-5 words) that fits how the word is used in THIS passage. If the word has many possible meanings in a dictionary, pick the one that applies here.
- "note" (optional): a short note (≤ 20 words) for nuance, register, or unexpected usage. OMIT unless it adds real value — do not explain obvious meanings.

Also return sentence boundaries as pairs of token indices (inclusive of start_token and end_token).

Return ONLY strict JSON with this exact shape. Do not wrap in markdown fences. Do not add commentary.

{
  "glosses": [
    { "idx": 0, "gloss": "teacher" },
    { "idx": 2, "gloss": "laughed", "note": "past tense of 笑う, slight warmth implied here" }
  ],
  "sentences": [
    { "start_token": 0, "end_token": 4 }
  ]
}

Only include entries in "glosses" for tokens that need them. Skip particles, auxiliaries, and punctuation.

---
PASSAGE:
${storyText}

---
TOKENS:
${tokenLines}`;
}

function buildExplainPrompt(
  storyText: string,
  targetToken: StoredToken,
  sentenceText: string
): string {
  return `A Japanese learner tapped a word in the sentence below and wants to understand it in context. Explain in 1-3 short sentences (≤ 70 words total) why this specific word or form is used here.

The tapped word is wrapped in 【…】 in the sentence — the same surface may appear elsewhere in the sentence, so focus ONLY on the bracketed instance.

Cover whichever of these is most useful:
- which dictionary sense applies here (if the word is ambiguous)
- nuance, register, or connotation
- why this conjugation/form was chosen (if applicable)
- a simpler alternative the learner might have expected, and the difference

Do not repeat the literal dictionary gloss unless it's needed. Do not add filler. Plain text only, no markdown.

Sentence: ${sentenceText}
Target word: ${targetToken.s}${targetToken.r ? ` (${targetToken.r})` : ""}${
    targetToken.gloss ? `\nAlready-known contextual gloss: ${targetToken.gloss}` : ""
  }

Full passage for context:
${storyText}`;
}

async function getApiKey(userId: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc(
    "get_openrouter_api_key_for_user",
    { p_user_id: userId }
  );
  if (error || !data) {
    throw new Error("OpenRouter API key not configured");
  }
  return data as string;
}

async function loadStoryForUser(authHeader: string, storyId: number): Promise<{
  id: number;
  content: string;
  title: string;
  annotations: StoredAnnotations | null;
  user_id: string;
}> {
  const supabaseUser = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data, error } = await supabaseUser
    .from("stories")
    .select("id, title, content, annotations, user_id")
    .eq("id", storyId)
    .single();
  if (error || !data) throw new Error("Story not found");
  return data as {
    id: number;
    content: string;
    title: string;
    annotations: StoredAnnotations | null;
    user_id: string;
  };
}

async function runFullAnnotation(
  apiKey: string,
  storyText: string,
  incoming: IncomingToken[]
): Promise<{
  tokens: StoredToken[];
  sentences: { start_token: number; end_token: number }[];
}> {
  const prompt = buildAnnotationPrompt(storyText, incoming);

  // Haiku occasionally truncates mid-JSON or emits a malformed response.
  // One retry soaks up most of these without noticeably hurting latency.
  let parsed: {
    glosses?: Array<{ idx: number; gloss?: string; note?: string }>;
    sentences?: Array<{ start_token: number; end_token: number }>;
  } | null = null;
  let lastRaw = "";
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= FULL_ANNOTATION_ATTEMPTS; attempt++) {
    try {
      const raw = await callOpenRouter(apiKey, prompt, MAX_TOKENS_FULL);
      lastRaw = raw;
      parsed = JSON.parse(extractJson(raw));
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < FULL_ANNOTATION_ATTEMPTS) {
        console.warn(
          `annotate-story attempt ${attempt} failed, retrying:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  if (!parsed) {
    const snippet = lastRaw ? lastRaw.slice(0, 200) : String(lastErr);
    throw new Error(`Model returned non-JSON after ${FULL_ANNOTATION_ATTEMPTS} attempts: ${snippet}`);
  }

  const glossMap = new Map<number, { gloss?: string; note?: string }>();
  for (const g of parsed.glosses ?? []) {
    if (typeof g?.idx === "number") {
      glossMap.set(g.idx, {
        gloss: typeof g.gloss === "string" ? g.gloss : undefined,
        note: typeof g.note === "string" ? g.note : undefined,
      });
    }
  }

  const tokens: StoredToken[] = incoming.map((t, idx) => {
    const annotation = glossMap.get(idx);
    return {
      idx,
      s: t.s,
      ...(t.r ? { r: t.r } : {}),
      ...(t.b ? { b: t.b } : {}),
      ...(t.pos ? { pos: t.pos } : {}),
      ...(annotation?.gloss ? { gloss: annotation.gloss } : {}),
      ...(annotation?.note ? { note: annotation.note } : {}),
      isContent: Boolean(t.isContent),
    };
  });

  const sentences = Array.isArray(parsed.sentences)
    ? parsed.sentences.filter(
        (s) =>
          typeof s?.start_token === "number" &&
          typeof s?.end_token === "number" &&
          s.start_token >= 0 &&
          s.end_token < tokens.length &&
          s.end_token >= s.start_token
      )
    : [];

  return { tokens, sentences };
}

// Build the sentence text with the tapped token wrapped in 【…】 so the LLM
// can identify *which* instance the learner tapped when the same surface
// appears more than once (particles especially — は, が, に, で — often repeat).
// The prompt explains the marker; without it the model has no way to
// disambiguate and will either pick a random instance or give a generic
// non-positional explanation.
function findSentenceText(
  ann: StoredAnnotations,
  tokenIdx: number
): string {
  const sentence = ann.sentences.find(
    (s) => s.start_token <= tokenIdx && tokenIdx <= s.end_token
  );
  const start = sentence ? sentence.start_token : 0;
  const end = sentence ? sentence.end_token : ann.tokens.length - 1;
  return ann.tokens
    .slice(start, end + 1)
    .map((t) => (t.idx === tokenIdx ? `【${t.s}】` : t.s))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Unauthorized" });

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return json(401, { error: "Unauthorized" });

    const body = await req.json();
    const story_id = body?.story_id;
    if (typeof story_id !== "number") {
      return json(400, { error: "Missing story_id" });
    }

    if (body?.action === "explain") {
      const tokenIdx = body?.token_idx;
      if (typeof tokenIdx !== "number") {
        return json(400, { error: "Missing token_idx" });
      }

      const story = await loadStoryForUser(authHeader, story_id);
      if (!story.annotations) {
        return json(409, { error: "Story has no annotations yet" });
      }

      const targetToken = story.annotations.tokens[tokenIdx];
      if (!targetToken) {
        return json(400, { error: "Invalid token_idx" });
      }

      // Return cached explanation if present, unless the caller asks for a fresh
      // one via `force` (e.g. Regenerate button in the reader).
      if (!body?.force) {
        const cached = story.annotations.explanations?.[String(tokenIdx)];
        if (cached) {
          return json(200, { explanation: cached });
        }
      }

      const apiKey = await getApiKey(user.id);
      const sentenceText = findSentenceText(story.annotations, tokenIdx);
      const passageText = story.annotations.tokens.map((t) => t.s).join("");
      const prompt = buildExplainPrompt(passageText, targetToken, sentenceText);
      const raw = await callOpenRouter(apiKey, prompt, MAX_TOKENS_EXPLAIN);
      const explanation = {
        text: raw.trim(),
        generated_at: new Date().toISOString(),
      };

      // Read-modify-write merge. Race window is small in practice for UI taps;
      // last-write-wins is acceptable for cached explanations.
      const updatedAnnotations: StoredAnnotations = {
        ...story.annotations,
        explanations: {
          ...(story.annotations.explanations ?? {}),
          [String(tokenIdx)]: explanation,
        },
      };

      const { error: updateErr } = await supabaseAdmin
        .from("stories")
        .update({ annotations: updatedAnnotations })
        .eq("id", story_id)
        .eq("user_id", user.id);
      if (updateErr) {
        console.error("annotations update (explain) failed:", updateErr);
        return json(500, { error: "Failed to save explanation" });
      }

      return json(200, { explanation });
    }

    // Default: full annotation pass.
    const incoming = body?.tokens as IncomingToken[] | undefined;
    const content = body?.content;
    const force = Boolean(body?.force);

    if (!Array.isArray(incoming) || incoming.length === 0) {
      return json(400, { error: "Missing tokens" });
    }
    if (typeof content !== "string" || !content) {
      return json(400, { error: "Missing content" });
    }
    if (content.length > MAX_INPUT_CHARS) {
      return json(400, {
        error: `Story too long for annotation (${content.length} > ${MAX_INPUT_CHARS} chars)`,
      });
    }

    for (const t of incoming) {
      if (typeof t?.s !== "string") {
        return json(400, { error: "Malformed token" });
      }
    }

    const story = await loadStoryForUser(authHeader, story_id);

    if (
      !force &&
      story.annotations &&
      story.annotations.version === ANNOTATION_VERSION
    ) {
      return json(200, { annotations: story.annotations });
    }

    const apiKey = await getApiKey(user.id);
    const { tokens, sentences } = await runFullAnnotation(apiKey, content, incoming);

    const annotations: StoredAnnotations = {
      version: ANNOTATION_VERSION,
      model: ANNOTATION_MODEL,
      generated_at: new Date().toISOString(),
      tokens,
      sentences,
      explanations: {},
    };

    const { error: updateErr } = await supabaseAdmin
      .from("stories")
      .update({ annotations })
      .eq("id", story_id)
      .eq("user_id", user.id);
    if (updateErr) {
      console.error("annotations update failed:", updateErr);
      return json(500, { error: "Failed to save annotations" });
    }

    return json(200, { annotations });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return json(504, { error: "Annotation model took too long to respond." });
    }
    const message = err instanceof Error ? err.message : "Annotation failed";
    console.error("annotate-story error:", err);
    return json(500, { error: message });
  }
});
