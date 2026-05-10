// Generates TTS audio for a story via Azure Cognitive Services (Nanami voice).
// Called once per story on first play; subsequent plays serve the cached file.
//
// Input:  {
//           story_id: number,
//           title: string,                       // clean (no ruby brackets)
//           content: string,                     // clean
//           title_annotations: FuriganaAnnotation[],
//           content_annotations: FuriganaAnnotation[],
//         }
//
// The title is spoken first as plain SSML — annotations supply <sub alias>
// reading overrides, but no sentence/paragraph bookmarks are emitted for
// the title (it isn't visually highlighted during playback). Sentence and
// paragraph bookmarks start at content's first sentence as s0/p0, and their
// `start` values are character offsets into the *content* string. The
// client renders content from the same (content, content_annotations)
// pair, so its sentence numbering aligns with the audio.
//
// Output: the updated stories.audio object (path, duration_ms, voice,
// version, paragraphs, sentences) — `tokens` was dropped at version 4.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as sdk from "npm:microsoft-cognitiveservices-speech-sdk@1.43.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "story-audio";
const VOICE = "ja-JP-NanamiNeural";
const AUDIO_VERSION = 4;

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const azureKey = Deno.env.get("AZURE_SPEECH_KEY");
const azureRegion = Deno.env.get("AZURE_SPEECH_REGION");

const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

interface FuriganaAnnotation {
  start: number;
  end: number;
  reading: string;
}

