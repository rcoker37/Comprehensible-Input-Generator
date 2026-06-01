// Shared furigana / lookups / font toggle row. The CSS classes are the
// historical `furigana-*` names (extracted from StoryDisplay) — kept as-is
// to avoid churn in matching selectors, even though the controls now span
// more than just furigana.

import type { DisplayMode, FontMode } from "../types";
import "./ReaderControls.css";

const DISPLAY_LABEL: Record<DisplayMode, string> = {
  off: "off",
  unseen: "unseen",
  all: "all",
};
const FONT_LABEL: Record<FontMode, string> = {
  serif: "serif",
  sans: "sans",
};

interface Props {
  furigana: DisplayMode;
  showSavedLookups: boolean;
  font: FontMode;
  onFuriganaCycle: () => void;
  onShowSavedLookupsToggle: () => void;
  onFontCycle: () => void;
}

export default function ReaderControls({
  furigana,
  showSavedLookups,
  font,
  onFuriganaCycle,
  onShowSavedLookupsToggle,
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
        <span className="furigana-label">lookups: </span>
        <button
          type="button"
          className="furigana-toggle"
          onClick={onShowSavedLookupsToggle}
        >
          {showSavedLookups ? "on" : "off"}
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
