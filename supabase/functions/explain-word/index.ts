// On-demand contextual explanation for a span the learner tapped. The client
// resolves the span against JMdict locally (no pre-tokenize/gloss pass); this
// function only runs when the dictionary entry isn't enough and the user
// clicks "Explain here" in the popover.
//
// POST { story_id, start_offset, end_offset, force? }
//   story_id     — target story
//   start_offset — inclusive char offset into stories.content
//   end_offset   — exclusive char offset into stories.content
//   force        — bypass the cache (Regenerate button in the popover)
//
// The target word is cleanContent.slice(start_offset, end_offset), where
// cleanContent is stories.content with **bold** markers and 《reading》 ruby
// annotations stripped — matching what the client tokenizes against. We
// derive the containing sentence by splitting on [。！？\n] around the
// range, wrap the target in 【…】 so the model can't confuse multiple
// occurrences of the same surface, and cache the result into
// stories.explanations under the key `${start_offset}-${end_offset}`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Keep in sync with client/src/lib/text.ts (stripBold) and
// client/src/lib/furigana.ts (parseAnnotatedText).
const RUBY_RE = /([\u4e00-\u9faf\u3400-\u4dbf\u3005]+)([\u3040-\u309f]*)《([^《》]+)》/g;

function stripBold(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1");
}

function cleanContent(raw: string): string {
  const withoutBold = stripBold(raw);
  let clean = "";
  let cursor = 0;
  RUBY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = RUBY_RE.exec(withoutBold)) !== null) {
    const kanjiRun = match[1];
    const okurigana = match[2];
    const reading = match[3];
    clean += withoutBold.slice(cursor, match.index);
    const absorb = okurigana.length > 0 && reading.endsWith(okurigana);
    clean += absorb ? kanjiRun + okurigana : kanjiRun;
    if (!absorb && okurigana.length > 0) clean += okurigana;
    cursor = match.index + match[0].length;
  }
  clean += withoutBold.slice(cursor);
  return clean;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EXPLAIN_MODEL = "anthropic/claude-haiku-4.5";
const MAX_TOKENS_EXPLAIN = 400;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

interface StoredExplanation {
  text: string;
  generated_at: string;
}

type StoredExplanations = Record<string, StoredExplanation>;

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
      model: EXPLAIN_MODEL,
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

// Split on the nearest sentence terminator before `start` and after `end`.
// We include '\n' as a terminator for passages the LLM laid out line-by-line
// (dialogue especially) where a punctuated terminator may be missing.
const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "\n"]);

function findSentenceBounds(
  content: string,
  start: number,
  end: number
): { sentenceStart: number; sentenceEnd: number } {
  let sentenceStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (SENTENCE_TERMINATORS.has(content[i])) {
      sentenceStart = i + 1;
      break;
    }
  }
  let sentenceEnd = content.length;
  for (let i = end; i < content.length; i++) {
    if (SENTENCE_TERMINATORS.has(content[i])) {
      sentenceEnd = i + 1;
      break;
    }
  }
  return { sentenceStart, sentenceEnd };
}

function buildSentenceWithMarker(
  content: string,
  sentenceStart: number,
  sentenceEnd: number,
  targetStart: number,
  targetEnd: number
): string {
  return (
    content.slice(sentenceStart, targetStart) +
    "【" +
    content.slice(targetStart, targetEnd) +
    "】" +
    content.slice(targetEnd, sentenceEnd)
  ).trim();
}

function buildExplainPrompt(
  passageText: string,
  sentenceText: string,
  targetWord: string
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
Target word: ${targetWord}

Full passage for context:
${passageText}`;
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

async function loadStoryForUser(
  authHeader: string,
  storyId: number
): Promise<{
  id: number;
  content: string;
  explanations: StoredExplanations | null;
  user_id: string;
}> {
  const supabaseUser = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data, error } = await supabaseUser
    .from("stories")
    .select("id, content, explanations, user_id")
    .eq("id", storyId)
    .single();
  if (error || !data) throw new Error("Story not found");
  return data as {
    id: number;
    content: string;
    explanations: StoredExplanations | null;
    user_id: string;
  };
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
    const storyId = body?.story_id;
    const startOffset = body?.start_offset;
    const endOffset = body?.end_offset;
    const force = Boolean(body?.force);

    if (typeof storyId !== "number") {
      return json(400, { error: "Missing story_id" });
    }
    if (
      typeof startOffset !== "number" ||
      typeof endOffset !== "number" ||
      startOffset < 0 ||
      endOffset <= startOffset
    ) {
      return json(400, { error: "Invalid offsets" });
    }

    const story = await loadStoryForUser(authHeader, storyId);
    const content = cleanContent(story.content);
    if (endOffset > content.length) {
      return json(400, { error: "Offsets out of range" });
    }

    const cacheKey = `${startOffset}-${endOffset}`;
    if (!force) {
      const cached = story.explanations?.[cacheKey];
      if (cached) return json(200, { explanation: cached });
    }

    const targetWord = content.slice(startOffset, endOffset);
    const { sentenceStart, sentenceEnd } = findSentenceBounds(
      content,
      startOffset,
      endOffset
    );
    const sentenceText = buildSentenceWithMarker(
      content,
      sentenceStart,
      sentenceEnd,
      startOffset,
      endOffset
    );

    const apiKey = await getApiKey(user.id);
    const prompt = buildExplainPrompt(content, sentenceText, targetWord);
    const raw = await callOpenRouter(apiKey, prompt, MAX_TOKENS_EXPLAIN);
    const explanation: StoredExplanation = {
      text: raw.trim(),
      generated_at: new Date().toISOString(),
    };

    // Read-modify-write merge. Race window is small in practice for UI taps;
    // last-write-wins is acceptable for cached explanations.
    const updatedExplanations: StoredExplanations = {
      ...(story.explanations ?? {}),
      [cacheKey]: explanation,
    };

    const { error: updateErr } = await supabaseAdmin
      .from("stories")
      .update({ explanations: updatedExplanations })
      .eq("id", storyId)
      .eq("user_id", user.id);
    if (updateErr) {
      console.error("explanations update failed:", updateErr);
      return json(500, { error: "Failed to save explanation" });
    }

    return json(200, { explanation });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return json(504, { error: "Explanation model took too long to respond." });
    }
    const message = err instanceof Error ? err.message : "Explanation failed";
    console.error("explain-word error:", err);
    return json(500, { error: message });
  }
});
