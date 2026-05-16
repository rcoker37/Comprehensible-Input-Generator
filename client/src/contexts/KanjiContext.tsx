import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { getKanjiExposures } from "../api/client";
import { preloadTokenizer } from "../lib/tokenizer";

interface KanjiContextType {
  // Kanji the user has encountered in a read story (read_count > 0). Derived
  // from the exposures map — there's no separate "known" concept anymore.
  seenKanji: Set<string>;
  kanjiExposures: Map<string, number>;
  // Most recent read time (epoch ms) of any story containing each kanji.
  // Powers the Stats Browse "last read" sort.
  kanjiLastRead: Map<string, number>;
  kanjiExposuresLoaded: boolean;
  // Fetches the latest exposures and resolves to a commit function that writes
  // them into state. Separating fetch from commit lets a caller refresh kanji
  // and vocab in one React batch, so the header score updates once, not twice.
  prepareKanjiRefresh: () => Promise<() => void>;
}

const KanjiContext = createContext<KanjiContextType | null>(null);

export function useSeenKanji() {
  const ctx = useContext(KanjiContext);
  if (!ctx) throw new Error("useSeenKanji must be used within KanjiProvider");
  return ctx;
}

export function KanjiProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [kanjiExposures, setKanjiExposures] = useState<Map<string, number>>(new Map());
  const [kanjiLastRead, setKanjiLastRead] = useState<Map<string, number>>(new Map());
  const [kanjiExposuresLoaded, setKanjiExposuresLoaded] = useState(false);

  const prepareKanjiRefresh = useCallback(async (): Promise<() => void> => {
    if (!user) return () => {};
    const { exposures, lastRead } = await getKanjiExposures();
    return () => {
      setKanjiExposures(exposures);
      setKanjiLastRead(lastRead);
      setKanjiExposuresLoaded(true);
    };
  }, [user]);

  useEffect(() => {
    prepareKanjiRefresh().then((commit) => commit());
    preloadTokenizer();
  }, [prepareKanjiRefresh]);

  const seenKanji = useMemo(() => new Set(kanjiExposures.keys()), [kanjiExposures]);

  const value = useMemo(
    () => ({
      seenKanji,
      kanjiExposures,
      kanjiLastRead,
      kanjiExposuresLoaded,
      prepareKanjiRefresh,
    }),
    [seenKanji, kanjiExposures, kanjiLastRead, kanjiExposuresLoaded, prepareKanjiRefresh],
  );

  return (
    <KanjiContext.Provider value={value}>
      {children}
    </KanjiContext.Provider>
  );
}
