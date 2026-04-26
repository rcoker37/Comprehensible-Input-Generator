// Adds a follow-up Q&A turn to a per-word conversation thread (the same
// stories.explanations JSONB managed by explain-word). Asks see the prior
// Overview (if any) and prior Q&A turns as context — the model is given a
// real multi-turn messages array.
//
// POST { story_id, start_offset, end_offset, question }
//   question — non-empty trimmed string, ≤ 1000 chars
//
// On success, appends one user turn and one assistant turn to the stored
// thread. On any failure (validation, OpenRouter, DB write) the thread is
// not mutated, so the client can retry the same question with one click.
//
// Returns: { thread: WordThread }

import {
  buildSentenceWithMarker,
  cleanContent,
  findSentenceBounds,
} from "../_shared/text.ts";
import {
  getUserFromAuthHeader,
  loadStoryForUser,
  supabaseAdmin,
} from "../_shared/story.ts";
import {
  callOpenRouter,
  getApiKey,
  type OpenRouterMessage,
} from "../_shared/openrouter.ts";
import type {
  ChatMessage,
  StoredWordThreads,
  WordThread,
} from "../_shared/word-thread.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ASK_MODEL = "anthropic/claude-sonnet-4.5";
const MAX_TOKENS_ASK = 600;
const MAX_QUESTION_LEN = 1000;

const SYSTEM_PROMPT =
  "You are helping a Japanese learner understand a specific word in context. " +
  "The word they tapped is wrapped in 【…】 in the sentence — focus only on " +
  "that bracketed instance even if the same surface appears elsewhere. " +
  "Answer the user's questions concisely (≤ 100 words unless they ask for " +
  "more). Plain text only, no markdown.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildFramingUserPrompt(
  passageText: string,
  sentenceText: string,
  targetWord: string
): string {
  return `Sentence: ${sentenceText}
Target word: ${targetWord}

Full passage for context:
${passageText}`;
}

// Project a stored thread + new question into the OpenAI messages array.
// Legacy `overview`-role messages from older stored threads are skipped.
function buildAskMessages(
  framing: string,
  thread: WordThread | null,
  newQuestion: string
): OpenRouterMessage[] {
  const messages: OpenRouterMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: framing },
  ];
  for (const m of thread?.messages ?? []) {
    if (m.role === "user" || m.role === "assistant") {
      messages.push({ role: m.role, content: m.content });
    }
  }
  messages.push({ role: "user", content: newQuestion });
  return messages;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json(401, { error: "Unauthorized" });

    const body = await req.json();
    const storyId = body?.story_id;
    const startOffset = body?.start_offset;
    const endOffset = body?.end_offset;
    const rawQuestion = body?.question;

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
    if (typeof rawQuestion !== "string") {
      return json(400, { error: "Missing question" });
    }
    const question = rawQuestion.trim();
    if (question.length === 0) {
      return json(400, { error: "Question is empty" });
    }
    if (question.length > MAX_QUESTION_LEN) {
      return json(400, { error: "Question too long" });
    }

    const story = await loadStoryForUser(auth.authHeader, storyId);
    const content = cleanContent(story.content);
    if (endOffset > content.length) {
      return json(400, { error: "Offsets out of range" });
    }

    const cacheKey = `${startOffset}-${endOffset}`;
    const existingThread = story.explanations?.[cacheKey] ?? null;

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
    const framing = buildFramingUserPrompt(content, sentenceText, targetWord);

    const apiKey = await getApiKey(auth.userId);
    const messages = buildAskMessages(framing, existingThread, question);
    const raw = await callOpenRouter({
      apiKey,
      model: ASK_MODEL,
      messages,
      maxTokens: MAX_TOKENS_ASK,
    });

    const now = new Date().toISOString();
    const userTurn: ChatMessage = {
      role: "user",
      content: question,
      generated_at: now,
    };
    const assistantTurn: ChatMessage = {
      role: "assistant",
      content: raw.trim(),
      generated_at: new Date().toISOString(),
    };
    const thread: WordThread = {
      version: 1,
      messages: [
        ...(existingThread?.messages ?? []),
        userTurn,
        assistantTurn,
      ],
    };

    const updatedExplanations: StoredWordThreads = {
      ...(story.explanations ?? {}),
      [cacheKey]: thread,
    };

    const { error: updateErr } = await supabaseAdmin
      .from("stories")
      .update({ explanations: updatedExplanations })
      .eq("id", storyId)
      .eq("user_id", auth.userId);
    if (updateErr) {
      console.error("ask-word update failed:", updateErr);
      return json(500, { error: "Failed to save question" });
    }

    return json(200, { thread });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return json(504, { error: "Model took too long to respond." });
    }
    const message = err instanceof Error ? err.message : "Ask failed";
    console.error("ask-word error:", err);
    return json(500, { error: message });
  }
});
