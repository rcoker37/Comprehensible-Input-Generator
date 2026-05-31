// Shared furigana / highlight / font toggle row. The CSS classes are the
// historical `furigana-*` names (extracted from StoryDisplay) — kept as-is
// to avoid churn in matching selectors, even though the controls now span
// more than just furigana.

import type { DisplayMode, FontMode, HighlightMode } from "../types";
import "./ReaderControls.css";

const DISPLAY_LABEL: Record<DisplayMode, string> = {
  off: "off",
  unseen: "unseen",
  all: "all",
};
const HIGHLIGHT_LABEL: Record<HighlightMode, string> = {
  off: "off",
  frequency: "frequency",
  encounters: "encounters",
  fiveplus: "5+ reads",
};
const FONT_LABEL: Record<FontMode, string> = {
  serif: "serif",
  sans: "sans",
};

interface Props {
  furigana: DisplayMode;
  highlight: HighlightMode;
  font: FontMode;
  onFuriganaCycle: () => void;
  onHighlightCycle: () => void;
  onFontCycle: () => void;
}

export default function ReaderControls({
  furigana,
  highlight,
  font,
  onFuriganaCycle,
  onHighlightCycle,
  onFontCycle,
}: Props) {
  return (
    <div className="story-display-controls">
      <div className="furigana-control">
        <span className="furigana-label">furigana: </span>
        <button
          type="button"
          className="furigana-toggle"
          onClick={onFuriganaCycle}
        >
          {DISPLAY_LABEL[furigana]}
        </button>
      </div>
      <div className="furigana-control">
        <span className="furigana-label">highlight: </span>
        <button
          type="button"
          className="furigana-toggle"
          onClick={onHighlightCycle}
        >
          {HIGHLIGHT_LABEL[highlight]}
        </button>
      </div>
      <div className="furigana-control">
        <span className="furigana-label">font: </span>
        <button
          type="button"
          className="furigana-toggle"
          onClick={onFontCycle}
        >
          {FONT_LABEL[font]}
        </button>
      </div>
    </div>
  );
}
