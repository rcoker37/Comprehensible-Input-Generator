import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "./AuthContext";
import { getKanji } from "../api/client";
import { preloadTokenizer } from "../lib/tokenizer";

interface KanjiContextType {
  knownKanji: Set<string>;
  knownKanjiLoaded: boolean;
  refreshKnownKanji: () => Promise<void>;
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

  const refreshKnownKanji = useCallback(async () => {
    if (!user) return;
    const all = await getKanji(user.id);
    setKnownKanji(new Set(all.filter((k) => k.known).map((k) => k.character)));
    setKnownKanjiLoaded(true);
  }, [user]);

  useEffect(() => {
    refreshKnownKanji();
    preloadTokenizer();
  }, [refreshKnownKanji]);

  return (
    <KanjiContext.Provider value={{ knownKanji, knownKanjiLoaded, refreshKnownKanji }}>
      {children}
    </KanjiContext.Provider>
  );
}
