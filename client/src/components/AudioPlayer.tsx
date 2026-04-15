import {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import type { Story, StoryAudio } from "../types";
import { tokenizeForAudio } from "../lib/tokenizer";
import { generateStoryAudio, getStoryAudioUrl } from "../api/client";
import { stripBold } from "../lib/text";
import "./AudioPlayer.css";

export interface AudioPlayerHandle {
  seekToToken: (tokenIndex: number) => void;
}

interface Props {
  story: Story;
  onAudioGenerated?: (audio: StoryAudio) => void;
  onActiveTokenChange?: (index: number) => void;
}

// Locate the latest token whose start time is <= `ms`. Returns -1 before the
// first token. Binary search — runs every rAF during playback, so it must
// stay cheap even for thousand-token stories.
function findActiveToken(
  tokens: { t: number }[],
  ms: number
): number {
  let lo = 0;
  let hi = tokens.length - 1;
  let active = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tokens[mid].t <= ms) {
      active = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return active;
}

const AudioPlayer = forwardRef<AudioPlayerHandle, Props>(function AudioPlayer(
  { story, onAudioGenerated, onActiveTokenChange },
  ref
) {
  const [audio, setAudio] = useState<StoryAudio | null>(story.audio);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastActive = useRef<number>(-1);
  const pendingPlay = useRef(false);

  // Reset everything when the story identity changes.
  useEffect(() => {
    setAudio(story.audio);
    setUrl(null);
    setPlaying(false);
    setLoading(false);
    setError(null);
    lastActive.current = -1;
    pendingPlay.current = false;
    onActiveTokenChange?.(-1);
  }, [story.id, story.audio, onActiveTokenChange]);

  // Fetch a signed URL whenever we have an audio record but no URL yet.
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

  // Auto-play if the user clicked play before audio/url were ready.
  useEffect(() => {
    if (url && pendingPlay.current && audioRef.current) {
      pendingPlay.current = false;
      audioRef.current.play().catch((e) => {
        setError(e instanceof Error ? e.message : "Failed to play");
      });
    }
  }, [url]);

  // Highlight loop: while playing, emit active-token index on each frame.
  useEffect(() => {
    if (!playing || !audio || !audioRef.current) return;
    const el = audioRef.current;
    const tokens = audio.tokens;

    const tick = () => {
      const ms = el.currentTime * 1000;
      const active = findActiveToken(tokens, ms);
      if (active !== lastActive.current) {
        lastActive.current = active;
        onActiveTokenChange?.(active);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, audio, onActiveTokenChange]);

  useImperativeHandle(
    ref,
    () => ({
      seekToToken: (i: number) => {
        if (!audio || !audioRef.current) return;
        const t = audio.tokens[i]?.t;
        if (t === undefined) return;
        audioRef.current.currentTime = t / 1000;
        if (audioRef.current.paused) {
          audioRef.current.play().catch(() => {});
        }
      },
    }),
    [audio]
  );

  const runGenerate = async (force: boolean) => {
    setError(null);
    const sourceText = stripBold(`${story.title}\n\n${story.content}`);
    const tokens = await tokenizeForAudio(sourceText);
    const generated = await generateStoryAudio(story.id, tokens, { force });
    setAudio(generated);
    setUrl(null); // invalidate signed URL — useEffect will refetch for the new file
    onAudioGenerated?.(generated);
  };

  const handleClick = async () => {
    if (loading || regenerating) return;
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
  };

  const handleRegenerate = async () => {
    if (regenerating || loading) return;
    const el = audioRef.current;
    if (el && !el.paused) el.pause();
    setRegenerating(true);
    lastActive.current = -1;
    onActiveTokenChange?.(-1);
    try {
      await runGenerate(true);
      pendingPlay.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to regenerate audio");
    } finally {
      setRegenerating(false);
    }
  };

  const busy = loading || regenerating;
  const label = loading
    ? "Generating audio…"
    : regenerating
      ? "Regenerating audio…"
      : playing
        ? "Pause"
        : "Play story";

  return (
    <span className="audio-player">
      <button
        type="button"
        className={`audio-play-btn ${playing ? "playing" : ""}`}
        onClick={handleClick}
        disabled={busy}
        title={error || label}
        aria-label={label}
      >
        {loading ? (
          <span className="audio-spinner" aria-hidden="true" />
        ) : playing ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="4" y="3" width="3" height="10" />
            <rect x="9" y="3" width="3" height="10" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <polygon points="4,3 13,8 4,13" />
          </svg>
        )}
      </button>
      {audio && (
        <button
          type="button"
          className="audio-regen-btn"
          onClick={handleRegenerate}
          disabled={busy}
          title={regenerating ? "Regenerating…" : "Regenerate Audio"}
          aria-label="Regenerate Audio"
        >
          {regenerating ? (
            <span className="audio-spinner" aria-hidden="true" />
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13.5 2.5v3.5h-3.5" />
              <path d="M13.5 6A5.5 5.5 0 1 0 14 9.5" />
            </svg>
          )}
        </button>
      )}
      {url && (
        <audio
          ref={audioRef}
          src={url}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            lastActive.current = -1;
            onActiveTokenChange?.(-1);
          }}
          onError={() => setError("Audio playback failed")}
        />
      )}
      {error && <span className="audio-error" role="alert">{error}</span>}
    </span>
  );
});

export default AudioPlayer;
