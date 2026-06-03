// AI translation of a single sentence within a story OR a chat message.
// Lazy on first tap, then served from a per-sentence cache on
// stories.translations / chat_messages.translations so other taps in the
// same sentence are instant.
//
// POST { story_id?, chat_message_id?, sentence_start, sentence_end, regenerate? }
//   Exactly one of story_id / chat_message_id must be set.
//   sentence_start/end — char offsets in the *cleaned* content (ruby blocks
//     stripped). The client computes these via extractSentenceSnippet so
//     both sides agree on sentence bounds. The server slices the same
//     cleaned content and trusts the offsets.
//   regenerate — when true, bypass the cache and overwrite it with a fresh
//     model response.
//
// Returns: { translation: { text, model, generated_at } }

import { cleanContent, stripBold } from "../_shared/text.ts";
import {
  getUserFromAuthHeader,
  loadStoryForUser,
  loadChatMessageForUser,
  loadMediaEpisodeForUser,
  supabaseAdmin,
  type SentenceTranslation,
  type StoredTranslations,
} from "../_shared/story.ts";
import {
  callOpenRouter,
  getApiKey,
  type OpenRouterMessage,
} from "../_shared/openrouter.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const TRANSLATE_MODEL = "anthropic/claude-sonnet-4.6";
const MAX_TOKENS_TRANSLATE = 800;
const MAX_SENTENCE_LEN = 2000;

const SYSTEM_PROMPT =
  "You translate a single Japanese sentence into natural English for a " +
  "language learner.\n\n" +
  "The user provides:\n" +
  "1. The full passage the sentence comes from (for context only — do NOT " +
  "translate this).\n" +
  "2. The target sentence — the one and only sentence you translate.\n\n" +
  "Use the passage to resolve ambiguity that the sentence alone leaves " +
  "open: dropped subjects, ambiguous pronouns, who is speaking, what is " +
  "being referred to, register/tone consistency, recurring names, etc. " +
  "Then translate ONLY the target sentence.\n\n" +
  "Output rules:\n" +
  "- Output ONLY the English translation of the target sentence. No " +
  "preamble, no quotes, no labels, no commentary, no notes, no " +
  "alternatives, no restating of the original.\n" +
  "- Plain text only. Do NOT use markdown — no bold, no italics, no lists.\n" +
  "- Translate idiomatically, not word-for-word. The result should read " +
  "as natural English while staying faithful to the original meaning, " +
  "register, and tone.\n" +
  "- Preserve names and direct quotes as-is.\n" +
  "- If the sentence is a fragment, translate it as a fragment.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildTranslateMessages(
  sentence: string,
  passage: string
): OpenRouterMessage[] {
  const framing =
    `Full passage (context only, do not translate):\n${passage}\n\n` +
    `Target sentence to translate:\n${sentence}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: framing },
  ];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json(401, { error: "Unauthorized" });

    const body = await req.json();
    const storyId = typeof body?.story_id === "number" ? body.story_id : null;
    const chatMessageId =
      typeof body?.chat_message_id === "number" ? body.chat_message_id : null;
    const mediaEpisodeId =
      typeof body?.media_episode_id === "number" ? body.media_episode_id : null;
    const sentenceStart = body?.sentence_start;
    const sentenceEnd = body?.sentence_end;
    const regenerate = body?.regenerate === true;

    const sourceCount =
      (storyId != null ? 1 : 0) +
      (chatMessageId != null ? 1 : 0) +
      (mediaEpisodeId != null ? 1 : 0);
    if (sourceCount !== 1) {
      return json(400, {
        error:
          "Exactly one of story_id, chat_message_id, or media_episode_id must be set",
      });
    }
    if (
      typeof sentenceStart !== "number" ||
      typeof sentenceEnd !== "number" ||
      sentenceStart < 0 ||
      sentenceEnd <= sentenceStart
    ) {
      return json(400, { error: "Invalid offsets" });
    }

    const source =
      storyId != null
        ? await loadStoryForUser(auth.authHeader, storyId)
        : chatMessageId != null
        ? await loadChatMessageForUser(auth.authHeader, chatMessageId)
        : await loadMediaEpisodeForUser(auth.authHeader, mediaEpisodeId!);
    const sourceLabel =
      storyId != null ? "story" : chatMessageId != null ? "chat-message" : "media-episode";
    const content = cleanContent(source.content);
    if (sentenceEnd > content.length) {
      return json(400, { error: "Offsets out of range" });
    }
    const sentence = content.slice(sentenceStart, sentenceEnd).trim();
    if (sentence.length === 0) {
      return json(400, { error: "Empty sentence" });
    }
    if (sentence.length > MAX_SENTENCE_LEN) {
      return json(400, { error: "Sentence too long" });
    }

    const rangeKey = `${sentenceStart}-${sentenceEnd}`;
    const existing = source.translations?.[rangeKey];
    if (!regenerate && existing) {
      return json(200, { translation: existing });
    }

    const apiKey = await getApiKey(auth.userId);
    const messages = buildTranslateMessages(sentence, content);
    const raw = await callOpenRouter({
      apiKey,
      model: TRANSLATE_MODEL,
      messages,
      maxTokens: MAX_TOKENS_TRANSLATE,
      logContext: {
        fn: "translate-sentence",
        source: sourceLabel,
        sourceId: source.id,
        range: rangeKey,
      },
    });

    const translation: SentenceTranslation = {
      text: stripBold(raw).trim(),
      model: TRANSLATE_MODEL,
      generated_at: new Date().toISOString(),
    };

    const updated: StoredTranslations = {
      ...(source.translations ?? {}),
      [rangeKey]: translation,
    };

    const table =
      storyId != null ? "stories" : chatMessageId != null ? "chat_messages" : "media_episodes";
    const { error: updateErr } = await supabaseAdmin
      .from(table)
      .update({ translations: updated })
      .eq("id", source.id)
      .eq("user_id", auth.userId);
    if (updateErr) {
      console.error("translate-sentence update failed:", updateErr);
      return json(500, { error: "Failed to save translation" });
    }

    return json(200, { translation });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return json(504, { error: "Model took too long to respond." });
    }
    const message =
      err instanceof Error ? err.message : "Translation failed";
    console.error("translate-sentence error:", err);
    return json(500, { error: message });
  }
});
