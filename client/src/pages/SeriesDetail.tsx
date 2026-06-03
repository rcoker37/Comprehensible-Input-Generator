import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  deleteSeries,
  getEpisodesForSeries,
  getPerEpisodePayout,
  getSeries,
} from "../api/client";
import { useMedia } from "../contexts/MediaContext";
import { useSeenKanji } from "../contexts/KanjiContext";
import { useVocab } from "../contexts/VocabContext";
import { formatScore, kanjiCountsDelta } from "../lib/rarity";
import { vocabScoreDelta } from "../lib/vocabScore";
import type { MediaEpisode, MediaSeries } from "../types";
import AnimatedDots from "../components/AnimatedDots";
import "./Stories.css";

export default function SeriesDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { completedTick, inFlight, removeSeries } = useMedia();
  const { kanjiExposures } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded, getWordRank } = useVocab();

  const [series, setSeries] = useState<MediaSeries | null>(null);
  const [episodes, setEpisodes] = useState<MediaEpisode[]>([]);
  const [payout, setPayout] = useState<
    Map<number, { wordCounts: Map<string, number>; kanjiCounts: Map<string, number> }>
  >(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEpisodes = useCallback(() => {
    if (!id) return;
    getEpisodesForSeries(Number(id))
      .then(setEpisodes)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load episodes")
      );
  }, [id]);

  const loadPayout = useCallback(() => {
    getPerEpisodePayout()
      .then((rows) => {
        const m = new Map<
          number,
          { wordCounts: Map<string, number>; kanjiCounts: Map<string, number> }
        >();
        for (const r of rows) {
          let entry = m.get(r.episode_id);
          if (!entry) {
            entry = { wordCounts: new Map(), kanjiCounts: new Map() };
            m.set(r.episode_id, entry);
          }
          const target = r.kind === "word" ? entry.wordCounts : entry.kanjiCounts;
          target.set(r.key, (target.get(r.key) ?? 0) + r.count);
        }
        setPayout(m);
      })
      .catch((err) => console.warn("Failed to load episode payout:", err));
  }, []);

  useEffect(() => {
    if (!id) return;
    Promise.all([getSeries(Number(id)), getEpisodesForSeries(Number(id))])
      .then(([s, eps]) => {
        setSeries(s);
        setEpisodes(eps);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load series")
      )
      .finally(() => setLoading(false));
    loadPayout();
  }, [id, loadPayout]);

  // Refetch episodes + payout each time an annotation completes.
  useEffect(() => {
    loadEpisodes();
    loadPayout();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedTick]);

  const deltaById = useMemo(() => {
    const m = new Map<number, number>();
    if (!vocabEncountersLoaded) return m;
    for (const ep of episodes) {
      if (ep.read_count > 0 || ep.status !== "complete" || !ep.word_index_at) continue;
      const p = payout.get(ep.id);
      if (!p) continue;
      const kanji = kanjiCountsDelta(p.kanjiCounts, kanjiExposures);
      const vocab = vocabScoreDelta(p.wordCounts, vocabEncounters, getWordRank);
      m.set(ep.id, kanji + vocab);
    }
    return m;
  }, [episodes, payout, kanjiExposures, vocabEncounters, vocabEncountersLoaded, getWordRank]);

  const handleDeleteSeries = async () => {
    if (!series) return;
    if (!window.confirm(`Delete "${series.title}" and all its episodes? This cannot be undone.`))
      return;
    try {
      await deleteSeries(series.id);
      removeSeries(series.id);
      navigate("/media");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete series");
    }
  };

  if (loading) return <div className="loading">Loading<AnimatedDots /></div>;
  if (error && !series) return <div className="error">{error}</div>;
  if (!series) return <div className="error">Series not found</div>;

  return (
    <div className="stories-page">
      <div className="stories-page-header">
        <button
          type="button"
          className="story-detail-back"
          onClick={() => navigate("/media")}
        >
          &larr; Media
        </button>
        <h1>{series.title}</h1>
        <button className="delete-btn" onClick={handleDeleteSeries} title="Delete series">
          <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="3" x2="11" y2="11"/><line x1="11" y1="3" x2="3" y2="11"/></svg>
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {episodes.length === 0 ? (
        <p className="empty">No episodes imported yet.</p>
      ) : (
        <div className="story-list">
          {episodes.map((ep) => {
            const busy = ep.status !== "complete" || inFlight.has(ep.id);
            const annotating = ep.status === "pending" || ep.status === "annotating";
            return (
              <div key={ep.id} className="story-card">
                <div className="story-card-header">
                  {busy ? (
                    <span className="story-card-title" style={{ opacity: 0.7 }}>
                      {ep.title}
                    </span>
                  ) : (
                    <Link to={`/media/episodes/${ep.id}`} className="story-card-title">
                      {ep.title}
                    </Link>
                  )}
                  <div className="story-card-header-actions">
                    {ep.read_count > 0 && <span className="read-tag">✓ Watched</span>}
                  </div>
                </div>
                <div className="story-card-meta">
                  {annotating && (
                    <span className="type-tag">
                      Adding furigana<AnimatedDots />
                    </span>
                  )}
                  {ep.status === "failed" && (
                    <span className="error">Annotation failed</span>
                  )}
                  {(deltaById.get(ep.id) ?? 0) > 0 && (
                    <span className="score-tag" title="Score gain if marked watched">
                      +{formatScore(deltaById.get(ep.id) ?? 0)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
