// Adds a follow-up Q&A turn to a per-word, per-thread conversation thread
// stored in the stories.explanations JSONB. Each (story, range) can hold
// multiple threads keyed by thread id ("custom" or a chip id from the
// client-side askChips list); within a thread the model sees the prior
// Q&A turns as context.
//
// POST { story_id, start_offset, end_offset, thread_id, question }
//   thread_id — "custom" or chip id; slug-like, ≤ 64 chars
//   question — non-empty trimmed string, ≤ 1000 chars
//
// On success, appends one user turn and one assistant turn to the stored
// thread. The first call for a non-custom thread sends the chip prompt as
// the seed user turn; the UI hides messages[0] of any chip thread.
//
// On any failure (validation, OpenRouter, DB write) the thread is not
// mutated, so the client can retry the same question with one click.
//
// Returns: { thread: WordThread }

import {
  buildSentenceWithMarker,
  cleanContent,
  findSentenceBounds,
  stripBold,
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
  WordThreadsByThread,
} from "../_shared/word-thread.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ASK_MODEL = "anthropic/claude-sonnet-4.6";
const MAX_TOKENS_ASK = 600;
const MAX_QUESTION_LEN = 1000;
const MAX_THREAD_ID_LEN = 64;
const THREAD_ID_PATTERN = /^[a-z0-9-]+$/;

const SYSTEM_PROMPT =
  "You are helping a Japanese learner understand a specific word in context. " +
  "The word they tapped is wrapped in 【…】 in the sentence — focus only on " +
  "that bracketed instance even if the same surface appears elsewhere. " +
  "Answer the user's questions concisely (≤ 100 words unless they ask for " +
  "more).\n\n" +
  "Output rules:\n" +
  "- Plain text only. Do NOT use markdown — never wrap text in ** or * to " +
  "bold or emphasize.\n" +
  "- Furigana: for any kanji in your reply that does NOT appear in the " +
  "passage above (e.g. example sentences, related vocabulary), append a " +
  "hiragana reading using Aozora ruby notation immediately after the kanji " +
  "run: 漢字《かんじ》. Annotate only the kanji portion (not trailing " +
  "okurigana, e.g. 食《た》べる, not 食べる《たべる》). Kanji that already " +
  "appear in the passage do not need readings.";

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
    const rawThreadId = body?.thread_id;
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
    if (
      typeof rawThreadId !== "string" ||
      rawThreadId.length === 0 ||
      rawThreadId.length > MAX_THREAD_ID_LEN ||
      !THREAD_ID_PATTERN.test(rawThreadId)
    ) {
      return json(400, { error: "Invalid thread_id" });
    }
    const threadId = rawThreadId;
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

    const rangeKey = `${startOffset}-${endOffset}`;
    const existingRange: WordThreadsByThread =
      story.explanations?.[rangeKey] ?? {};
    const existingThread = existingRange[threadId] ?? null;

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
      content: stripBold(raw).trim(),
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
      [rangeKey]: {
        ...existingRange,
        [threadId]: thread,
      },
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
