import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import {
  initDictionary,
  getDictionaryState,
  getDictionaryError,
  subscribeDictionary,
  lookupWord,
  lookupKanji,
  type DictionaryState,
} from "../lib/dictionary";

interface DictionaryContextType {
  state: DictionaryState;
  error: string | null;
  lookupWord: typeof lookupWord;
  lookupKanji: typeof lookupKanji;
}

const DictionaryContext = createContext<DictionaryContextType | null>(null);

export function useDictionary() {
  const ctx = useContext(DictionaryContext);
  if (!ctx) throw new Error("useDictionary must be used within DictionaryProvider");
  return ctx;
}

export function DictionaryProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [state, setState] = useState<DictionaryState>(() => getDictionaryState());
  const [error, setError] = useState<string | null>(() => getDictionaryError());

  useEffect(() => {
    const unsub = subscribeDictionary((next) => {
      setState(next);
      setError(getDictionaryError());
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!user) return;
    initDictionary().catch(() => {
      // state + error surfaced via subscribeDictionary
    });
  }, [user]);

  return (
    <DictionaryContext.Provider value={{ state, error, lookupWord, lookupKanji }}>
      {children}
    </DictionaryContext.Provider>
  );
}
