// Background chat-message generation. Mirrors generate-story's pattern:
// insert the user message + assistant placeholder synchronously, return the
// IDs, then fire OpenRouter inside `EdgeRuntime.waitUntil`. The client polls
// `chat_messages` until the assistant row flips to status='complete'.
//
// POST body:
//   {
//     chat_id?: number | null,    // null = create new chat from this turn
//     user_text: string,           // raw user input (Japanese or English)
//     allowed_kanji: string,       // concatenated kanji string (same shape as stories.allowed_kanji)
//     formality: 'impolite'|'casual'|'polite'|'keigo'
//   }
//
// Returns 202:
//   {
//     chat_id: number,
//     user_message_id: number,
//     assistant_message_id: number,
//     chat_created: boolean
//   }
//
// 409 if a pending assistant message already exists in the same chat (the
// unique partial index `chat_messages_pending_unique` enforces this).

import { supabaseAdmin, getUserFromAuthHeader } from "../_shared/story.ts";
import { callOpenRouter, getApiKey, type OpenRouterMessage } from "../_shared/openrouter.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CHAT_MODEL = "anthropic/claude-opus-4.7";
const ALLOWED_MODELS = new Set([CHAT_MODEL]);

const MAX_TOKENS_CHAT = 4000;
const OPENROUTER_TIMEOUT_MS = 180_000;

// Dev fake mode: skip the OpenRouter call and write a canned Aozora-ruby
// reply after a short delay. Lets developers exercise the full chat flow
// (pending → complete polling, word indexing, read tracking, corrections
// rendering) without configuring an OpenRouter key. Enable by setting
// OPENROUTER_FAKE_MODE=1 in .env.local before `supabase functions serve`.
const FAKE_MODE = (Deno.env.get("OPENROUTER_FAKE_MODE") || "") === "1";
const FAKE_REPLY_DELAY_MS = 1500;
const FAKE_REPLIES = [
  "そうですね。良《よ》い質問《しつもん》です。今日《きょう》は天気《てんき》が良《よ》いので、少《すこ》し散歩《さんぽ》しませんか。",
  "なるほど、興味深《きょうみぶか》い話題《わだい》ですね。もう少《すこ》し詳《くわ》しく教《おし》えてください。一緒《いっしょ》に考《かんが》えましょう。",
  "面白《おもしろ》いですね。日本語《にほんご》の勉強《べんきょう》、頑張《がんば》ってください。毎日《まいにち》少《すこ》しずつ続《つづ》けることが大切《たいせつ》です。",
];

// History budget: send up to N most-recent complete turns, capped by total
// character count so a single long turn doesn't blow the window.
const HISTORY_MAX_MESSAGES = 10;
const HISTORY_MAX_CHARS = 16000;

const TITLE_MAX_LEN = 30;

const FORMALITY_INSTRUCTIONS: Record<string, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

function buildSystemPrompt(allowedKanji: string, formality: string): string {
  const formalityLine =
    FORMALITY_INSTRUCTIONS[formality] || FORMALITY_INSTRUCTIONS.polite;
  return [
    "You are a Japanese conversation partner and tutor for a language learner.",
    "Every reply MUST be entirely in Japanese — no English, no romaji, no translations, no meta-commentary.",
    "",
    `Allowed kanji: ${allowedKanji}`,
    "",
    "Rules:",
    "- Keep the kanji you use within these groups: (1) kanji from the allowed list above; (2) kanji and vocabulary the user's question naturally calls for — terms a reply on this subject genuinely lives on. Outside these groups, prefer simpler wording over reaching for another kanji.",
    "- Actively use allowed kanji throughout — do not write entirely in hiragana.",
    "- Write every word in its standard modern spelling, with every kanji that spelling uses. Do not substitute kana for a word's kanji — not the whole word when it is normally written with kanji (法律《ほうりつ》, never ほうりつ), and not part of it (法律《ほうりつ》, never 法《ほう》りつ; 医療《いりょう》, never 医《い》りょう). Ordinary okurigana — the べる of 食べる, the しい of 新しい — is part of the standard spelling, not a substitution, so keep it.",
    "- Once you choose to use a word, all of its kanji are allowed: the kanji groups above limit which words you reach for, not how you spell a word you have already chosen.",
    "- For EVERY run of kanji in the output, attach its reading in hiragana immediately after using full-width angle brackets 《…》. Use strict Aozora Bunko ruby notation: the reading covers ONLY the kanji run itself, not any okurigana or particles. Examples: 二人《ふたり》は公園《こうえん》で行《おこな》われた大会《たいかい》を見《み》た。先生《せんせい》は学生《がくせい》に話《はな》しました。新《あたら》しい本《ほん》を読《よ》みました。Annotate every kanji run, even common ones. Do NOT use the pipe character.",
    "",
    formalityLine,
    "",
    "Reply naturally and conversationally. Keep responses concise — typically 1–3 short paragraphs. If the user asks a grammar or vocabulary question, explain it in Japanese with examples (the user is learning by reading your replies).",
    "",
    "When (and ONLY when) the user's most recent message is written entirely in Japanese, end your reply with a corrections section. Format: leave a blank line, then the header 「訂正《ていせい》：」 on its own line, then each issue on its own line as 「<user's phrase>」→「<natural version>」（<short Japanese reason>）. Cover particles, conjugation, word choice, register, and naturalness — anything you would flag as a Japanese teacher. If the user's Japanese was entirely natural and grammatical, write 「特《とく》に問題《もんだい》ありません。」 as the only line under the header. If the user's message contains any English, romaji, or other non-Japanese language, OMIT this section entirely — no header, no placeholder, no encouragement to switch languages. The section, when present, must follow all the kanji and ruby rules above.",
    "",
    "Output ONLY the Japanese reply. No preamble, no quotes, no English, no markdown (no #, **, _, -, >, backticks).",
  ].join("\n");
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function truncateTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length <= TITLE_MAX_LEN) return t || "New chat";
  return t.slice(0, TITLE_MAX_LEN) + "…";
}

