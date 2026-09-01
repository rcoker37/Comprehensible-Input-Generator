// Per-sentence TTS audio via Azure Cognitive Services (Nanami voice) — the
// story-level TTS feature's configuration, scoped to single sentences.
//
// Two request shapes (exactly one):
//
//   Source mode — audio for a sentence of a story / chat message, fired after
//   its AI translation is generated (and on-demand from the WordPopover):
//     POST { story_id? | chat_message_id?, sentence_start, sentence_end,
//            annotations, force? }
//       sentence_start/end — char offsets in the *cleaned* content, same as
//         translate-sentence; the server re-slices the same cleaned text.
//       annotations — FuriganaAnnotation[] rebased to the sentence slice;
//         they only shape readings (<sub alias>), so a forged annotation can
//         only garble the caller's own audio.
//     → { path, existed }
//     Uploads to the deterministic path {uid}/story-{id}/{start}-{end}.mp3
//     (or chat-{id}/…). No DB metadata: object existence IS the record.
//
//   Card mode — audio for a Review sentence card, fired after Add to Reviews
//   and on-demand from the back of the card:
//     POST { card_id }
//     → { audio: { path, voice, duration_ms, generated_at, version } }
//     Prefers a cheap storage copy of the source-sentence object; otherwise
//     synthesizes from the card's sentence_text + annotations snapshot (works
//     for orphaned cards whose source was deleted) and dual-writes the bytes
//     to the source path too, so the popover play is instant later. Stamps
//     sentence_cards.audio with the service role.
//
// Azure not configured → 503 { code: "tts_unconfigured" } — but only when
// synthesis is actually needed; idempotent/copy paths still succeed so
// existing audio keeps working without a key. AZURE_TTS_FAKE_MODE=1 skips
// Azure and uploads a short silent MP3 (local dev, like OPENROUTER_FAKE_MODE).

import * as sdk from "npm:microsoft-cognitiveservices-speech-sdk@1.43.0";
import { cleanContent } from "../_shared/text.ts";
import {
  getUserFromAuthHeader,
  loadStoryForUser,
  loadChatMessageForUser,
  supabaseAdmin,
} from "../_shared/story.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "sentence-audio";
const VOICE = "ja-JP-NanamiNeural";
const AUDIO_VERSION = 1;
const MAX_SENTENCE_LEN = 2000;

const azureKey = Deno.env.get("AZURE_SPEECH_KEY");
const azureRegion = Deno.env.get("AZURE_SPEECH_REGION");
const FAKE_MODE = (Deno.env.get("AZURE_TTS_FAKE_MODE") ?? "") === "1";

interface FuriganaAnnotation {
  start: number;
  end: number;
  reading: string;
}

