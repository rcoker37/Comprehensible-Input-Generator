import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  clearAllStoryWordOverrides,
  deleteStory,
  getStory,
  updateStoryContent,
} from "../api/client";
import { useStories } from "../contexts/StoriesContext";
import { useWordIndexBackfill } from "../contexts/WordIndexBackfillContext";
import type { Story } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import StoryReadButton from "../components/StoryReadButton";
import AnimatedDots from "../components/AnimatedDots";
import "../components/StoryActions.css";
import "./StoryDetail.css";

export default function StoryDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { removeStory, applyStoryUpdate } = useStories();
  const {
    refresh: refreshBackfill,
    currentStoryId: backfillCurrentStoryId,
  } = useWordIndexBackfill();
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [resettingOverrides, setResettingOverrides] = useState(false);
  // True when an override save / content edit / reset has nulled the
  // word index and we're waiting for the backfill to re-stamp it. Set
  // eagerly in each handler so the glassy loading overlay appears the
  // moment the user clicks; cleared after we refetch the story (so
  // `word_index_at` is restored locally and the popover taps re-enable).
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (id) {
      getStory(Number(id))
        .then(setStory)
        .catch((err) => setError(err instanceof Error ? err.message : "Failed to load story"))
        .finally(() => setLoading(false));
    }
  }, [id]);

  const refetchStory = useCallback(async () => {
    if (!id) return;
    try {
      const fresh = await getStory(Number(id));
      setStory(fresh);
      applyStoryUpdate(Number(id), {
        word_index_at: fresh.word_index_at,
      });
    } catch (err) {
      console.warn("Failed to refetch story after re-index:", err);
    }
  }, [id, applyStoryUpdate]);

  // Watch the backfill — once it finishes processing our story
  // (currentStoryId leaves story.id), refetch to pick up the new
  // word_index_at timestamp. Without this, the local story state stays
  // at word_index_at=null forever after an override save / reset / edit,
  // which permanently disables popover taps until the user reloads.
  const prevCurrentRef = useRef<number | null>(backfillCurrentStoryId);
  useEffect(() => {
    const prev = prevCurrentRef.current;
    prevCurrentRef.current = backfillCurrentStoryId;
    if (!story) return;
    if (prev === story.id && backfillCurrentStoryId !== story.id) {
      refetchStory().then(() => setRegenerating(false));
    }
  }, [backfillCurrentStoryId, story, refetchStory]);

  // Safety net: if the backfill never picks the story up (dict not
  // ready, queue stalled, etc.), drop the regenerating flag after 15s
  // so the loader doesn't stick. The popover will still be disabled
  // until something refreshes word_index_at, but at least the story
  // text comes back.
  useEffect(() => {
    if (!regenerating) return;
    const t = window.setTimeout(() => setRegenerating(false), 15000);
    return () => window.clearTimeout(t);
  }, [regenerating]);

  const handleDelete = async () => {
    if (!id) return;
    if (!window.confirm("Delete this story? This cannot be undone.")) return;
    try {
      await deleteStory(Number(id));
      removeStory(Number(id));
      navigate("/stories");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete story");
    }
  };

  const handleStartEdit = () => {
    if (!story) return;
    setEditDraft(story.content);
    setEditing(true);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditDraft("");
  };

  const handleSaveEdit = async () => {
    if (!story) return;
    const draft = editDraft;
    setSaving(true);
    setRegenerating(true);
    setError(null);
    try {
      await updateStoryContent(story.id, draft);
      // Offsets shifted, so every offset-keyed cache on the story is now
      // stale. The RPC cleared translations + word_lookups + occurrences
      // server-side and nulled word_index_at + word_index_version; reflect
      // that locally so StoryDisplay treats taps as disabled until the
      // backfill picks the row up.
      const patch: Partial<Story> = {
        content: draft,
        translations: {},
        word_index_at: null,
      };
      setStory((s) => (s ? { ...s, ...patch } : s));
      applyStoryUpdate(story.id, patch);
      refreshBackfill();
      setEditing(false);
      setEditDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save edits");
      setRegenerating(false);
    } finally {
      setSaving(false);
    }
  };

  const handleResetOverrides = async () => {
    if (!story) return;
    if (
      !window.confirm(
        "Reset all manual overrides on this story? The algorithm will re-index from scratch."
      )
    )
      return;
    setResettingOverrides(true);
    setRegenerating(true);
    setError(null);
    try {
      await clearAllStoryWordOverrides(story.id);
      const patch: Partial<Story> = { word_index_at: null };
      setStory((s) => (s ? { ...s, ...patch } : s));
      applyStoryUpdate(story.id, patch);
      refreshBackfill();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset overrides");
      setRegenerating(false);
    } finally {
      setResettingOverrides(false);
    }
  };

  if (loading) return <div className="loading">Loading<AnimatedDots /></div>;
  if (error && !story) return <div className="error">{error}</div>;
  if (!story) return <div className="error">Story not found</div>;

  return (
    <div className="story-detail-page">
      <div className="story-detail-actions">
        <button
          type="button"
          className="story-detail-back"
          onClick={() => navigate("/stories")}
        >
          &larr; Compositions
        </button>
        <div className="story-detail-actions-right">
          {!editing && (
            <>
              <button
                type="button"
                className="story-action-btn"
                onClick={handleResetOverrides}
                title="Reset all manual word-boundary overrides for this story"
                aria-label="Reset overrides"
                disabled={resettingOverrides}
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
                  <path d="M2 8a6 6 0 0 1 10.6-3.8" />
                  <path d="M13 2v3h-3" />
                  <path d="M14 8a6 6 0 0 1-10.6 3.8" />
                  <path d="M3 14v-3h3" />
                </svg>
              </button>
              <button
                type="button"
                className="story-action-btn"
                onClick={handleStartEdit}
                title="Edit story text"
                aria-label="Edit story text"
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
                  <path d="M12 2l2 2-8.5 8.5L3 13l.5-2.5L12 2z" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            className="story-action-btn"
            onClick={handleDelete}
            title="Delete story"
            aria-label="Delete story"
            disabled={editing || resettingOverrides}
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
      {editing ? (
        <div className="story-edit">
          <p className="story-edit-help">
            Editing wipes this story's translations, lookup history, and word
            index. Use Aozora ruby notation: <code>漢字《かんじ》</code>.
          </p>
          <textarea
            className="story-edit-textarea"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            spellCheck={false}
            disabled={saving}
          />
          {error && <div className="story-edit-error">{error}</div>}
          <div className="story-edit-actions">
            <button
              type="button"
              className="story-edit-cancel"
              onClick={handleCancelEdit}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="button"
              className="story-edit-save"
              onClick={handleSaveEdit}
              disabled={saving || editDraft === story.content}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <StoryDisplay
            story={story}
            regenerating={regenerating}
            onRegenerationStart={() => setRegenerating(true)}
          />
          <StoryReadButton
            story={story}
            onChange={(state) => {
              setStory((s) => (s ? { ...s, ...state } : s));
              applyStoryUpdate(story.id, state);
            }}
          />
        </>
      )}
    </div>
  );
}
