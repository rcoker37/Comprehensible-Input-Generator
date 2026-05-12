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
import { loadFrequencyIndex, lookupFrequencySync } from "../lib/frequency";

interface VocabContextType {
  vocabEncounters: Map<string, number>;
  // Flips true only once both the encounter RPC and the JPDB frequency
  // index have resolved — scoring depends on rank weighting, so callers
  // that compute totals/deltas should gate on this to avoid a visible
  // jump when JPDB lands.
  vocabEncountersLoaded: boolean;
  getWordRank: (headword: string) => number | null;
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
    const [counts] = await Promise.all([
      getUserWordEncounters(),
      loadFrequencyIndex(),
    ]);
    setVocabEncounters(counts);
    setVocabEncountersLoaded(true);
  }, [user]);

  useEffect(() => {
    refreshVocabEncounters();
  }, [refreshVocabEncounters]);

  const getWordRank = useCallback(
    (headword: string): number | null => {
      if (!vocabEncountersLoaded) return null;
      return lookupFrequencySync(headword, null).rank;
    },
    [vocabEncountersLoaded]
  );

  const value = useMemo(
    () => ({
      vocabEncounters,
      vocabEncountersLoaded,
      getWordRank,
      refreshVocabEncounters,
    }),
    [vocabEncounters, vocabEncountersLoaded, getWordRank, refreshVocabEncounters]
  );

  return <VocabContext.Provider value={value}>{children}</VocabContext.Provider>;
}
