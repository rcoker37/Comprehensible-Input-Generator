import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { annotateStory, getStory, deleteStory } from "../api/client";
import { tokenizeForAnnotations } from "../lib/tokenizer";
import { stripBold } from "../lib/text";
import { CURRENT_ANNOTATION_VERSION } from "../lib/constants";
import { parseAnnotatedText } from "../lib/furigana";
import type { Story, StoryAnnotations, StoryAudio } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import AnimatedDots from "../components/AnimatedDots";
import PlaybackFooter from "../components/PlaybackFooter";
import { useAudioPlayer } from "../hooks/useAudioPlayer";
import "./StoryDetail.css";

export default function StoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const annotateTriggeredRef = useRef<number | null>(null);

  useEffect(() => {
    if (id) {
      getStory(Number(id))
        .then(setStory)
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to load story"))
        .finally(() => setLoading(false));
    }
  }, [id]);

  const runAnnotate = useCallback(
    async (storyId: number, storyContent: string, force: boolean) => {
      setAnnotating(true);
      try {
        const { cleanText, annotations: rubyAnnotations } = parseAnnotatedText(
          stripBold(storyContent)
        );
        const tokens = await tokenizeForAnnotations(cleanText, rubyAnnotations);
        const annotations: StoryAnnotations = await annotateStory(
          storyId,
          cleanText,
          tokens,
          { force }
        );
        setStory((s) => (s && s.id === storyId ? { ...s, annotations } : s));
      } catch (err) {
        console.warn("annotate-story failed:", err);
      } finally {
        setAnnotating(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!story) return;
    const fresh =
      story.annotations?.version === CURRENT_ANNOTATION_VERSION;
    if (fresh) return;
    if (annotateTriggeredRef.current === story.id) return;
    annotateTriggeredRef.current = story.id;
    runAnnotate(story.id, story.content, false);
  }, [story, runAnnotate]);

  const handleRegenerateAnnotations = () => {
    if (!story || annotating) return;
    runAnnotate(story.id, story.content, true);
  };

  const handleAudioGenerated = useCallback((audio: StoryAudio) => {
    setStory((s) => (s ? { ...s, audio } : s));
  }, []);

  const player = useAudioPlayer(story, handleAudioGenerated);

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm("Delete this story? This cannot be undone.")) return;
    try {
      await deleteStory(Number(id));
      navigate("/stories");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete story");
    }
  };

  if (loading) return <div className="loading">Loading...</div>;
  if (error) return <div className="error">{error}</div>;
  if (!story) return <div className="error">Story not found</div>;

  return (
    <div className="story-detail-page">
      <div className="story-detail-actions">
        <button
          type="button"
          className="story-detail-back"
          onClick={() => navigate("/stories")}
        >
          &larr; Stories
        </button>
        <div className="story-detail-actions-right">
          <button
            type="button"
            className="story-detail-regenerate"
            onClick={handleRegenerateAnnotations}
            disabled={annotating || !story.annotations}
            title="Regenerate lookup data"
          >
            {annotating ? "Regenerating…" : "Regenerate lookup data"}
          </button>
          <button
            type="button"
            className="delete-btn"
            onClick={handleDelete}
            title="Delete story"
            aria-label="Delete story"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.5 4h11" />
              <path d="M6 4V2.5h4V4" />
              <path d="M3.5 4l.7 9a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9L12.5 4" />
            </svg>
          </button>
        </div>
      </div>
      {annotating && (
        <div className="story-detail-annotating">
          Generating lookup data<AnimatedDots />
        </div>
      )}
      <StoryDisplay
        story={story}
        audio={player.audio}
        activeParagraphIdx={player.activeParagraphIdx}
        onParagraphClick={player.seekToParagraph}
      />
      <PlaybackFooter {...player} />
    </div>
  );
}
