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
import {
  loadFrequencyIndex,
  lookupFrequencyByCanonicalSync,
  lookupFrequencySync,
} from "../lib/frequency";

interface VocabContextType {
  vocabEncounters: Map<string, number>;
  // Most recent read time (epoch ms) of any story containing each headword.
  // Powers the Stats Browse "last read" sort.
  vocabLastRead: Map<string, number>;
  // Flips true only once both the encounter RPC and the JPDB frequency
  // index have resolved — scoring depends on rank weighting, so callers
  // that compute totals/deltas should gate on this to avoid a visible
  // jump when JPDB lands.
  vocabEncountersLoaded: boolean;
  getWordRank: (headword: string) => number | null;
  // Fetches the latest encounters (+ frequency index) and resolves to a commit
  // function that writes them into state. Separating fetch from commit lets a
  // caller refresh kanji and vocab in one React batch, so the header score
  // updates once, not twice.
  prepareVocabRefresh: () => Promise<() => void>;
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
  const [vocabLastRead, setVocabLastRead] = useState<Map<string, number>>(
    new Map()
  );
  const [vocabEncountersLoaded, setVocabEncountersLoaded] = useState(false);

  const prepareVocabRefresh = useCallback(async (): Promise<() => void> => {
    if (!user) return () => {};
    const [encounterData] = await Promise.all([
      getUserWordEncounters(),
      loadFrequencyIndex(),
    ]);
    return () => {
      setVocabEncounters(encounterData.encounters);
      setVocabLastRead(encounterData.lastRead);
      setVocabEncountersLoaded(true);
    };
  }, [user]);

  useEffect(() => {
    prepareVocabRefresh().then((commit) => commit());
  }, [prepareVocabRefresh]);

  const getWordRank = useCallback(
    (headword: string): number | null => {
      if (!vocabEncountersLoaded) return null;
      // Prefer the JMdict-entry-resolved rank — encounter stamps are the
      // entry's canonical k[0]/r[0], so this picks up the entry's best
      // variant (e.g. 貴方 → あなた's rank 121, not the rare 貴方 surface
      // rank). Falls back to the surface-keyed lookup for stamps not covered
      // by the by-entry index (entries without a JPDB rank, or stamps that
      // don't correspond to a JMdict entry's canonical surface — rare).
      const byEntry = lookupFrequencyByCanonicalSync(headword);
      if (byEntry) return byEntry.rank;
      return lookupFrequencySync(headword, null).rank;
    },
    [vocabEncountersLoaded]
  );

  const value = useMemo(
    () => ({
      vocabEncounters,
      vocabLastRead,
      vocabEncountersLoaded,
      getWordRank,
      prepareVocabRefresh,
    }),
    [
      vocabEncounters,
      vocabLastRead,
      vocabEncountersLoaded,
      getWordRank,
      prepareVocabRefresh,
    ]
  );

  return <VocabContext.Provider value={value}>{children}</VocabContext.Provider>;
}
