import { useEffect, useMemo, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { GenerationProvider } from "../contexts/GenerationContext";
import { ChatsProvider } from "../contexts/ChatsContext";
import { ChatGenerationProvider } from "../contexts/ChatGenerationContext";
import { KanjiProvider, useSeenKanji } from "../contexts/KanjiContext";
import { VocabProvider, useVocab } from "../contexts/VocabContext";
import { DictionaryProvider, useDictionary } from "../contexts/DictionaryContext";
import { WordIndexBackfillProvider } from "../contexts/WordIndexBackfillContext";
import { StoriesProvider } from "../contexts/StoriesContext";
import { RefinementProvider } from "../contexts/RefinementContext";
import { CHATS_ENABLED } from "../lib/constants";
import { formatScore, totalScore } from "../lib/rarity";
import { totalVocabScore } from "../lib/vocabScore";
import AnimatedDots from "./AnimatedDots";

// Chats are gated behind CHATS_ENABLED. When off, swap the chat providers for a
// passthrough so no chat data is fetched and nothing chat-related mounts; the
// providers (and all chat code) stay in the repo for easy revival.
const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>;
const ChatsWrap = CHATS_ENABLED ? ChatsProvider : Passthrough;
const ChatGenerationWrap = CHATS_ENABLED ? ChatGenerationProvider : Passthrough;

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
  if (!kanjiExposuresLoaded || !vocabEncountersLoaded) return null;
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
  const { user, profile } = useAuth();

  // Mirror the reader font preference onto <html data-font> so every
  // Japanese-rendering surface (chat composer, user bubbles, list titles,
  // popover headword) picks up the sans/serif choice via `var(--jp-font)`
  // without prop-drilling through every page.
  const fontPref = profile?.preferences?.reader?.font ?? "sans";
  useEffect(() => {
    document.documentElement.dataset.font = fontPref;
  }, [fontPref]);

  return (
    <DictionaryProvider>
      <KanjiProvider>
        <VocabProvider>
          <WordIndexBackfillProvider>
            <StoriesProvider>
              <RefinementProvider>
              <ChatsWrap>
                <ChatGenerationWrap>
                  <div className="app">
                    <nav className="nav">
                      <div className="nav-brand">読む練習</div>
                      <div className="nav-links">
                        <NavLink to="/stories">Read</NavLink>
                        {CHATS_ENABLED && <NavLink to="/chats">Chat</NavLink>}
                        <NavLink to="/review">Review</NavLink>
                        <NavLink to="/stats">Stats</NavLink>
                        <NavLink to="/settings">Settings</NavLink>
                      </div>
                      {user && (
                        <span className="nav-user">
                          <DictionaryStatusChip />
                          <NavTotalScore />
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
                </ChatGenerationWrap>
              </ChatsWrap>
              </RefinementProvider>
            </StoriesProvider>
          </WordIndexBackfillProvider>
        </VocabProvider>
      </KanjiProvider>
    </DictionaryProvider>
  );
}
