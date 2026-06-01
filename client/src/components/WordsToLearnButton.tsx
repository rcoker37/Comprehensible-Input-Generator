import { useState } from "react";
import WordsToLearnModal, {
  type WordsToLearnSource,
} from "./WordsToLearnModal";
import "./WordsToLearnButton.css";

interface Props {
  source: WordsToLearnSource;
  /** Hide when nothing's worth showing — e.g. chats with no complete assistant
   *  message yet, or stories that haven't been indexed. The parent decides. */
  hidden?: boolean;
}

export default function WordsToLearnButton({ source, hidden }: Props) {
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  return (
    <>
      <button
        type="button"
        className="words-to-learn-btn"
        onClick={() => setOpen(true)}
      >
        Words to learn
      </button>
      <WordsToLearnModal
        source={source}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
