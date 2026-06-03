// Furigana annotation for imported media. Takes an episode's plain subtitle
// text (raw_content) and rewrites it into Aozora ruby form (漢字《かんじ》),
// chunk by chunk, then stores it as media_episodes.content. The word-index
// pipeline requires ruby to be present, so this is the bridge between raw
// subtitles and the existing scoring machinery.
//
// Unlike story/chat generation, this does NOT restrict the kanji used — the
// text already exists; we only add readings. We never translate, reorder, or
// drop anything.

import { supabaseAdmin } from "./story.ts";
import { callOpenRouter } from "./openrouter.ts";

// A cheaper/faster model is a fine fit for pure annotation; pinned to the same
// model the rest of the app uses for now. Swap here if cost matters.
export const ANNOTATE_MODEL = "anthropic/claude-opus-4.7";

const CHUNK_MAX_CHARS = 2500;
const MAX_TOKENS = 8000;
const OPENROUTER_TIMEOUT_MS = 180_000;

const ANNOTATE_SYSTEM = [
  "You add furigana to existing Japanese subtitle text. You are NOT translating, summarizing, or editing.",
  "",
  "Rules:",
  "- Return the input text verbatim except that for EVERY run of kanji you attach its reading in hiragana immediately after, using full-width angle brackets 《…》 (strict Aozora Bunko ruby). The reading covers ONLY the kanji run itself, not okurigana or particles. Example: 先生《せんせい》は学生《がくせい》に話《はな》した。",
  "- Annotate every kanji run, even common ones. Do NOT use the pipe character.",
  "- Do NOT translate, do NOT summarize, do NOT reorder, do NOT merge or split lines, do NOT add or remove any line. Output exactly as many lines as the input, in the same order.",
  "- Do NOT add commentary, headers, numbering, quotes, or markdown. Output ONLY the annotated text.",
  "- Leave non-kanji text (kana, punctuation, names in kana, latin characters, numbers) exactly as-is.",
].join("\n");

// Split into chunks on line boundaries so we never cut a line in half.
function chunkLines(text: string): string[] {
  const lines = text.split("\n");
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const line of lines) {
    if (curLen > 0 && curLen + line.length + 1 > CHUNK_MAX_CHARS) {
      chunks.push(cur.join("\n"));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += line.length + 1;
  }
  if (cur.length > 0) chunks.push(cur.join("\n"));
  return chunks;
}

export async function annotateEpisode(args: {
  episodeId: number;
  apiKey: string;
  model?: string;
}): Promise<void> {
  const { episodeId, apiKey } = args;
  const model = args.model || ANNOTATE_MODEL;

  await supabaseAdmin
    .from("media_episodes")
    .update({ status: "annotating", error_message: null })
    .eq("id", episodeId);

  try {
    const { data, error } = await supabaseAdmin
      .from("media_episodes")
      .select("raw_content, series_id")
      .eq("id", episodeId)
      .single();
    if (error || !data) throw new Error("Episode not found");
    const raw = (data.raw_content as string) || "";
    const seriesId = data.series_id as number;
    if (!raw.trim()) throw new Error("Episode has no subtitle text to annotate");

    const chunks = chunkLines(raw);
    const annotated: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const content = await callOpenRouter({
        apiKey,
        model,
        messages: [
          { role: "system", content: ANNOTATE_SYSTEM },
          { role: "user", content: chunks[i] },
        ],
        maxTokens: MAX_TOKENS,
        timeoutMs: OPENROUTER_TIMEOUT_MS,
        logContext: { fn: "annotate-media", episodeId, chunk: i + 1, chunks: chunks.length },
      });
      annotated.push(content.trim());
    }

    const finalContent = annotated.join("\n");
    const { error: updErr } = await supabaseAdmin
      .from("media_episodes")
      .update({ content: finalContent, status: "complete", error_message: null })
      .eq("id", episodeId);
    if (updErr) throw new Error(updErr.message);

    await supabaseAdmin
      .from("media_series")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", seriesId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Annotation failed";
    console.error("annotate-media: failed", episodeId, message);
    await supabaseAdmin
      .from("media_episodes")
      .update({ status: "failed", error_message: message })
      .eq("id", episodeId);
  }
}
