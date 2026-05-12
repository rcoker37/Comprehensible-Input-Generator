import { useMemo } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { GenerationProvider } from "../contexts/GenerationContext";
import { KanjiProvider, useKnownKanji } from "../contexts/KanjiContext";
import { VocabProvider, useVocab } from "../contexts/VocabContext";
import { DictionaryProvider, useDictionary } from "../contexts/DictionaryContext";
import { WordIndexBackfillProvider } from "../contexts/WordIndexBackfillContext";
import { formatScore, totalScore } from "../lib/rarity";
import { totalVocabScore } from "../lib/vocabScore";
import AnimatedDots from "./AnimatedDots";
import ThemeToggle from "./ThemeToggle";

function DictionaryStatusChip() {
  const { state, error } = useDictionary();
  if (state === "ready" || state === "idle") return null;
  const content =
    state === "loading" ? (
      <>
        Loading dictionary
        <AnimatedDots />
      </>
    ) : state === "error" ? (
      `Dictionary error${error ? `: ${error}` : ""}`
    ) : (
      ""
    );
  return <span className={`nav-dict-status nav-dict-status--${state}`}>{content}</span>;
}

function NavTotalScore() {
  const { kanjiExposures, kanjiExposuresLoaded } = useKnownKanji();
  const { vocabEncounters, vocabEncountersLoaded } = useVocab();
  const kanji = useMemo(() => totalScore(kanjiExposures), [kanjiExposures]);
  const vocab = useMemo(() => totalVocabScore(vocabEncounters), [vocabEncounters]);
  // Show whatever's loaded — a vocab fetch hiccup shouldn't blank out the
  // whole header. If neither has loaded yet, render nothing.
  if (!kanjiExposuresLoaded && !vocabEncountersLoaded) return null;
  return (
    <span
      className="nav-score"
      title={`Kanji ${formatScore(kanji)} + vocab ${formatScore(vocab)}`}
    >
      ★ {formatScore(kanji + vocab)}
    </span>
  );
}

export default function AppLayout() {
  const { user } = useAuth();

  return (
    <DictionaryProvider>
      <KanjiProvider>
        <VocabProvider>
          <WordIndexBackfillProvider>
            <div className="app">
              <nav className="nav">
                <div className="nav-brand">読む練習</div>
                <div className="nav-links">
                  <NavLink to="/">Generate</NavLink>
                  <NavLink to="/stories">Compositions</NavLink>
                  <NavLink to="/kanji">Kanji</NavLink>
                  <NavLink to="/stats">Stats</NavLink>
                  <NavLink to="/settings">Settings</NavLink>
                </div>
                {user && (
                  <span className="nav-user">
                    <DictionaryStatusChip />
                    <NavTotalScore />
                    <ThemeToggle />
                    <span>{user.email}</span>
                  </span>
                )}
              </nav>
              <main className="main">
                <GenerationProvider>
                  <Outlet />
                </GenerationProvider>
              </main>
            </div>
          </WordIndexBackfillProvider>
        </VocabProvider>
      </KanjiProvider>
    </DictionaryProvider>
  );
}
