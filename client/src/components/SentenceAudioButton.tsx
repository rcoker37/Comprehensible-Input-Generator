// Play / generate button for one sentence's TTS audio. Two shapes:
//
//   kind="source" — a sentence of a story / chat message (WordPopover). The
//   deterministic storage path is probed on click: object exists → play;
//   missing → generate (deduped through the module in-flight map, so the
//   auto-fire after a fresh translation and a click race to one request),
//   then play. Covers pre-feature cached translations, which never auto-fire.
//
//   kind="card" — a review card (back of the Review page card). audioPath
//   present → play; null → "Generate audio" calls card mode (idempotent
//   server-side) and reports the stamped record up via onGenerated. This is
//   the after-the-fact path for pre-feature cards and lost races.
//
// Generate affordances disappear for the session once the server says TTS
// isn't configured (503 tts_unconfigured latch); a card whose audio already
// exists keeps its play button — signed URLs don't need Azure.

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import {
  generateCardAudio,
  generateSourceSentenceAudio,
  getSentenceAudioUrl,
} from "../api/client";
import {
  isTtsUnavailable,
  sentenceAudioKey,
  sourceAudioPath,
  trackGeneration,
  TtsUnconfiguredError,
} from "../lib/sentenceAudio";
import type { SentenceCardSource } from "../lib/sentenceCardKey";
import type { FuriganaAnnotation } from "../lib/furigana";
import type { SentenceCardAudio } from "../types";
import "./SentenceAudioButton.css";

type SentenceAudioButtonProps =
  | {
      kind: "source";
      source: SentenceCardSource;
      sentenceStart: number;
      sentenceEnd: number;
      annotations: FuriganaAnnotation[];
    }
  | {
      kind: "card";
      cardId: number;
      audioPath: string | null;
      onGenerated?: (audio: SentenceCardAudio) => void;
    };

type Phase = "idle" | "working" | "playing";

function SpeakerIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 3 4.5 6H2v4h2.5L8 13V3z" fill="currentColor" stroke="none" />
      <path d="M10.5 6a3 3 0 0 1 0 4" />
      <path d="M12.5 4.5a5.5 5.5 0 0 1 0 7" />
    </svg>
  );
}

export function SentenceAudioButton(props: SentenceAudioButtonProps) {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState(false);
  // Flips when a click discovers TTS is unconfigured (or, for source kind,
  // that nothing exists to play) — the latch alone can't re-render us.
  const [hidden, setHidden] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop playback when the button unmounts (popover closed, card advanced).
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  if (!user) return null;
  const canGenerate = !isTtsUnavailable();
  const hasExisting = props.kind === "card" && props.audioPath != null;
  if (hidden || (!canGenerate && !hasExisting)) return null;

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPhase("idle");
  };

  const play = (url: string) => {
    const audio = new Audio(url);
    audioRef.current = audio;
    audio.onended = () => {
      if (audioRef.current === audio) stop();
    };
    audio.onerror = () => {
      if (audioRef.current === audio) {
        stop();
        setError(true);
      }
    };
    setPhase("playing");
    void audio.play().catch(() => {
      if (audioRef.current === audio) {
        stop();
        setError(true);
      }
    });
  };

  const resolveUrl = async (): Promise<string | null> => {
    if (props.kind === "card") {
      // Play what's stamped; a null audioPath goes straight to generation.
      if (props.audioPath) {
        const url = await getSentenceAudioUrl(props.audioPath);
        if (url) return url;
      }
      const audio = await generateCardAudio(props.cardId);
      props.onGenerated?.(audio);
      return getSentenceAudioUrl(audio.path);
    }

    const { source, sentenceStart, sentenceEnd, annotations } = props;
    const path = sourceAudioPath(user.id, source, sentenceStart, sentenceEnd);
    const existing = await getSentenceAudioUrl(path);
    if (existing) return existing;
    if (isTtsUnavailable()) {
      setHidden(true);
      return null;
    }
    const key = sentenceAudioKey(source, sentenceStart, sentenceEnd);
    const generatedPath = await trackGeneration(key, () =>
      generateSourceSentenceAudio(
        source.kind === "story"
          ? { storyId: source.storyId }
          : { chatMessageId: source.chatMessageId },
        sentenceStart,
        sentenceEnd,
        annotations
      )
    );
    return getSentenceAudioUrl(generatedPath);
  };

  const handleClick = () => {
    if (phase === "playing") {
      stop();
      return;
    }
    if (phase === "working") return;
    setError(false);
    setPhase("working");
    resolveUrl()
      .then((url) => {
        if (url) {
          play(url);
        } else {
          setPhase("idle");
        }
      })
      .catch((err: unknown) => {
        setPhase("idle");
        if (err instanceof TtsUnconfiguredError) {
          setHidden(true);
        } else {
          setError(true);
        }
      });
  };

  const needsGeneration = props.kind === "card" && props.audioPath == null;
  const label =
    phase === "playing"
      ? "Stop"
      : phase === "working"
        ? needsGeneration
          ? "Generating…"
          : "Loading…"
        : needsGeneration
          ? "Generate audio"
          : "Listen";

  return (
    <span className="sentence-audio">
      <button
        type="button"
        className="sentence-audio__btn"
        onClick={handleClick}
        disabled={phase === "working"}
        title={
          needsGeneration
            ? "Generate audio for this sentence"
            : "Listen to this sentence"
        }
      >
        <SpeakerIcon />
        {label}
      </button>
      {error && <span className="sentence-audio__error">Audio failed</span>}
    </span>
  );
}
