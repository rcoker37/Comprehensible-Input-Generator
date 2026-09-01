// Targeted comprehensibility repair for a generated story.
//
// The client measures a story's word-level comprehensibility (see
// RefinementContext + lib/comprehensibility.ts) and, when too many words are
// unseen-and-rare, POSTs the *specific* offending words here. This function
// rewrites the story so those exact words are replaced with simpler ones,
// leaving the rest as close to the original as possible — a positive
// instruction the model obeys reliably.
//
// Same background pattern as generate-story: claim the row (refine_state ->
// 'refining') synchronously, return 202, then rewrite inside
// EdgeRuntime.waitUntil. On success the row's content is replaced, its
// offset-keyed caches wiped (word_index_at nulled so the backfill re-indexes
// it), refine_pass bumped, and refine_state reset to NULL so the client
// re-scores. On failure refine_state -> 'failed'.
//
// POST body:
//   {
//     story_id: number,
//     flagged_words: { surface: string; reading?: string }[],
//     level_blurb: string
//   }
// Returns 202 { story_id }, 409 if the story is already being refined, or an
// error status.

import { supabaseAdmin, getUserFromAuthHeader } from "../_shared/story.ts";
import { callOpenRouter, getApiKey } from "../_shared/openrouter.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const REVISE_MODEL = "anthropic/claude-opus-5";
const MAX_TOKENS_REVISE = 12000;
const OPENROUTER_TIMEOUT_MS = 180_000;

// Dev fake mode: skip OpenRouter and produce a mechanically-simplified body by
// swapping each flagged word for a common kana word, so the full loop
// (refine_pass increments, re-index, re-score, settle) is exercisable without
// a key. Enable with OPENROUTER_FAKE_MODE=1 in .env.local.
const FAKE_MODE = (Deno.env.get("OPENROUTER_FAKE_MODE") || "") === "1";
const FAKE_DELAY_MS = 1500;
const FAKE_REPLACEMENT = "それ";

