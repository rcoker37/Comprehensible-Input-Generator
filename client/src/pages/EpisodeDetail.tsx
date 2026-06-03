import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  getEpisode,
  getEpisodeOccurrences,
  type StoryOccurrence,
} from "../api/client";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import { useMedia } from "../contexts/MediaContext";
import type { MediaEpisode } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import EpisodeReadButton from "../components/EpisodeReadButton";
import LookupsButton from "../components/LookupsButton";
import AnimatedDots from "../components/AnimatedDots";
import "../components/StoryActions.css";
import "./StoryDetail.css";

export default function EpisodeDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { completedTick } = useMedia();
  const { currentMediaEpisodeId } = useWordIndexBackfill();
  const [episode, setEpisode] = useState<MediaEpisode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [markedHeadwords, setMarkedHeadwords] = useState<Set<string>>(
    () => new Set()
  );
  const [occurrences, setOccurrences] = useState<StoryOccurrence[]>([]);

  const toggleMark = useCallback((headword: string) => {
    setMarkedHeadwords((prev) => {
      const next = new Set(prev);
      if (next.has(headword)) next.delete(headword);
      else next.add(headword);
      return next;
    });
  }, []);

  const load = useCallback(() => {
    if (!id) return;
    getEpisode(Number(id))
      .then(setEpisode)
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Failed to load episode")
      )
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // Refetch when this episode finishes annotation (completedTick) so the body
  // appears once content is ready without a manual reload.
  useEffect(() => {
    if (!episode) return;
    if (episode.status !== "complete") load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedTick]);

  // Refetch once the backfill finishes indexing this episode (so word_index_at
  // flips locally and the tap targets light up).
  const prevBackfill = useRef<number | null>(currentMediaEpisodeId);
  useEffect(() => {
    const prev = prevBackfill.current;
    prevBackfill.current = currentMediaEpisodeId;
    if (!episode) return;
    if (prev === episode.id && currentMediaEpisodeId !== episode.id) load();
  }, [currentMediaEpisodeId, episode, load]);

  const episodeLoader = useCallback(
    () => getEpisodeOccurrences(Number(id)),
    [id]
  );

  if (loading) return <div className="loading">Loading<AnimatedDots /></div>;
  if (error && !episode) return <div className="error">{error}</div>;
  if (!episode) return <div className="error">Episode not found</div>;

  return (
    <div className="story-detail-page">
      <div className="story-detail-actions">
        <button
          type="button"
          className="story-detail-back"
          onClick={() => navigate(`/media/series/${episode.series_id}`)}
        >
          &larr; Episodes
        </button>
      </div>

      {episode.status !== "complete" ? (
        <div className="loading">
          {episode.status === "failed" ? (
            <span className="error">
              Annotation failed{episode.error_message ? `: ${episode.error_message}` : ""}.
            </span>
          ) : (
            <>
              Adding furigana<AnimatedDots />
            </>
          )}
        </div>
      ) : (
        <>
          <StoryDisplay
            story={episode}
            occurrenceLoader={episodeLoader}
            sourceHref={`/media/episodes/${episode.id}`}
            markedHeadwords={markedHeadwords}
            onToggleMark={toggleMark}
            onOccurrencesChange={setOccurrences}
          />
          <div className="story-detail-actions-row">
            <EpisodeReadButton
              episode={episode}
              onChange={(state) =>
                setEpisode((e) => (e ? { ...e, ...state } : e))
              }
            />
            <LookupsButton
              content={episode.content}
              occurrences={occurrences}
              markedHeadwords={markedHeadwords}
              hidden={episode.word_index_at === null}
            />
          </div>
        </>
      )}
    </div>
  );
}