interface HistoryRow {
  role: "user" | "assistant";
  content: string;
}

async function loadHistory(chatId: number, userId: string): Promise<HistoryRow[]> {
  const { data, error } = await supabaseAdmin
    .from("chat_messages")
    .select("role, content, status, created_at")
    .eq("chat_id", chatId)
    .eq("user_id", userId)
    .eq("status", "complete")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to load chat history: ${error.message}`);
  const rows = (data || []) as Array<{ role: "user" | "assistant"; content: string }>;
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

function selectContextWindow(history: HistoryRow[]): HistoryRow[] {
  // Newest-first under both caps, then re-sort to oldest-first for the
  // OpenRouter call. Keep ruby on assistant messages so the model sees its
  // own correctly-annotated replies — without this it pattern-matches on
  // bare-kanji history and stops emitting ruby after a few turns.
  const newestFirst = [...history].reverse();
  const selected: HistoryRow[] = [];
  let chars = 0;
  for (const row of newestFirst) {
    const cost = row.content.length;
    if (selected.length >= HISTORY_MAX_MESSAGES) break;
    if (chars + cost > HISTORY_MAX_CHARS && selected.length > 0) break;
    selected.push({ role: row.role, content: row.content });
    chars += cost;
  }
  return selected.reverse();
}

function isAllJapanese(s: string): boolean {
  const trimmed = s.replace(/\s+/g, "");
  if (!trimmed) return false;
  // Hiragana, katakana, CJK ideographs, JP punctuation/fullwidth ranges.
  return /^[　-〿぀-ゟ゠-ヿ一-鿿＀-￯]+$/.test(
    trimmed,
  );
}

function buildFakeReply(userText: string, seed: number): string {
  const reply = FAKE_REPLIES[seed % FAKE_REPLIES.length];
  if (!isAllJapanese(userText)) return reply;
  // Alternate between the "no issues" placeholder and a sample correction
  // so both rendering paths are exercised in dev.
  const correction =
    seed % 2 === 0
      ? "特《とく》に問題《もんだい》ありません。"
      : "「日本語《にほんご》上手《じょうず》」→「日本語《にほんご》がお上手《じょうず》です」（が抜《ぬ》けていました）";
  return `${reply}\n\n訂正《ていせい》：\n${correction}`;
}

async function runFakeGeneration(args: {
  chatId: number;
  assistantMessageId: number;
  userText: string;
}) {
  const { chatId, assistantMessageId, userText } = args;
  console.log("chat-message: fake-mode reply for", assistantMessageId);
  try {
    await new Promise((resolve) => setTimeout(resolve, FAKE_REPLY_DELAY_MS));
    const content = buildFakeReply(userText, assistantMessageId);
    const { error } = await supabaseAdmin
      .from("chat_messages")
      .update({ content, status: "complete" })
      .eq("id", assistantMessageId);
    if (error) {
      console.error(
        "chat-message (fake): complete update failed",
        assistantMessageId,
        error,
      );
      return;
    }
    await supabaseAdmin
      .from("chats")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", chatId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Fake generation failed";
    console.error(
      "chat-message (fake): generation failed",
      assistantMessageId,
      message,
    );
    await supabaseAdmin
      .from("chat_messages")
      .update({ status: "failed", error_message: message })
      .eq("id", assistantMessageId);
  }
}

async function runGeneration(args: {
  chatId: number;
  assistantMessageId: number;
  userId: string;
  apiKey: string;
  allowedKanji: string;
  formality: string;
}) {
  const { chatId, assistantMessageId, userId, apiKey, allowedKanji, formality } = args;
  try {
    const history = await loadHistory(chatId, userId);
    const context = selectContextWindow(history);
    const messages: OpenRouterMessage[] = [
      { role: "system", content: buildSystemPrompt(allowedKanji, formality) },
      ...context.map((m) => ({ role: m.role, content: m.content })),
    ];

    const content = await callOpenRouter({
      apiKey,
      model: CHAT_MODEL,
      messages,
      maxTokens: MAX_TOKENS_CHAT,
      timeoutMs: OPENROUTER_TIMEOUT_MS,
      logContext: { fn: "chat-message", chatId, assistantMessageId },
    });

    const trimmed = content.trim();
    const { error } = await supabaseAdmin
      .from("chat_messages")
      .update({ content: trimmed, status: "complete" })
      .eq("id", assistantMessageId);
    if (error) {
      console.error("chat-message: complete update failed", assistantMessageId, error);
      return;
    }

    // Bump last_activity_at on completion. A new user turn sent during
    // generation will overwrite this with its own timestamp from the sync
    // path; both are now() at write time so the most-recent write wins.
    await supabaseAdmin
      .from("chats")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", chatId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Generation failed";
    console.error("chat-message: generation failed", assistantMessageId, message);
    const { error } = await supabaseAdmin
      .from("chat_messages")
      .update({ status: "failed", error_message: message })
      .eq("id", assistantMessageId);
    if (error) {
      console.error("chat-message: failure update failed", assistantMessageId, error);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json(400, { error: "Invalid request body" });
    }

    const chatIdRaw = body.chat_id;
    const chatId: number | null =
      typeof chatIdRaw === "number" && Number.isFinite(chatIdRaw) ? chatIdRaw : null;
    const userText = typeof body.user_text === "string" ? body.user_text.trim() : "";
    const allowedKanji = typeof body.allowed_kanji === "string" ? body.allowed_kanji : "";
    const formality = typeof body.formality === "string" ? body.formality : "polite";
    const model = typeof body.model === "string" ? body.model : CHAT_MODEL;

    if (!userText) return json(400, { error: "Missing user_text" });
    if (!ALLOWED_MODELS.has(model)) return json(400, { error: "Unsupported model" });
    if (!allowedKanji) return json(400, { error: "Missing allowed_kanji" });

    let apiKey = "";
    if (!FAKE_MODE) {
      const key = await getApiKey(auth.userId).catch(() => null);
      if (!key) {
        return json(400, { error: "Please configure your OpenRouter API key in Settings." });
      }
      apiKey = key;
    }

    // Resolve or create the chat.
    let resolvedChatId = chatId;
    let chatCreated = false;
    if (resolvedChatId == null) {
      const { data: inserted, error: insErr } = await supabaseAdmin
        .from("chats")
        .insert({
          user_id: auth.userId,
          title: truncateTitle(userText),
        })
        .select("id")
        .single();
      if (insErr || !inserted) {
        return json(500, { error: insErr?.message || "Failed to create chat" });
      }
      resolvedChatId = inserted.id;
      chatCreated = true;
    } else {
      // Confirm ownership.
      const { data: chat, error: chatErr } = await supabaseAdmin
        .from("chats")
        .select("id")
        .eq("id", resolvedChatId)
        .eq("user_id", auth.userId)
        .maybeSingle();
      if (chatErr) return json(500, { error: chatErr.message });
      if (!chat) return json(404, { error: "Chat not found" });
    }

    // Insert user message (status complete — content is final).
    const { data: userMsg, error: userErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        chat_id: resolvedChatId,
        user_id: auth.userId,
        role: "user",
        content: userText,
        status: "complete",
      })
      .select("id")
      .single();
    if (userErr || !userMsg) {
      return json(500, { error: userErr?.message || "Failed to insert user message" });
    }

    // Insert assistant placeholder. The unique partial index
    // `chat_messages_pending_unique` ensures at most one pending row per
    // chat; a duplicate insert raises 23505 which we map to 409.
    const { data: assistantMsg, error: asstErr } = await supabaseAdmin
      .from("chat_messages")
      .insert({
        chat_id: resolvedChatId,
        user_id: auth.userId,
        role: "assistant",
        content: "",
        status: "pending",
      })
      .select("id")
      .single();
    if (asstErr || !assistantMsg) {
      const isDup =
        asstErr && typeof asstErr.code === "string" && asstErr.code === "23505";
      if (isDup) {
        return json(409, { error: "A reply is already in progress for this chat." });
      }
      return json(500, { error: asstErr?.message || "Failed to insert assistant message" });
    }

    // Refresh activity timestamp. Out-of-order assistant completions guard
    // against this in runGeneration; here, the new turn always wins.
    await supabaseAdmin
      .from("chats")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", resolvedChatId);

    EdgeRuntime.waitUntil(
      FAKE_MODE
        ? runFakeGeneration({
            chatId: resolvedChatId,
            assistantMessageId: assistantMsg.id,
            userText,
          })
        : runGeneration({
            chatId: resolvedChatId,
            assistantMessageId: assistantMsg.id,
            userId: auth.userId,
            apiKey,
            allowedKanji,
            formality,
          })
    );

    return json(202, {
      chat_id: resolvedChatId,
      user_message_id: userMsg.id,
      assistant_message_id: assistantMsg.id,
      chat_created: chatCreated,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("chat-message error:", err);
    return json(500, { error: message });
  }
});
