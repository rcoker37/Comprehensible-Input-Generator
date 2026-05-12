import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { GenerationProvider } from "../contexts/GenerationContext";
import { KanjiProvider, useKnownKanji } from "../contexts/KanjiContext";
import { DictionaryProvider, useDictionary } from "../contexts/DictionaryContext";
import { WordIndexBackfillProvider } from "../contexts/WordIndexBackfillContext";
import { formatScore, totalScore } from "../lib/rarity";
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
  if (!kanjiExposuresLoaded) return null;
  return (
    <span className="nav-score" title="Total kanji score from reading">
      ★ {formatScore(totalScore(kanjiExposures))}
    </span>
  );
}

export default function AppLayout() {
  const { user } = useAuth();

  return (
    <DictionaryProvider>
      <KanjiProvider>
        <WordIndexBackfillProvider>
          <div className="app">
            <nav className="nav">
              <div className="nav-brand">読む練習</div>
              <div className="nav-links">
                <NavLink to="/">Generate</NavLink>
                <NavLink to="/stories">Compositions</NavLink>
                <NavLink to="/kanji">Kanji</NavLink>
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
      </KanjiProvider>
    </DictionaryProvider>
  );
}
