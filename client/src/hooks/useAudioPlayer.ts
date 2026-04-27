import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { Story, StoryAudio } from "../types";
import { tokenizeForAudio } from "../lib/tokenizer";
import { parseAnnotatedText } from "../lib/furigana";
import { generateStoryAudio, getStoryAudioUrl } from "../api/client";
import { stripBold } from "../lib/text";

export interface AudioPlayerState {
  audio: StoryAudio | null;
  url: string | null;
  playing: boolean;
  loading: boolean;
  regenerating: boolean;
  error: string | null;
  activeSegmentIdx: number;
  playbackRate: number;
  setPlaybackRate: (n: number) => void;
  pauseAtSentence: boolean;
  setPauseAtSentence: (b: boolean) => void;
  handlePlayPause: () => Promise<void>;
  handleRegenerate: () => Promise<void>;
  seekToSegment: (i: number) => void;
  audioElement: ReactNode;
}

const PAUSE_AT_SENTENCE_KEY = "valencia.pauseAtSentence";

// Mirror generate-audio's AUDIO_VERSION. Bumping this on the server tells
// the edge function to regenerate; the client mirror routes any version-
// mismatched audio row through the generate path so the UI shows the
// "generate" icon and the next play triggers a regeneration.
const EXPECTED_AUDIO_VERSION = 3;

// Pull each segment back into the silence that precedes it. Azure's bookmark
// fires at the first audio sample of the sentence, but the <audio> element's
// seek snaps to the next MP3 frame and decoders typically resume a few samples
// late — so seeking exactly on the bookmark clips the leading consonant. The
// SSML inserts at least 250ms of silence between sentences/lines, so 150ms is
// safely inside the pause and never crosses into the previous sentence.
const SENTENCE_OFFSET_MS = 150;

function getSegments(audio: StoryAudio | null): { t: number }[] {
  if (!audio) return [];
  const raw = audio.sentences ?? audio.paragraphs;
  return raw.map((seg) => ({ t: Math.max(0, seg.t - SENTENCE_OFFSET_MS) }));
}

function findActiveSegment(segments: { t: number }[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let active = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].t <= ms) {
      active = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return active;
}

export function useAudioPlayer(
  story: Story | null,
  onAudioGenerated?: (audio: StoryAudio) => void
): AudioPlayerState {
  const [audio, setAudio] = useState<StoryAudio | null>(story?.audio ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeSegmentIdx, setActiveSegmentIdx] = useState(-1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [pauseAtSentence, setPauseAtSentence] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(PAUSE_AT_SENTENCE_KEY) === "1";
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastActive = useRef<number>(-1);
  const pendingPlay = useRef(false);
  const pauseAtSentenceRef = useRef(pauseAtSentence);

  useEffect(() => {
    pauseAtSentenceRef.current = pauseAtSentence;
    if (typeof window !== "undefined") {
      window.localStorage.setItem(
        PAUSE_AT_SENTENCE_KEY,
        pauseAtSentence ? "1" : "0"
      );
    }
  }, [pauseAtSentence]);

  const storyId = story?.id ?? null;
  const storyAudio =
    story?.audio?.paragraphs &&
    story.audio.version === EXPECTED_AUDIO_VERSION
      ? story.audio
      : null;

  useEffect(() => {
    setAudio(storyAudio);
    setUrl(null);
    setPlaying(false);
    setLoading(false);
    setError(null);
    setActiveSegmentIdx(-1);
    lastActive.current = -1;
    pendingPlay.current = false;
  }, [storyId, storyAudio]);

  useEffect(() => {
    if (!audio || url) return;
    let cancelled = false;
    getStoryAudioUrl(audio.path)
      .then((u) => {
        if (!cancelled) setUrl(u);
      })
      .catch((e) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load audio");
      });
    return () => {
      cancelled = true;
    };
  }, [audio, url]);

  useEffect(() => {
    if (url && pendingPlay.current && audioRef.current) {
      pendingPlay.current = false;
      audioRef.current.play().catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to play");
      });
    }
  }, [url]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, url]);

  useEffect(() => {
    if (!playing || !audio || !audioRef.current) return;
    const el = audioRef.current;
    const segments = getSegments(audio);

    const tick = () => {
      const ms = el.currentTime * 1000;
      const active = findActiveSegment(segments, ms);
      if (active !== lastActive.current) {
        const prev = lastActive.current;
        lastActive.current = active;
        setActiveSegmentIdx(active);
        if (pauseAtSentenceRef.current && prev >= 0 && active > prev) {
          el.pause();
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, audio]);

  const runGenerate = useCallback(
    async (force: boolean) => {
      if (!story) return;
      setError(null);
      const rawText = stripBold(`${story.title}\n\n${story.content}`);
      const { cleanText, annotations } = parseAnnotatedText(rawText);
      const tokens = await tokenizeForAudio(cleanText, annotations);
      const generated = await generateStoryAudio(story.id, tokens, { force });
      setAudio(generated);
      setUrl(null);
      onAudioGenerated?.(generated);
    },
    [story, onAudioGenerated]
  );

  const handlePlayPause = useCallback(async () => {
    if (loading || regenerating || !story) return;
    const el = audioRef.current;

    if (el && !el.paused) {
      el.pause();
      return;
    }

    if (!audio) {
      setLoading(true);
      try {
        await runGenerate(false);
        pendingPlay.current = true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to generate audio");
      } finally {
        setLoading(false);
      }
      return;
    }

    if (url && el) {
      try {
        await el.play();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to play");
      }
    } else {
      pendingPlay.current = true;
    }
  }, [loading, regenerating, story, audio, url, runGenerate]);

  const handleRegenerate = useCallback(async () => {
    if (regenerating || loading || !audio) return;
    const el = audioRef.current;
    if (el && !el.paused) el.pause();
    setRegenerating(true);
    lastActive.current = -1;
    setActiveSegmentIdx(-1);
    try {
      await runGenerate(true);
      pendingPlay.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to regenerate audio");
    } finally {
      setRegenerating(false);
    }
  }, [regenerating, loading, audio, runGenerate]);

  const seekToSegment = useCallback(
    (i: number) => {
      if (!audio || !audioRef.current) return;
      const segments = getSegments(audio);
      const t = segments[i]?.t;
      if (t === undefined) return;
      const wasPlaying = !audioRef.current.paused;
      audioRef.current.currentTime = t / 1000;
      lastActive.current = i;
      setActiveSegmentIdx(i);
      if (wasPlaying) {
        audioRef.current.play().catch(() => {});
      }
    },
    [audio]
  );

  const audioElement: ReactNode = url
    ? createElement("audio", {
        ref: audioRef,
        src: url,
        preload: "none",
        onPlay: () => setPlaying(true),
        onPause: () => setPlaying(false),
        onEnded: () => {
          setPlaying(false);
          lastActive.current = -1;
          setActiveSegmentIdx(-1);
        },
        onError: () => setError("Audio playback failed"),
      })
    : null;

  return {
    audio,
    url,
    playing,
    loading,
    regenerating,
    error,
    activeSegmentIdx,
    playbackRate,
    setPlaybackRate,
    pauseAtSentence,
    setPauseAtSentence,
    handlePlayPause,
    handleRegenerate,
    seekToSegment,
    audioElement,
  };
}
