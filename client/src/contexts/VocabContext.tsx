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
import type { VocabEncounter } from "../lib/vocabScore";

interface VocabContextType {
  vocabEncounters: Map<string, VocabEncounter>;
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
  const [vocabEncounters, setVocabEncounters] = useState<
    Map<string, VocabEncounter>
  >(new Map());
  const [vocabEncountersLoaded, setVocabEncountersLoaded] = useState(false);

  const refreshVocabEncounters = useCallback(async () => {
    if (!user) return;
    // The JPDB index needs to be loaded before we can resolve tiers
    // synchronously. The fetch is shared with the popover's frequency
    // badges so this usually warm-hits the in-memory cache.
    const [counts] = await Promise.all([getUserWordEncounters(), loadFrequencyIndex()]);
    const map = new Map<string, VocabEncounter>();
    for (const [headword, encounters] of counts) {
      const { tier } = lookupFrequencySync(headword, null);
      map.set(headword, { encounters, tier });
    }
    setVocabEncounters(map);
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
