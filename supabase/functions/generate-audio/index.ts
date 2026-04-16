// Generates TTS audio for a story via Azure Cognitive Services (Nanami voice).
// Called once per story on first play; subsequent plays serve the cached file.
//
// Input:  { story_id: number, tokens: [{ s, r? }, ...] }
//           - s: surface form of each morphological token (kuromoji on client)
//           - r: optional hiragana reading for kanji-containing tokens; forced
//                into SSML via <sub alias> so Azure pronounces the intended
//                reading instead of its own guess
// Output: the updated stories.audio object (see migration for shape)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as sdk from "npm:microsoft-cognitiveservices-speech-sdk@1.43.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "story-audio";
const VOICE = "ja-JP-NanamiNeural";
const AUDIO_VERSION = 2;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const azureKey = Deno.env.get("AZURE_SPEECH_KEY");
const azureRegion = Deno.env.get("AZURE_SPEECH_REGION");

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

interface AudioToken {
  s: string;
  r?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface SsmlResult {
  ssml: string;
  /** Token indices where each paragraph starts (for bookmark alignment). */
  paragraphStarts: number[];
}

function buildSsml(tokens: AudioToken[]): SsmlResult {
  // Kanji surfaces are kept as-is so Azure's tokenizer sees word boundaries
  // clearly. When the client provides a reading override (from LLM
  // annotations, e.g. 二人《ふたり》), we wrap the kanji in <sub alias="…">
  // to force Azure's pronunciation while preserving the kanji boundary.
  //
  // Whitespace-only tokens (newlines between title/paragraphs) become <break>
  // elements so the audio has audible pauses at paragraph boundaries.
  //
  // We only emit one <bookmark> per paragraph (at each double-newline break)
  // to keep SSML character count low — Azure bills for the full SSML string.
  const parts: string[] = [];
  const paragraphStarts: number[] = [0]; // first paragraph starts at token 0
  parts.push('<bookmark mark="p0"/>');

  for (let i = 0; i < tokens.length; i++) {
    const { s, r } = tokens[i];

    if (/^\s+$/.test(s)) {
      const newlines = (s.match(/\n/g) || []).length;
      if (newlines >= 2) {
        parts.push('<break time="700ms"/>');
        // Find the next non-whitespace token to mark the paragraph start
        const next = i + 1;
        if (next < tokens.length) {
          paragraphStarts.push(next);
          parts.push(`<bookmark mark="p${paragraphStarts.length - 1}"/>`);
        }
      } else if (newlines === 1) {
        parts.push('<break time="250ms"/>');
      }
      continue;
    }

    if (r && r.length > 0) {
      parts.push(`<sub alias="${xmlEscape(r)}">${xmlEscape(s)}</sub>`);
    } else {
      parts.push(xmlEscape(s));
    }
  }

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP"><voice name="${VOICE}">${parts.join("")}</voice></speak>`;
  return { ssml, paragraphStarts };
}

interface SynthesisOutput {
  audio: Uint8Array;
  durationMs: number;
  bookmarks: Map<string, number>; // mark name -> offset_ms
}

async function synthesize(ssml: string): Promise<SynthesisOutput> {
  const speechConfig = sdk.SpeechConfig.fromSubscription(azureKey!, azureRegion!);
  speechConfig.speechSynthesisVoiceName = VOICE;
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3;

  // Passing null for audioConfig returns audio data in the result instead of
  // routing to a speaker/stream — required in server contexts.
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);

  const bookmarks = new Map<string, number>();
  synthesizer.bookmarkReached = (_s, e) => {
    // audioOffset is in 100-nanosecond ticks; convert to milliseconds.
    bookmarks.set(e.text, Math.round(e.audioOffset / 10_000));
  };

  try {
    const result = await new Promise<sdk.SpeechSynthesisResult>((resolve, reject) => {
      synthesizer.speakSsmlAsync(ssml, resolve, reject);
    });

    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      throw new Error(result.errorDetails || "Azure synthesis failed");
    }

    return {
      audio: new Uint8Array(result.audioData),
      durationMs: Math.round(result.audioDuration / 10_000),
      bookmarks,
    };
  } finally {
    synthesizer.close();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!azureKey || !azureRegion) {
      return json(500, { error: "Azure TTS is not configured on the server." });
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json(401, { error: "Unauthorized" });

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) return json(401, { error: "Unauthorized" });

    const { story_id, tokens, force } = await req.json();

    if (typeof story_id !== "number" || !Array.isArray(tokens) || tokens.length === 0) {
      return json(400, { error: "Missing story_id or tokens" });
    }

    // Validate token shape. Cap total surface length to avoid unbounded cost.
    const MAX_CHARS = 5000;
    let totalChars = 0;
    for (const t of tokens as AudioToken[]) {
      if (typeof t?.s !== "string" || (t.r !== undefined && typeof t.r !== "string")) {
        return json(400, { error: "Malformed token" });
      }
      totalChars += t.s.length;
    }
    if (totalChars > MAX_CHARS) {
      return json(400, { error: `Story too long for TTS (${totalChars} > ${MAX_CHARS} chars)` });
    }

    // Fetch the story with ownership enforced via user JWT + RLS.
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: story, error: storyErr } = await supabaseUser
      .from("stories")
      .select("id, audio")
      .eq("id", story_id)
      .single();

    if (storyErr || !story) return json(404, { error: "Story not found" });

    // Idempotency: if current-version audio already exists, return it — unless
    // the caller explicitly requested a regenerate (e.g., voice/reading fix).
    if (!force && story.audio && story.audio.version === AUDIO_VERSION && story.audio.path) {
      return json(200, { audio: story.audio });
    }

    const { ssml, paragraphStarts } = buildSsml(tokens as AudioToken[]);
    const { audio, durationMs, bookmarks } = await synthesize(ssml);

    const paragraphs = paragraphStarts.map((tokenStart, i) => ({
      start: tokenStart,
      t: bookmarks.get(`p${i}`) ?? 0,
    }));

    const plainTokens = (tokens as AudioToken[]).map((t) => ({
      s: t.s,
      ...(t.r ? { r: t.r } : {}),
    }));

    const path = `${user.id}/${story_id}.mp3`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
    if (uploadErr) {
      console.error("storage upload failed:", uploadErr);
      return json(500, { error: "Failed to upload audio" });
    }

    const audioRecord = {
      path,
      duration_ms: durationMs,
      voice: VOICE,
      version: AUDIO_VERSION,
      tokens: plainTokens,
      paragraphs,
    };

    const { error: updateErr } = await supabaseAdmin
      .from("stories")
      .update({ audio: audioRecord })
      .eq("id", story_id)
      .eq("user_id", user.id);
    if (updateErr) {
      console.error("stories update failed:", updateErr);
      return json(500, { error: "Failed to save audio metadata" });
    }

    return json(200, { audio: audioRecord });
  } catch (err) {
    console.error("generate-audio error:", err);
    const message = err instanceof Error ? err.message : "Audio generation failed";
    return json(500, { error: message });
  }
});
