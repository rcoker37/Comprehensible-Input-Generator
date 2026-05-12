import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { getUserWordEncounters } from "../api/client";

interface VocabContextType {
  vocabEncounters: Map<string, number>;
  vocabEncountersLoaded: boolean;
  refreshVocabEncounters: () => Promise<void>;
}

const VocabContext = createContext<VocabContextType | null>(null);

export function useVocab() {
  const ctx = useContext(VocabContext);
  if (!ctx) throw new Error("useVocab must be used within VocabProvider");
  return ctx;
}

export function VocabProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [vocabEncounters, setVocabEncounters] = useState<Map<string, number>>(
    new Map()
  );
  const [vocabEncountersLoaded, setVocabEncountersLoaded] = useState(false);

  const refreshVocabEncounters = useCallback(async () => {
    if (!user) return;
    const counts = await getUserWordEncounters();
    setVocabEncounters(counts);
    setVocabEncountersLoaded(true);
  }, [user]);

  useEffect(() => {
    refreshVocabEncounters();
  }, [refreshVocabEncounters]);

  const value = useMemo(
    () => ({ vocabEncounters, vocabEncountersLoaded, refreshVocabEncounters }),
    [vocabEncounters, vocabEncountersLoaded, refreshVocabEncounters]
  );

  return <VocabContext.Provider value={value}>{children}</VocabContext.Provider>;
}
