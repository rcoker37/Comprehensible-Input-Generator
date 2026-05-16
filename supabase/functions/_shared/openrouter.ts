// OpenRouter helpers shared by word-context edge functions.

import { supabaseAdmin } from "./story.ts";
import { logOpenRouter } from "./log.ts";

export type OpenRouterRole = "system" | "user" | "assistant";

export interface OpenRouterMessage {
  role: OpenRouterRole;
  content: string;
}

export async function getApiKey(userId: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc(
    "get_openrouter_api_key_for_user",
    { p_user_id: userId }
  );
  if (error || !data) {
    throw new Error("OpenRouter API key not configured");
  }
  return data as string;
}

export interface CallOpenRouterArgs {
  apiKey: string;
  model: string;
  messages: OpenRouterMessage[];
  maxTokens: number;
  timeoutMs?: number;
  // Identifying fields merged into every log line for this call (e.g.
  // { fn, storyId, range }) so a failure can be traced back to its request.
  logContext?: Record<string, unknown>;
}

export async function callOpenRouter({
  apiKey,
  model,
  messages,
  maxTokens,
  timeoutMs = 90_000,
  logContext = {},
}: CallOpenRouterArgs): Promise<string> {
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  const startedAt = Date.now();
  logOpenRouter("chat.request", {
    ...logContext,
    model,
    maxTokens,
    messages: messages.length,
    promptChars,
  });

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network failure or AbortSignal timeout — no HTTP response at all.
    logOpenRouter(
      "chat.fetch-failed",
      {
        ...logContext,
        model,
        elapsedMs: Date.now() - startedAt,
        error: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      },
      true,
    );
    throw err;
  }

  const elapsedMs = Date.now() - startedAt;
  if (!res.ok) {
    const body = await res.text();
    logOpenRouter(
      "chat.error",
      { ...logContext, model, status: res.status, elapsedMs, body: body.slice(0, 1000) },
      true,
    );
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const parsed = await res.json();
  const content = parsed?.choices?.[0]?.message?.content;
  const finishReason = parsed?.choices?.[0]?.finish_reason;
  if (typeof content !== "string" || !content.trim()) {
    logOpenRouter(
      "chat.empty",
      { ...logContext, model, elapsedMs, finishReason, usage: parsed?.usage },
      true,
    );
    throw new Error("Empty model response");
  }

  logOpenRouter("chat.ok", {
    ...logContext,
    model,
    elapsedMs,
    finishReason,
    contentChars: content.length,
    usage: parsed?.usage,
  });
  return content;
}
