import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { getKanjiExposures } from "../api/client";
import { preloadTokenizer } from "../lib/tokenizer";

interface KanjiContextType {
  // Kanji the user has encountered in a read story (read_count > 0). Derived
  // from the exposures map — there's no separate "known" concept anymore.
  seenKanji: Set<string>;
  kanjiExposures: Map<string, number>;
  kanjiExposuresLoaded: boolean;
  refreshKanjiExposures: () => Promise<void>;
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
  const [kanjiExposuresLoaded, setKanjiExposuresLoaded] = useState(false);

  const refreshKanjiExposures = useCallback(async () => {
    if (!user) return;
    const map = await getKanjiExposures();
    setKanjiExposures(map);
    setKanjiExposuresLoaded(true);
  }, [user]);

  useEffect(() => {
    refreshKanjiExposures();
    preloadTokenizer();
  }, [refreshKanjiExposures]);

  const seenKanji = useMemo(() => new Set(kanjiExposures.keys()), [kanjiExposures]);

  const value = useMemo(
    () => ({
      seenKanji,
      kanjiExposures,
      kanjiExposuresLoaded,
      refreshKanjiExposures,
    }),
    [seenKanji, kanjiExposures, kanjiExposuresLoaded, refreshKanjiExposures],
  );

  return (
    <KanjiContext.Provider value={value}>
      {children}
    </KanjiContext.Provider>
  );
}
