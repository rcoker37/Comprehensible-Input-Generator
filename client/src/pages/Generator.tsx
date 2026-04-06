import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { generateStoryStream, getKanjiCount } from "../api/client";
import type { Formality, Story } from "../types";
import StoryDisplay from "../components/StoryDisplay";
import "./Generator.css";

const JLPT_LEVELS = [5, 4, 3, 2, 1];
const GRADES = [1, 2, 3, 4, 5, 6, 8];
const GRADE_LABELS: Record<number, string> = {
  1: "1", 2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 8: "S",
};

export default function Generator() {
  const { user, profile } = useAuth();
  const [paragraphs, setParagraphs] = useState(1);
  const [topic, setTopic] = useState("");
  const [formality, setFormality] = useState<Formality>("polite");
  const [knownOnly, setKnownOnly] = useState(true);
  const [jlptLevels, setJlptLevels] = useState<number[]>([]);
  const [grades, setGrades] = useState<number[]>([]);
  const [kanjiCount, setKanjiCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [streamingText, setStreamingText] = useState<string | null>(null);

  const userId = user!.id;

  useEffect(() => {
    getKanjiCount(userId, {
      knownOnly,
      jlpt: jlptLevels.length > 0 ? jlptLevels : undefined,
      grade: grades.length > 0 ? grades : undefined,
    }).then(setKanjiCount);
  }, [userId, knownOnly, jlptLevels, grades]);

  const toggleChip = (value: number, list: number[], setter: (v: number[]) => void) => {
    setter(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };

  const handleGenerate = async () => {
    if (!profile?.openrouter_api_key) {
      setError("Please set your OpenRouter API key in Settings first.");
      return;
    }
    setLoading(true);
    setError(null);
    setStory(null);
    setStreamingText(null);
    try {
      const result = await generateStoryStream(
        userId,
        {
          paragraphs,
          topic: topic.trim() || undefined,
          formality,
          filters: { knownOnly, jlptLevels, grades },
        },
        (text) => setStreamingText(text)
      );
      setStreamingText(null);
      setStory(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="generator">
      <h1>Generate a Story</h1>

      <div className="form-section">
        <div className="form-row">
          <label>
            Paragraphs
            <select
              value={paragraphs}
              onChange={(e) => setParagraphs(Number(e.target.value))}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Topic <span className="optional">(optional)</span></span>
            <input
              type="text"
              placeholder="e.g., cooking, school life, travel..."
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
          </label>
        </div>

        <div className="form-group">
          <label>Formality</label>
          <div className="chip-group">
            {(["impolite", "casual", "polite", "keigo"] as Formality[]).map((f) => (
              <button
                key={f}
                className={`chip ${formality === f ? "active" : ""}`}
                onClick={() => setFormality(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>
            <input
              type="checkbox"
              checked={knownOnly}
              onChange={(e) => setKnownOnly(e.target.checked)}
            />
            Only known kanji
          </label>
        </div>

        <div className="form-group">
          <label>JLPT Level</label>
          <div className="chip-group">
            {JLPT_LEVELS.map((n) => (
              <button
                key={n}
                className={`chip ${jlptLevels.includes(n) ? "active" : ""}`}
                onClick={() => toggleChip(n, jlptLevels, setJlptLevels)}
              >
                N{n}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Grade</label>
          <div className="chip-group">
            {GRADES.map((g) => (
              <button
                key={g}
                className={`chip ${grades.includes(g) ? "active" : ""}`}
                onClick={() => toggleChip(g, grades, setGrades)}
              >
                {GRADE_LABELS[g]}
              </button>
            ))}
          </div>
        </div>

        <div className="kanji-count">
          {kanjiCount !== null && `${kanjiCount} kanji match this filter`}
        </div>

        <button
          className="generate-btn"
          onClick={handleGenerate}
          disabled={loading}
        >
          {loading ? "Generating..." : "Generate Story"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}
      {streamingText && (
        <div className="story-display">
          <div className="story-content">
            {streamingText.split("\n").filter((l) => l.trim()).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>
        </div>
      )}
      {story && <StoryDisplay story={story} />}
    </div>
  );
}