interface SentenceAudioRecord {
  path: string;
  voice: string;
  duration_ms: number | null;
  generated_at: string;
  version: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ttsUnavailable(): Response {
  return json(503, {
    error: "Text-to-speech is not configured on the server.",
    code: "tts_unconfigured",
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

// One sentence, no bookmarks, no breaks — annotated spans become <sub alias>
// reading overrides (LLM furigana is ground truth for names/rare readings),
// everything else is escaped verbatim.
function buildSentenceSsml(
  text: string,
  annotations: FuriganaAnnotation[]
): string {
  const parts: string[] = [];
  let i = 0;
  let annIdx = 0;
  while (i < text.length) {
    while (annIdx < annotations.length && annotations[annIdx].end <= i) {
      annIdx++;
    }
    const ann = annIdx < annotations.length ? annotations[annIdx] : null;
    if (ann && ann.start === i) {
      const surface = text.slice(ann.start, ann.end);
      parts.push(
        `<sub alias="${xmlEscape(hiraganaToKatakana(ann.reading))}">${xmlEscape(surface)}</sub>`
      );
      i = ann.end;
      annIdx++;
      continue;
    }
    parts.push(xmlEscape(text[i]!));
    i++;
  }
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ja-JP"><voice name="${VOICE}">${parts.join("")}</voice></speak>`;
}

interface SynthesisOutput {
  audio: Uint8Array;
  durationMs: number;
}

// ~0.7s of silence: MPEG-1 Layer III 128kbps/44.1kHz frames (417 bytes each,
// 26.12ms) with zeroed payloads. Decodes as silence in every mainstream
// player; enough to exercise upload/signed-URL/copy/playback paths keyless.
function fakeSilentMp3(): SynthesisOutput {
  const FRAME_LEN = 417;
  const FRAMES = 26;
  const audio = new Uint8Array(FRAME_LEN * FRAMES);
  for (let f = 0; f < FRAMES; f++) {
    audio.set([0xff, 0xfb, 0x90, 0x64], f * FRAME_LEN);
  }
  return { audio, durationMs: Math.round(FRAMES * 26.12) };
}

async function synthesize(
  text: string,
  annotations: FuriganaAnnotation[]
): Promise<SynthesisOutput> {
  if (FAKE_MODE) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return fakeSilentMp3();
  }

  const ssml = buildSentenceSsml(text, annotations);
  const speechConfig = sdk.SpeechConfig.fromSubscription(
    azureKey!,
    azureRegion!
  );
  speechConfig.speechSynthesisVoiceName = VOICE;
  speechConfig.speechSynthesisOutputFormat =
    sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3;

  // Passing null for audioConfig returns audio data in the result instead of
  // routing to a speaker/stream — required in server contexts.
  const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
  try {
    const result = await new Promise<sdk.SpeechSynthesisResult>(
      (resolve, reject) => {
        synthesizer.speakSsmlAsync(ssml, resolve, reject);
      }
    );
    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      throw new Error(result.errorDetails || "Azure synthesis failed");
    }
    return {
      audio: new Uint8Array(result.audioData),
      durationMs: Math.round(result.audioDuration / 10_000),
    };
  } finally {
    synthesizer.close();
  }
}

function synthesisConfigured(): boolean {
  return FAKE_MODE || (Boolean(azureKey) && Boolean(azureRegion));
}

async function objectExists(path: string): Promise<boolean> {
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const name = path.slice(slash + 1);
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .list(folder, { search: name });
  if (error) return false;
  return (data ?? []).some((o) => o.name === name);
}

async function upload(path: string, audio: Uint8Array): Promise<void> {
  const { error } = await supabaseAdmin.storage
    .from(BUCKET)
    .upload(path, audio, { contentType: "audio/mpeg", upsert: true });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

function sourcePathFor(
  userId: string,
  source: { storyId: number } | { chatMessageId: number },
  start: number,
  end: number
): string {
  const folder =
    "storyId" in source
      ? `story-${source.storyId}`
      : `chat-${source.chatMessageId}`;
  return `${userId}/${folder}/${start}-${end}.mp3`;
}

async function handleSourceMode(
  auth: { authHeader: string; userId: string },
  body: Record<string, unknown>
): Promise<Response> {
  const storyId = typeof body.story_id === "number" ? body.story_id : null;
  const chatMessageId =
    typeof body.chat_message_id === "number" ? body.chat_message_id : null;
  const sentenceStart = body.sentence_start;
  const sentenceEnd = body.sentence_end;
  const force = body.force === true;

  if ((storyId == null) === (chatMessageId == null)) {
    return json(400, {
      error: "Exactly one of story_id or chat_message_id must be set",
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

  // Ownership is enforced by the RLS load; the offsets are re-sliced against
  // the server's own cleaned content, exactly like translate-sentence.
  const source =
    storyId != null
      ? await loadStoryForUser(auth.authHeader, storyId)
      : await loadChatMessageForUser(auth.authHeader, chatMessageId!);
  const content = cleanContent(source.content);
  if (sentenceEnd > content.length) {
    return json(400, { error: "Offsets out of range" });
  }
  const sentence = content.slice(sentenceStart, sentenceEnd);
  if (sentence.trim().length === 0) {
    return json(400, { error: "Empty sentence" });
  }
  if (sentence.length > MAX_SENTENCE_LEN) {
    return json(400, { error: "Sentence too long" });
  }

  let annotations: FuriganaAnnotation[];
  try {
    annotations = validateAnnotations(sentence, body.annotations);
  } catch (e) {
    return json(400, {
      error: e instanceof Error ? e.message : "Bad annotations",
    });
  }

  const path = sourcePathFor(
    auth.userId,
    storyId != null ? { storyId } : { chatMessageId: chatMessageId! },
    sentenceStart,
    sentenceEnd
  );

  if (!force && (await objectExists(path))) {
    return json(200, { path, existed: true });
  }

  if (!synthesisConfigured()) return ttsUnavailable();

  const { audio } = await synthesize(sentence, annotations);
  await upload(path, audio);
  return json(200, { path, existed: false });
}

async function handleCardMode(
  auth: { authHeader: string; userId: string },
  body: Record<string, unknown>
): Promise<Response> {
  const cardId = body.card_id;
  if (typeof cardId !== "number") {
    return json(400, { error: "Invalid card_id" });
  }

  const { data: card, error: cardErr } = await supabaseAdmin
    .from("sentence_cards")
    .select(
      "id, user_id, story_id, chat_message_id, sentence_start, sentence_end, sentence_text, annotations, audio"
    )
    .eq("id", cardId)
    .eq("user_id", auth.userId)
    .single();
  if (cardErr || !card) return json(404, { error: "Card not found" });

  // Idempotent: an already-stamped, current-version card returns as-is —
  // this is what makes the Review back's Generate click resolve instantly
  // when it raced a fire-and-forget generation from Add to Reviews.
  const existing = card.audio as SentenceAudioRecord | null;
  if (existing?.path && existing.version === AUDIO_VERSION) {
    return json(200, { audio: existing });
  }

  const cardPath = `${auth.userId}/cards/${card.id}.mp3`;
  const source =
    card.story_id != null
      ? { storyId: card.story_id as number }
      : card.chat_message_id != null
        ? { chatMessageId: card.chat_message_id as number }
        : null;

  const stamp = async (
    durationMs: number | null
  ): Promise<SentenceAudioRecord> => {
    const record: SentenceAudioRecord = {
      path: cardPath,
      voice: VOICE,
      duration_ms: durationMs,
      generated_at: new Date().toISOString(),
      version: AUDIO_VERSION,
    };
    const { error } = await supabaseAdmin
      .from("sentence_cards")
      .update({ audio: record })
      .eq("id", card.id)
      .eq("user_id", auth.userId);
    if (error) throw new Error(`audio stamp failed: ${error.message}`);
    return record;
  };

  // Recover a half-completed prior run: object uploaded but stamp lost.
  if (await objectExists(cardPath)) {
    return json(200, { audio: await stamp(null) });
  }

  // Cheap path: the source sentence was already synthesized — copy it.
  if (source) {
    const sourcePath = sourcePathFor(
      auth.userId,
      source,
      card.sentence_start as number,
      card.sentence_end as number
    );
    const { error: copyErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .copy(sourcePath, cardPath);
    if (!copyErr) {
      return json(200, { audio: await stamp(null) });
    }
  }

  if (!synthesisConfigured()) return ttsUnavailable();

  // Synthesize from the card's snapshot — works even when the source is gone.
  const text = card.sentence_text as string;
  if (!text || text.trim().length === 0) {
    return json(400, { error: "Card has no sentence text" });
  }
  if (text.length > MAX_SENTENCE_LEN) {
    return json(400, { error: "Sentence too long" });
  }
  let annotations: FuriganaAnnotation[];
  try {
    annotations = validateAnnotations(text, card.annotations);
  } catch {
    annotations = [];
  }

  const { audio, durationMs } = await synthesize(text, annotations);
  await upload(cardPath, audio);

  // Dual-write to the source path (when the source is still live) so the
  // popover's play button on this sentence is instant later.
  if (source) {
    const sourcePath = sourcePathFor(
      auth.userId,
      source,
      card.sentence_start as number,
      card.sentence_end as number
    );
    try {
      await upload(sourcePath, audio);
    } catch (e) {
      console.warn("generate-sentence-audio: dual-write failed:", e);
    }
  }

  return json(200, { audio: await stamp(durationMs) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json(401, { error: "Unauthorized" });

    const body = (await req.json()) as Record<string, unknown>;
    if (body.card_id != null) {
      return await handleCardMode(auth, body);
    }
    return await handleSourceMode(auth, body);
  } catch (err) {
    console.error("generate-sentence-audio error:", err);
    const message =
      err instanceof Error ? err.message : "Audio generation failed";
    const status = message.includes("not found") ? 404 : 500;
    return json(status, { error: message });
  }
});
