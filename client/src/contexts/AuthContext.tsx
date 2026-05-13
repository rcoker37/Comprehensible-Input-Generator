import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import type { Preferences, Profile } from "../types";

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select(
          "user_id, display_name, preferences, created_at, openrouter_api_key_secret_id"
        )
        .eq("user_id", userId)
        .single();
      if (error) throw error;
      if (!data) {
        setProfile(null);
        return;
      }
      const { openrouter_api_key_secret_id, preferences, ...rest } = data as {
        openrouter_api_key_secret_id: string | null;
        preferences: Preferences | null;
      } & Omit<Profile, "has_openrouter_api_key" | "preferences">;
      setProfile({
        ...rest,
        preferences: preferences ?? {},
        has_openrouter_api_key: openrouter_api_key_secret_id != null,
      });
    } catch (err) {
      console.error("Failed to fetch profile:", err);
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    // Prefer a fresh token on mount — defends against JWT signing-key
    // rotation after a deploy invalidating the cached token. Fall back to
    // the cached session when the auth server is unreachable (e.g. /token
    // 502s after a tab has been idle), otherwise the rejected promise
    // would leave `loading` stuck true and ProtectedRoute would render
    // the loading screen indefinitely. A stale cached token may still
    // 401 on the next API call, but that's recoverable; an infinite
    // spinner isn't.
    const resolveSession = async () => {
      try {
        const { data, error } = await supabase.auth.refreshSession();
        if (error) throw error;
        return data.session;
      } catch (err) {
        console.warn("refreshSession failed, using cached session:", err);
        const { data } = await supabase.auth.getSession();
        return data.session;
      }
    };

    resolveSession()
      .then((session) => {
        setSession(session);
        setUser(session?.user ?? null);
        if (session?.user) {
          fetchProfile(session.user.id).finally(() => setLoading(false));
        } else {
          setLoading(false);
        }
      })
      .catch((err) => {
        console.error("Auth init failed:", err);
        setSession(null);
        setUser(null);
        setLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id);
      } else {
        setProfile(null);
      }
    });

    return () => subscription.unsubscribe();
  }, [fetchProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
    });
    if (error) throw error;
  }, []);

  const signOut = useCallback(async () => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  }, []);

  const refreshProfile = useCallback(async () => {
    if (user) await fetchProfile(user.id);
  }, [user, fetchProfile]);

  const value = useMemo(
    () => ({
      session,
      user,
      profile,
      loading,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      refreshProfile,
    }),
    [
      session,
      user,
      profile,
      loading,
      signIn,
      signUp,
      signInWithGoogle,
      signOut,
      refreshProfile,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