const SENTENCE_TERMINATORS = new Set(["。", "！", "？"]);
const SENTENCE_CLOSERS = new Set(["」", "』", "）", ")", "”", "’"]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function hiraganaToKatakana(str: string): string {
  return str.replace(/[ぁ-ゖ]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function validateAnnotations(
  text: string,
  anns: unknown
): FuriganaAnnotation[] {
  if (!Array.isArray(anns)) return [];
  const out: FuriganaAnnotation[] = [];
  for (const a of anns) {
    if (
      typeof a?.start !== "number" ||
      typeof a?.end !== "number" ||
      typeof a?.reading !== "string"
    ) {
      throw new Error("Malformed annotation");
    }
    if (a.start < 0 || a.end > text.length || a.start >= a.end) {
      throw new Error("Annotation out of bounds");
    }
    out.push({ start: a.start, end: a.end, reading: a.reading });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Emit SSML for a region of text using the given annotations. When
 * `bookmarks` is provided, sentence/paragraph bookmarks are recorded into
 * it (with character offsets relative to `text`'s start). When omitted,
 * the region is emitted as plain narrated text — used for the title.
 *
 * The scanning rules here mirror client/src/lib/storySegments.ts so the
 * audio bookmarks line up 1:1 with the rendered sentence indices.
 */
function emitRegion(
  parts: string[],
  text: string,
  annotations: FuriganaAnnotation[],
  bookmarks: { paragraphStarts: number[]; sentenceStarts: number[] } | null
): void {
  let armed = true;
  let i = 0;
  let annIdx = 0;

  const startSentenceIfArmed = (atOffset: number) => {
    if (!armed) return;
    if (bookmarks) {
      bookmarks.sentenceStarts.push(atOffset);
      parts.push(`<bookmark mark="s${bookmarks.sentenceStarts.length - 1}"/>`);
    }
    armed = false;
  };

  while (i < text.length) {
    while (annIdx < annotations.length && annotations[annIdx].end <= i) {
      annIdx++;
    }

    const ann = annIdx < annotations.length ? annotations[annIdx] : null;
    if (ann && ann.start === i) {
      const ch0 = text[i]!;
      if (!SENTENCE_CLOSERS.has(ch0)) startSentenceIfArmed(i);
      const surface = text.slice(ann.start, ann.end);
      parts.push(
        `<sub alias="${xmlEscape(hiraganaToKatakana(ann.reading))}">${xmlEscape(surface)}</sub>`
      );
      i = ann.end;
      annIdx++;
      continue;
    }

    const ch = text[i]!;

    if (/\s/.test(ch)) {
      let j = i;
      while (j < text.length && /\s/.test(text[j]!)) {
        if (annIdx < annotations.length && annotations[annIdx].start === j) break;
        j++;
      }
      const newlines = (text.slice(i, j).match(/\n/g) || []).length;
      if (newlines >= 2) {
        parts.push('<break time="700ms"/>');
        if (bookmarks && j < text.length) {
          bookmarks.paragraphStarts.push(j);
          parts.push(
            `<bookmark mark="p${bookmarks.paragraphStarts.length - 1}"/>`
          );
        }
        armed = true;
      } else if (newlines === 1) {
        parts.push('<break time="250ms"/>');
        armed = true;
      }
      i = j;
      continue;
    }

    if (!SENTENCE_CLOSERS.has(ch)) startSentenceIfArmed(i);
    parts.push(xmlEscape(ch));
    if (SENTENCE_TERMINATORS.has(ch)) armed = true;
    i++;
  }
}

interface SsmlResult {
  ssml: string;
  paragraphStarts: number[];
  sentenceStarts: number[];
}

function buildSsml(
  title: string,
  titleAnnotations: FuriganaAnnotation[],
  content: string,
  contentAnnotations: FuriganaAnnotation[]
): SsmlResult {
  const parts: string[] = [];

  // Title: spoken plainly, with reading overrides but no bookmarks. The
  // visible title is rendered as a separate <h2> on the client and never
  // highlighted during playback.
  if (title.length > 0) {
    emitRegion(parts, title, titleAnnotations, null);
    parts.push('<break time="700ms"/>');
  }

  // Content: bookmarks start at p0/s0 so audio.sentences[0] is content's
  // first sentence — matching the client's buildDisplaySegments output.
  const paragraphStarts: number[] = [0];
  const sentenceStarts: number[] = [];
  parts.push('<bookmark mark="p0"/>');
  emitRegion(parts, content, contentAnnotations, {
    paragraphStarts,
    sentenceStarts,
  });

  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP"><voice name="${VOICE}">${parts.join("")}</voice></speak>`;
  return { ssml, paragraphStarts, sentenceStarts };
}

interface SynthesisOutput {
  audio: Uint8Array;
  durationMs: number;
  bookmarks: Map<string, number>;
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

    const body = await req.json();
    const story_id = body.story_id;
    const title = typeof body.title === "string" ? body.title : "";
    const content = body.content;
    const force = body.force === true;

    if (typeof story_id !== "number" || typeof content !== "string" || content.length === 0) {
      return json(400, { error: "Missing story_id or content" });
    }

    const MAX_CHARS = 5000;
    if (title.length + content.length > MAX_CHARS) {
      return json(400, {
        error: `Story too long for TTS (${title.length + content.length} > ${MAX_CHARS} chars)`,
      });
    }

    let titleAnnotations: FuriganaAnnotation[];
    let contentAnnotations: FuriganaAnnotation[];
    try {
      titleAnnotations = validateAnnotations(title, body.title_annotations);
      contentAnnotations = validateAnnotations(content, body.content_annotations);
    } catch (e) {
      return json(400, { error: e instanceof Error ? e.message : "Bad annotations" });
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

    const { ssml, paragraphStarts, sentenceStarts } = buildSsml(
      title,
      titleAnnotations,
      content,
      contentAnnotations
    );
    const { audio, durationMs, bookmarks } = await synthesize(ssml);

    const paragraphs = paragraphStarts.map((start, i) => ({
      start,
      t: bookmarks.get(`p${i}`) ?? 0,
    }));

    const sentences = sentenceStarts.map((start, i) => ({
      start,
      t: bookmarks.get(`s${i}`) ?? 0,
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
      paragraphs,
      sentences,
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
