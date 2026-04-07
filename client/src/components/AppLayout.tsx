import { useState, useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { GenerationProvider } from "../contexts/GenerationContext";

export default function AppLayout() {
  const { user, profile } = useAuth();
  const [usage, setUsage] = useState<{ used: number; limit: number | null } | null>(null);

  useEffect(() => {
    const key = profile?.openrouter_api_key;
    if (!key) {
      setUsage(null);
      return;
    }
    fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { Authorization: `Bearer ${key}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.data) {
          setUsage({ used: data.data.usage, limit: data.data.limit });
        }
      })
      .catch(() => setUsage(null));
  }, [profile?.openrouter_api_key]);

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-brand">読む練習</div>
        <div className="nav-links">
          <NavLink to="/">Generate</NavLink>
          <NavLink to="/stories">Stories</NavLink>
          <NavLink to="/kanji">Kanji</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </div>
        {user && (
          <span className="nav-user">
            {usage && (
              <span className="nav-usage">
                ${usage.used.toFixed(3)} / {usage.limit != null ? `$${usage.limit.toFixed(0)}` : "unlimited"}
              </span>
            )}
            <span>{user.email}</span>
          </span>
        )}
      </nav>
      <main className="main">
        <GenerationProvider>
          <Outlet />
        </GenerationProvider>
      </main>
    </div>
  );
}
