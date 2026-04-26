import type { AudioPlayerState } from "../hooks/useAudioPlayer";
import "./PlaybackFooter.css";

const SPEEDS = [0.75, 1];

export default function PlaybackFooter(props: AudioPlayerState) {
  const {
    audio,
    playing,
    loading,
    regenerating,
    error,
    playbackRate,
    setPlaybackRate,
    pauseAtSentence,
    setPauseAtSentence,
    handlePlayPause,
    audioElement,
  } = props;

  const busy = loading || regenerating;
  const playLabel = loading
    ? "Generating audio…"
    : regenerating
      ? "Regenerating audio…"
      : !audio
        ? "Generate audio"
        : playing
          ? "Pause"
          : "Play story";
  const pauseToggleTitle = pauseAtSentence
    ? "Auto-pause after each sentence: ON"
    : "Auto-pause after each sentence: OFF";

  return (
    <div className="playback-footer" role="region" aria-label="Audio playback">
      <div className="playback-footer-inner">
        <div className="playback-left">
          <button
            type="button"
            className="playback-speed-btn"
            onClick={() => {
              const idx = SPEEDS.indexOf(playbackRate);
              setPlaybackRate(SPEEDS[(idx + 1) % SPEEDS.length]);
            }}
            disabled={busy || !audio}
            aria-label={`Playback speed: ${playbackRate}×`}
            title={`Speed: ${playbackRate}×`}
          >
            {playbackRate === 1 ? "1" : ".75"}×
          </button>
        </div>
        <div className="playback-center">
          <button
            type="button"
            className={`playback-play-btn ${playing ? "playing" : ""}`}
            onClick={handlePlayPause}
            disabled={busy}
            title={error || playLabel}
            aria-label={playLabel}
          >
            {loading ? (
              <span className="playback-spinner" aria-hidden="true" />
            ) : !audio ? (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 8h0" />
                <path d="M5 5v6" />
                <path d="M8 3v10" />
                <path d="M11 5v6" />
                <path d="M14 8h0" />
              </svg>
            ) : playing ? (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <rect x="4" y="3" width="3" height="10" />
                <rect x="9" y="3" width="3" height="10" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <polygon points="4,3 13,8 4,13" />
              </svg>
            )}
          </button>
        </div>
        <div className="playback-right">
          <button
            type="button"
            className={`playback-pause-toggle-btn ${pauseAtSentence ? "is-active" : ""}`}
            onClick={() => setPauseAtSentence(!pauseAtSentence)}
            title={pauseToggleTitle}
            aria-pressed={pauseAtSentence}
            aria-label="Toggle pause after each sentence"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <rect x="3" y="4" width="2" height="8" />
              <rect x="6" y="4" width="2" height="8" />
              <polygon points="10,4 14,8 10,12" />
            </svg>
          </button>
        </div>
      </div>
      {error && <div className="playback-error" role="alert">{error}</div>}
      {audioElement}
    </div>
  );
}
