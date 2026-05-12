import { useMemo } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { GenerationProvider } from "../contexts/GenerationContext";
import { KanjiProvider, useSeenKanji } from "../contexts/KanjiContext";
import { VocabProvider, useVocab } from "../contexts/VocabContext";
import { DictionaryProvider, useDictionary } from "../contexts/DictionaryContext";
import { WordIndexBackfillProvider } from "../contexts/WordIndexBackfillContext";
import { StoriesProvider } from "../contexts/StoriesContext";
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
  const { kanjiExposures, kanjiExposuresLoaded } = useSeenKanji();
  const { vocabEncounters, vocabEncountersLoaded, getWordRank } = useVocab();
  const kanji = useMemo(() => totalScore(kanjiExposures), [kanjiExposures]);
  const vocab = useMemo(
    () => totalVocabScore(vocabEncounters, getWordRank),
    [vocabEncounters, getWordRank]
  );
  if (!kanjiExposuresLoaded && !vocabEncountersLoaded) return null;
  const kanjiPortion = kanjiExposuresLoaded ? kanji : 0;
  const total = vocabEncountersLoaded ? kanjiPortion + vocab : kanjiPortion;
  return (
    <span
      className="nav-score"
      title={
        vocabEncountersLoaded
          ? `Kanji ${formatScore(kanji)} + vocab ${formatScore(vocab)}`
          : `Kanji ${formatScore(kanji)}, vocab loading…`
      }
    >
      ★ {formatScore(total)}
      {!vocabEncountersLoaded && <AnimatedDots />}
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
            <StoriesProvider>
              <div className="app">
                <nav className="nav">
                  <div className="nav-brand">読む練習</div>
                  <div className="nav-links">
                    <NavLink to="/">Generate</NavLink>
                    <NavLink to="/stories">Compositions</NavLink>
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
            </StoriesProvider>
          </WordIndexBackfillProvider>
        </VocabProvider>
      </KanjiProvider>
    </DictionaryProvider>
  );
}
