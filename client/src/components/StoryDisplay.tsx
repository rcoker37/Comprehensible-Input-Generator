import type { Story } from "../types";
import DifficultyBadge from "./DifficultyBadge";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
}

export default function StoryDisplay({ story, showLink }: Props) {
  return (
    <div className="story-display">
      <h2 className="story-title">{story.title}</h2>
      <div className="story-meta">
        <DifficultyBadge difficulty={story.difficulty} />
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
      </div>
      <div className="story-content">
        {story.content.split("\n\n").map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>
      {story.violations && story.violations.length > 0 && (
        <div className="violations">
          Note: {story.violations.length} kanji outside your filter were used:{" "}
          {story.violations.join(", ")}
        </div>
      )}
      {showLink && (
        <a href={`/stories/${story.id}`} className="story-link">
          View full story
        </a>
      )}
    </div>
  );
}
