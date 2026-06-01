import { useState } from "react";
import LookupsModal, { type LookupOccurrence } from "./LookupsModal";
import "./LookupsButton.css";

interface Props {
  content: string;
  occurrences: LookupOccurrence[];
  markedHeadwords: Set<string>;
  /** Hide when the passage isn't indexed yet or the parent has no content to show. */
  hidden?: boolean;
}

export default function LookupsButton({
  content,
  occurrences,
  markedHeadwords,
  hidden,
}: Props) {
  const [open, setOpen] = useState(false);
  if (hidden) return null;
  const count = markedHeadwords.size;
  return (
    <>
      <button
        type="button"
        className="lookups-btn"
        onClick={() => setOpen(true)}
      >
        Lookups{count > 0 ? ` (${count})` : ""}
      </button>
      <LookupsModal
        content={content}
        occurrences={occurrences}
        markedHeadwords={markedHeadwords}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
