import { useState } from "react";
import { Link } from "react-router-dom";
import { useMedia } from "../contexts/MediaContext";
import ImportMediaModal from "../components/ImportMediaModal";
import AnimatedDots from "../components/AnimatedDots";
import "./Stories.css";

export default function Media() {
  const { seriesList, seriesLoaded } = useMedia();
  const [modalOpen, setModalOpen] = useState(false);

  if (!seriesLoaded)
    return <div className="loading">Loading media<AnimatedDots /></div>;

  return (
    <div className="stories-page">
      <div className="stories-page-header">
        <h1>Media</h1>
      </div>
      <ImportMediaModal open={modalOpen} onClose={() => setModalOpen(false)} />
      {seriesList.length === 0 ? (
        <p className="empty">
          No shows yet. Tap the + button to import anime subtitles from jimaku.cc.
        </p>
      ) : (
        <div className="story-list">
          {seriesList.map((s) => (
            <div key={s.id} className="story-card">
              <div className="story-card-header">
                <Link to={`/media/series/${s.id}`} className="story-card-title">
                  {s.title}
                </Link>
              </div>
              <div className="story-card-meta">
                <span className="type-tag">{s.kind}</span>
                <span className="date">
                  {new Date(s.last_activity_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        className="fab-generate"
        onClick={() => setModalOpen(true)}
        title="Import subtitles"
        aria-label="Import subtitles"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}
