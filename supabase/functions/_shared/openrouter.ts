// OpenRouter helpers shared by word-context edge functions.

import { supabaseAdmin } from "./story.ts";

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
}

export async function callOpenRouter({
  apiKey,
  model,
  messages,
  maxTokens,
  timeoutMs = 90_000,
}: CallOpenRouterArgs): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(timeoutMs),
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
