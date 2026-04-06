import { annotateWithRuby } from "../api/client";
import type { Story } from "../types";
import "./StoryDisplay.css";

interface Props {
  story: Story;
  showLink?: boolean;
}

export default function StoryDisplay({ story, showLink }: Props) {
  const hasViolations =
    story.violations &&
    story.violations.length > 0 &&
    story.violation_readings &&
    Object.keys(story.violation_readings).length > 0;

  return (
    <div className="story-display">
      <h2 className="story-title">{story.title}</h2>
      <div className="story-meta">
        <span className="formality-tag">{story.formality}</span>
        {story.topic && <span className="topic-tag">{story.topic}</span>}
      </div>
      <div className="story-content">
        {hasViolations
          ? story.content.split("\n\n").map((p, i) => (
              <p
                key={i}
                dangerouslySetInnerHTML={{
                  __html: annotateWithRuby(p, story.violation_readings!),
                }}
              />
            ))
          : story.content.split("\n\n").map((p, i) => <p key={i}>{p}</p>)}
      </div>
      {story.violations && story.violations.length > 0 && (
        <div className="violations">
          {story.violations.length} kanji outside your filter were marked with
          readings: {story.violations.join(", ")}
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
