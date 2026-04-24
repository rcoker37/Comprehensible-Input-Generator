import { useEffect, useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { useKnownKanji } from "../contexts/KanjiContext";
import { supabase } from "../lib/supabase";
import { toggleKanji } from "../api/client";
import "./KanjiInlineDetail.css";

interface KanjiRow {
  character: string;
  grade: number;
  jlpt: number | null;
  meanings: string;
  readings_on: string;
  readings_kun: string;
}

export default function KanjiInlineDetail({
  char,
  onBack,
}: {
  char: string;
  onBack: () => void;
}) {
  const { user } = useAuth();
  const { knownKanji, refreshKnownKanji } = useKnownKanji();
  const [row, setRow] = useState<KanjiRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    supabase
      .from("kanji")
      .select("character, grade, jlpt, meanings, readings_on, readings_kun")
      .eq("character", char)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setError(error.message);
        else setRow(data as KanjiRow);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [char]);

  const known = knownKanji.has(char);

  const handleToggle = async () => {
    if (!user || toggling) return;
    setToggling(true);
    try {
      await toggleKanji(user.id, char, known);
      await refreshKnownKanji();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="kanji-inline">
      <button type="button" className="kanji-inline__back" onClick={onBack}>
        ← Back
      </button>
      <div className="kanji-inline__char">{char}</div>
      {loading && <div className="kanji-inline__status">Loading…</div>}
      {error && <div className="kanji-inline__error">{error}</div>}
      {row && (
        <>
          <div className="kanji-inline__meanings">{row.meanings}</div>
          <dl className="kanji-inline__meta">
            {row.readings_on && (
              <>
                <dt>On</dt>
                <dd>{row.readings_on}</dd>
              </>
            )}
            {row.readings_kun && (
              <>
                <dt>Kun</dt>
                <dd>{row.readings_kun}</dd>
              </>
            )}
            <dt>Grade</dt>
            <dd>{row.grade === 8 ? "Secondary" : `Elementary ${row.grade}`}</dd>
            {row.jlpt != null && (
              <>
                <dt>JLPT</dt>
                <dd>N{row.jlpt}</dd>
              </>
            )}
          </dl>
          <button
            type="button"
            className={`kanji-inline__toggle ${known ? "is-known" : ""}`}
            onClick={handleToggle}
            disabled={toggling}
          >
            {toggling ? "…" : known ? "Mark unknown" : "Mark known"}
          </button>
        </>
      )}
    </div>
  );
}
