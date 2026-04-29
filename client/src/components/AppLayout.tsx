import { useState, useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { GenerationProvider } from "../contexts/GenerationContext";
import { KanjiProvider } from "../contexts/KanjiContext";
import { DictionaryProvider, useDictionary } from "../contexts/DictionaryContext";
import { getOpenRouterUsage } from "../api/client";

function DictionaryStatusChip() {
  const { state, error } = useDictionary();
  if (state === "ready" || state === "idle") return null;
  const label =
    state === "loading"
      ? "Loading dictionary…"
      : state === "error"
        ? `Dictionary error${error ? `: ${error}` : ""}`
        : "";
  return <span className={`nav-dict-status nav-dict-status--${state}`}>{label}</span>;
}

export default function AppLayout() {
  const { user, profile } = useAuth();
  const [usage, setUsage] = useState<{ used: number; limit: number | null } | null>(null);

  useEffect(() => {
    if (!profile?.has_openrouter_api_key) {
      setUsage(null);
      return;
    }
    const controller = new AbortController();
    getOpenRouterUsage(controller.signal)
      .then((data) => {
        if (data) setUsage({ used: data.usage, limit: data.limit });
      })
      .catch(() => {
        if (!controller.signal.aborted) setUsage(null);
      });
    return () => controller.abort();
  }, [profile?.has_openrouter_api_key]);

  return (
    <DictionaryProvider>
      <div className="app">
        <nav className="nav">
          <div className="nav-brand">読む練習</div>
          <div className="nav-links">
            <NavLink to="/">Generate</NavLink>
            <NavLink to="/stories">Compositions</NavLink>
            <NavLink to="/kanji">Kanji</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </div>
          {user && (
            <span className="nav-user">
              <DictionaryStatusChip />
              {usage && (
                <span className="nav-usage">
                  ${usage.used.toFixed(2)} / {usage.limit != null ? `$${usage.limit.toFixed(0)}` : "unlimited"}
                </span>
              )}
              <span>{user.email}</span>
            </span>
          )}
        </nav>
        <main className="main">
          <KanjiProvider>
            <GenerationProvider>
              <Outlet />
            </GenerationProvider>
          </KanjiProvider>
        </main>
      </div>
    </DictionaryProvider>
  );
}
