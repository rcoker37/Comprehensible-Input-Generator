// Shared furigana / font toggle row. CSS classes keep their historical
// `furigana-*` names — the same pill houses the font toggle.

import { FURIGANA_UNSEEN_THRESHOLD, type DisplayMode, type FontMode } from "../types";
import "./ReaderControls.css";

const DISPLAY_LABEL: Record<DisplayMode, string> = {
  off: "off",
  unseen: `< ${FURIGANA_UNSEEN_THRESHOLD} reads`,
  all: "all",
};
const FONT_LABEL: Record<FontMode, string> = {
  serif: "serif",
  sans: "sans",
};

interface Props {
  furigana: DisplayMode;
  font: FontMode;
  onFuriganaCycle: () => void;
  onFontCycle: () => void;
}

export default function ReaderControls({
  furigana,
  font,
  onFuriganaCycle,
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
