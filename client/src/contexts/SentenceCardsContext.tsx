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
import { getSentenceCardKeys } from "../api/client";
import {
  sentenceCardKey,
  type SentenceCardSource,
} from "../lib/sentenceCardKey";

/**
 * The set of sentences the user has already mined into the Review SRS,
 * loaded once and kept in sync locally.
 *
 * This exists so the WordPopover can render "✓ In Reviews" *before* the user
 * clicks. Relying on server-side idempotency alone would leave a live "Add to
 * Reviews" button on any sentence mined in an earlier session, or mined via a
 * different word in the same sentence — clicking it would be a silent no-op,
 * and in the window where update_story_content / revise-story have wiped
 * stories.translations but the card survives, it would burn a real paid
 * translation call first.
 *
 * A context rather than a query-per-open: the popover already gates its body
 * on dictionary lookup + usages + encounters + frequency, and another network
 * round-trip on that path would slow every tap. The set holds one short string
 * per card, so it stays small even for a heavy miner.
 */
interface SentenceCardsContextType {
  /** True once the initial fetch has resolved. */
  cardKeysLoaded: boolean;
  /** Is this sentence already a review card? */
  hasCard: (
    source: SentenceCardSource,
    sentenceStart: number,
    sentenceEnd: number
  ) => boolean;
  /** Record a newly-added card so every open reflects it immediately. */
  markAdded: (
    source: SentenceCardSource,
    sentenceStart: number,
    sentenceEnd: number
  ) => void;
  /** Drop a deleted card's key so its sentence becomes mineable again. */
  markRemoved: (key: string) => void;
}

const SentenceCardsContext = createContext<SentenceCardsContextType | null>(
  null
);

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with its provider
export function useSentenceCards() {
  const ctx = useContext(SentenceCardsContext);
  if (!ctx)
    throw new Error(
      "useSentenceCards must be used within SentenceCardsProvider"
    );
  return ctx;
}

export function SentenceCardsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [cardKeysLoaded, setCardKeysLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    getSentenceCardKeys()
      .then((loaded) => {
        if (cancelled) return;
        setKeys(loaded);
        setCardKeysLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Non-fatal: the button just falls back to "addable", and the server
        // stays idempotent, so the worst case is a redundant click.
        console.warn(
          "Failed to load sentence card keys:",
          err instanceof Error ? err.message : err
        );
        setCardKeysLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const hasCard = useCallback(
    (source: SentenceCardSource, start: number, end: number) =>
      keys.has(sentenceCardKey(source, start, end)),
    [keys]
  );

  const markAdded = useCallback(
    (source: SentenceCardSource, start: number, end: number) => {
      const key = sentenceCardKey(source, start, end);
      setKeys((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    []
  );

  const markRemoved = useCallback((key: string) => {
    setKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ cardKeysLoaded, hasCard, markAdded, markRemoved }),
    [cardKeysLoaded, hasCard, markAdded, markRemoved]
  );

  return (
    <SentenceCardsContext.Provider value={value}>
      {children}
    </SentenceCardsContext.Provider>
  );
}
