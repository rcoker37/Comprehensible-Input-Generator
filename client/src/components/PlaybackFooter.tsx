import type { AudioPlayerState } from "../hooks/useAudioPlayer";
import "./PlaybackFooter.css";

const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

export default function PlaybackFooter(props: AudioPlayerState) {
  const {
    audio,
    playing,
    loading,
    regenerating,
    error,
    playbackRate,
    setPlaybackRate,
    handlePlayPause,
    handleRegenerate,
    audioElement,
  } = props;

  const busy = loading || regenerating;
  const playLabel = loading
    ? "Generating audio…"
    : regenerating
      ? "Regenerating audio…"
      : playing
        ? "Pause"
        : "Play story";
  const regenTitle = !audio
    ? "Generate audio first"
    : regenerating
      ? "Regenerating…"
      : "Regenerate audio";

  return (
    <div className="playback-footer" role="region" aria-label="Audio playback">
      <div className="playback-footer-inner">
        <div className="playback-left">
          <label className="playback-speed">
            <span className="playback-speed-label">Speed</span>
            <select
              value={playbackRate}
              onChange={(e) => setPlaybackRate(Number(e.target.value))}
              aria-label="Playback speed"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </label>
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
            className="playback-regen-btn"
            onClick={handleRegenerate}
            disabled={busy || !audio}
            title={regenTitle}
            aria-label="Regenerate audio"
          >
            {regenerating ? (
              <span className="playback-spinner" aria-hidden="true" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13.5 2.5v3.5h-3.5" />
                <path d="M13.5 6A5.5 5.5 0 1 0 14 9.5" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {error && <div className="playback-error" role="alert">{error}</div>}
      {audioElement}
    </div>
  );
}
