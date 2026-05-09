import { createContext, useContext, useEffect, useMemo, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { getKanji, getKnownKanjiExposures } from "../api/client";
import { preloadTokenizer } from "../lib/tokenizer";

interface KanjiContextType {
  knownKanji: Set<string>;
  knownKanjiLoaded: boolean;
  refreshKnownKanji: () => Promise<void>;
  kanjiExposures: Map<string, number>;
  kanjiExposuresLoaded: boolean;
  refreshKanjiExposures: () => Promise<void>;
}

const KanjiContext = createContext<KanjiContextType | null>(null);

export function useKnownKanji() {
  const ctx = useContext(KanjiContext);
  if (!ctx) throw new Error("useKnownKanji must be used within KanjiProvider");
  return ctx;
}

export function KanjiProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [knownKanji, setKnownKanji] = useState<Set<string>>(new Set());
  const [knownKanjiLoaded, setKnownKanjiLoaded] = useState(false);
  const [kanjiExposures, setKanjiExposures] = useState<Map<string, number>>(new Map());
  const [kanjiExposuresLoaded, setKanjiExposuresLoaded] = useState(false);

  const refreshKanjiExposures = useCallback(async () => {
    if (!user) return;
    const map = await getKnownKanjiExposures();
    setKanjiExposures(map);
    setKanjiExposuresLoaded(true);
  }, [user]);

  // Marking a kanji known/unknown changes which kanji contribute to the
  // exposure map (and therefore the header total score and per-story rarity
  // sort), so refresh exposures alongside the known-set whenever this fires.
  const refreshKnownKanji = useCallback(async () => {
    if (!user) return;
    await Promise.all([
      getKanji(user.id).then((all) => {
        setKnownKanji(new Set(all.filter((k) => k.known).map((k) => k.character)));
        setKnownKanjiLoaded(true);
      }),
      refreshKanjiExposures(),
    ]);
  }, [user, refreshKanjiExposures]);

  useEffect(() => {
    refreshKnownKanji();
    preloadTokenizer();
  }, [refreshKnownKanji]);

  const value = useMemo(
    () => ({
      knownKanji,
      knownKanjiLoaded,
      refreshKnownKanji,
      kanjiExposures,
      kanjiExposuresLoaded,
      refreshKanjiExposures,
    }),
    [
      knownKanji,
      knownKanjiLoaded,
      refreshKnownKanji,
      kanjiExposures,
      kanjiExposuresLoaded,
      refreshKanjiExposures,
    ],
  );

  return (
    <KanjiContext.Provider value={value}>
      {children}
    </KanjiContext.Provider>
  );
}
