// Pure client-side plumbing for per-sentence TTS audio (no React, no
// Supabase): storage path builders mirroring the generate-sentence-audio
// Edge Function's layout, a signed-URL cache, an in-flight generation map,
// and the session-wide "TTS isn't configured" latch.
//
// The in-flight map is what coordinates the feature's double-fire: a fresh
// translation fires source-mode generation, and Add to Reviews on the same
// sentence fires card-mode generation moments later. Card mode awaits the
// source generation first so the server's cheap storage-copy path hits
// instead of a second Azure synthesis. Keys are `sentenceCardKey` strings —
// the same "this sentence of this source" identity the card system uses.

import { sentenceCardKey, type SentenceCardSource } from "./sentenceCardKey";

export const AUDIO_BUCKET = "sentence-audio";
export const SIGNED_URL_TTL_SECONDS = 3600;

// Reuse a signed URL for 45 of its 60 minutes; the margin keeps a cached URL
// from expiring mid-playback.
const URL_REUSE_MS = 45 * 60 * 1000;

/** `{uid}/story-12/340-388.mp3` — must match the Edge Function's layout. */
export function sourceAudioPath(
  userId: string,
  source: SentenceCardSource,
  sentenceStart: number,
  sentenceEnd: number
): string {
  const folder =
    source.kind === "story"
      ? `story-${source.storyId}`
      : `chat-${source.chatMessageId}`;
  return `${userId}/${folder}/${sentenceStart}-${sentenceEnd}.mp3`;
}

/** `{uid}/cards/57.mp3` — must match the Edge Function's layout. */
export function cardAudioPath(userId: string, cardId: number): string {
  return `${userId}/cards/${cardId}.mp3`;
}

/** Folder holding every sentence MP3 of one story — the cleanup-hook target. */
export function storyAudioFolder(userId: string, storyId: number): string {
  return `${userId}/story-${storyId}`;
}

// ─── Signed-URL cache ────────────────────────────────────────────────────

const urlCache = new Map<string, { url: string; freshUntil: number }>();

export function getCachedAudioUrl(path: string): string | null {
  const hit = urlCache.get(path);
  if (!hit) return null;
  if (Date.now() >= hit.freshUntil) {
    urlCache.delete(path);
    return null;
  }
  return hit.url;
}

export function cacheAudioUrl(path: string, url: string): void {
  urlCache.set(path, { url, freshUntil: Date.now() + URL_REUSE_MS });
}

export function evictCachedAudioUrl(path: string): void {
  urlCache.delete(path);
}

// ─── In-flight generation coordination ───────────────────────────────────

const inFlight = new Map<string, Promise<unknown>>();

/** The map key for a sentence's generation — `story-12:340-388`. */
export function sentenceAudioKey(
  source: SentenceCardSource,
  sentenceStart: number,
  sentenceEnd: number
): string {
  return sentenceCardKey(source, sentenceStart, sentenceEnd);
}

/**
 * Run `task` registered under `key`, deduping concurrent callers: a second
 * call with the same key while the first is unsettled returns the first's
 * promise instead of firing again.
 */
export function trackGeneration<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const p = task().finally(() => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

/**
 * The unsettled generation promise for `key`, if any — awaited (errors
 * swallowed) by the Add-to-Reviews card-mode fire so the server copies the
 * just-synthesized source audio instead of synthesizing twice.
 */
export async function awaitGeneration(key: string): Promise<void> {
  const existing = inFlight.get(key);
  if (!existing) return;
  try {
    await existing;
  } catch {
    // The card-mode caller doesn't care why the source generation failed —
    // it falls through to its own synthesis.
  }
}

// ─── "TTS isn't configured" latch ────────────────────────────────────────

// Server-wide config, not per-user, so one 503 is enough to hide every
// generate affordance for the rest of the session. Playing already-existing
// audio never needs Azure and stays available.

export class TtsUnconfiguredError extends Error {
  constructor() {
    super("Text-to-speech is not configured on the server.");
    this.name = "TtsUnconfiguredError";
  }
}

let ttsUnavailable = false;

export function isTtsUnavailable(): boolean {
  return ttsUnavailable;
}

export function markTtsUnavailable(): void {
  ttsUnavailable = true;
}

/** Test-only: reset every module-level piece of state. */
export function resetSentenceAudioStateForTests(): void {
  urlCache.clear();
  inFlight.clear();
  ttsUnavailable = false;
}