const FORMALITY_INSTRUCTIONS: Record<string, string> = {
  impolite:
    "Use casual/rough speech (タメ口, ぞ/ぜ sentence endings, masculine rough style).",
  casual: "Use plain form (だ/である, dictionary form verbs).",
  polite: "Use polite form (です/ます).",
  keigo:
    "Use honorific/humble Japanese (敬語) — include 尊敬語 and 謙譲語 where natural.",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Mirrors generate-story's cleanGeneratedText — strips stray markdown.
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

// One paragraph per non-empty line, matching how generate-story stores
// stories.content (body paragraphs joined by a blank line).
function toContent(raw: string): string {
  return cleanGeneratedText(raw)
    .split("\n")
    .filter((l) => l.trim())
    .join("\n\n");
}

interface FlaggedWord {
  surface: string;
  reading?: string;
}

function buildRevisePrompt(args: {
  content: string;
  formality: string;
  allowedKanji: string;
  levelBlurb: string;
  flagged: FlaggedWord[];
}): string {
  const { content, formality, allowedKanji, levelBlurb, flagged } = args;
  const formalityLine =
    FORMALITY_INSTRUCTIONS[formality] || FORMALITY_INSTRUCTIONS.polite;
  const wordList = flagged.map((w) => `「${w.surface}」`).join("");
  return [
    "You are a Japanese language teacher simplifying a passage for a student, keeping it entirely in Japanese.",
    "",
    `The student reads at roughly this level: ${levelBlurb}.`,
    "",
    "Here is the current passage, in Aozora Bunko ruby notation (kanji《reading》), one paragraph per line:",
    "",
    content,
    "",
    "These words are too advanced for the student and must be removed:",
    wordList,
    "",
    "Rewrite the passage so that every one of the words listed above is replaced with a simpler, more common word or a plainer phrasing the student is likely to know. Preserve the meaning, the length, the paragraph count, and the register. Change ONLY what is needed to remove the listed words — keep the rest of the passage as close to the original as possible.",
    "",
    `Allowed kanji: ${allowedKanji}`,
    "Rules:",
    "- Prefer kanji from the allowed list. When a simpler word is normally written with a kanji outside it, choose an even simpler word if you can; otherwise write the word in its standard spelling anyway — the reading annotation keeps it readable.",
    "- Write every word in its standard modern spelling, with every kanji that spelling uses. Do not substitute kana for a word's kanji — not the whole word when it is normally written with kanji (法律《ほうりつ》, never ほうりつ), and not part of it (法律《ほうりつ》, never 法《ほう》りつ). Ordinary okurigana — the べる of 食べる, the しい of 新しい — is part of the standard spelling, so keep it.",
    "- For EVERY run of kanji in the output, attach its reading in hiragana immediately after using full-width angle brackets 《…》. Use strict Aozora Bunko ruby notation: the reading covers ONLY the kanji run itself, not any okurigana or particles. Example: 先生《せんせい》は学生《がくせい》に話《はな》しました。Annotate every kanji run, even common ones. Do NOT use the pipe character.",
    "",
    formalityLine,
    "",
    "Output ONLY the rewritten passage in Japanese — the paragraphs only. No title, no headings, no markdown (no #, **, _, -, >, backticks), no English, no explanations or commentary.",
  ].join("\n");
}

// Fake-mode rewrite: replace each flagged `surface《reading》` (and bare
// surface as a fallback) with a common kana word so the re-score sees fewer
// problems and the loop converges on its happy path.
function fakeRewrite(content: string, flagged: FlaggedWord[]): string {
  let out = content;
  for (const w of flagged) {
    if (w.reading) {
      out = out.split(`${w.surface}《${w.reading}》`).join(FAKE_REPLACEMENT);
    }
    out = out.split(w.surface).join(FAKE_REPLACEMENT);
  }
  return out;
}

async function markFailed(storyId: number, userId: string, message: string) {
  const { error } = await supabaseAdmin
    .from("stories")
    .update({ refine_state: "failed" })
    .eq("id", storyId)
    .eq("user_id", userId);
  if (error) {
    console.error("revise-story: failed-state update failed", storyId, error);
  }
}

// Replace the story body and reset its indexes, mirroring update_story_content
// plus the refinement bookkeeping — refine_pass bumps, refine_state resets to
// NULL so the client re-scores the revised text.
async function applyRevision(args: {
  storyId: number;
  userId: string;
  content: string;
  nextPass: number;
}) {
  const { storyId, userId, content, nextPass } = args;
  const { error } = await supabaseAdmin
    .from("stories")
    .update({
      content,
      translations: {},
      word_index_at: null,
      word_index_version: null,
      refine_pass: nextPass,
      refine_state: null,
    })
    .eq("id", storyId)
    .eq("user_id", userId);
  if (error) throw new Error(`revision write failed: ${error.message}`);

  // Offsets are now stale — wipe the offset-keyed caches. The backfill
  // re-indexes the story (word_index_at is null) on its next pass.
  await supabaseAdmin.from("word_lookups").delete().eq("story_id", storyId);
  await supabaseAdmin
    .from("story_word_occurrences")
    .delete()
    .eq("story_id", storyId);

  // Sentence audio is offset-keyed too — and worse than stale: the rewritten
  // text could put a *different* sentence at identical offsets, so a leftover
  // object would play the wrong audio. Best-effort; SQL can't touch
  // storage.objects (see migration 20260426000000).
  try {
    const folder = `${userId}/story-${storyId}`;
    const { data: objects } = await supabaseAdmin.storage
      .from("sentence-audio")
      .list(folder);
    if (objects && objects.length > 0) {
      await supabaseAdmin.storage
        .from("sentence-audio")
        .remove(objects.map((o) => `${folder}/${o.name}`));
    }
  } catch (e) {
    console.warn("revise-story: sentence-audio cleanup failed", storyId, e);
  }
}

async function runRevision(args: {
  storyId: number;
  userId: string;
  apiKey: string;
  content: string;
  formality: string;
  allowedKanji: string;
  levelBlurb: string;
  flagged: FlaggedWord[];
  prevPass: number;
}) {
  const {
    storyId,
    userId,
    apiKey,
    content,
    formality,
    allowedKanji,
    levelBlurb,
    flagged,
    prevPass,
  } = args;
  try {
    let revised: string;
    if (FAKE_MODE) {
      await new Promise((r) => setTimeout(r, FAKE_DELAY_MS));
      revised = toContent(fakeRewrite(content, flagged));
    } else {
      const raw = await callOpenRouter({
        apiKey,
        model: REVISE_MODEL,
        messages: [
          {
            role: "user",
            content: buildRevisePrompt({
              content,
              formality,
              allowedKanji,
              levelBlurb,
              flagged,
            }),
          },
        ],
        maxTokens: MAX_TOKENS_REVISE,
        timeoutMs: OPENROUTER_TIMEOUT_MS,
        logContext: { fn: "revise-story", storyId, flagged: flagged.length },
      });
      revised = toContent(raw);
    }

    if (!revised.trim()) {
      throw new Error("Revision produced empty content");
    }
    await applyRevision({ storyId, userId, content: revised, nextPass: prevPass + 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Revision failed";
    console.error("revise-story: revision failed", storyId, message);
    await markFailed(storyId, userId, message);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ error: "Invalid request body" }, 400);
    }

    const storyId =
      typeof body.story_id === "number" && Number.isFinite(body.story_id)
        ? body.story_id
        : null;
    const levelBlurb =
      typeof body.level_blurb === "string" ? body.level_blurb : "";
    const flaggedRaw: unknown[] = Array.isArray(body.flagged_words)
      ? body.flagged_words
      : [];
    const flagged: FlaggedWord[] = flaggedRaw
      .filter((w): w is { surface: string; reading?: unknown } =>
        Boolean(w) && typeof (w as { surface?: unknown }).surface === "string"
      )
      .map((w) => ({
        surface: w.surface,
        reading: typeof w.reading === "string" ? w.reading : undefined,
      }));

    if (storyId == null) return json({ error: "Missing story_id" }, 400);
    if (flagged.length === 0) return json({ error: "No flagged words" }, 400);

    let apiKey = "";
    if (!FAKE_MODE) {
      const key = await getApiKey(auth.userId).catch(() => null);
      if (!key) {
        return json(
          { error: "Please configure your OpenRouter API key in Settings." },
          400
        );
      }
      apiKey = key;
    }

    // Atomically claim the story: only a story owned by the caller, complete,
    // and not already being refined (refine_state IS NULL) transitions to
    // 'refining'. A concurrent claim (another tab) matches zero rows -> 409.
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("stories")
      .update({ refine_state: "refining" })
      .eq("id", storyId)
      .eq("user_id", auth.userId)
      .eq("status", "complete")
      .is("refine_state", null)
      .select("id, content, formality, allowed_kanji, refine_pass")
      .maybeSingle();
    if (claimError) return json({ error: claimError.message }, 500);
    if (!claimed) {
      return json({ error: "Story is not available for refinement." }, 409);
    }

    EdgeRuntime.waitUntil(
      runRevision({
        storyId,
        userId: auth.userId,
        apiKey,
        content: claimed.content as string,
        formality: (claimed.formality as string) || "polite",
        allowedKanji: (claimed.allowed_kanji as string) || "",
        levelBlurb,
        flagged,
        prevPass: (claimed.refine_pass as number) ?? 0,
      })
    );

    return json({ story_id: storyId }, 202);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("revise-story error:", err);
    return json({ error: message }, 500);
  }
});
