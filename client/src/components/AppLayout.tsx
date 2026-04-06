import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";

export default function AppLayout() {
  const { user } = useAuth();

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
        {user && <span className="nav-user">{user.email}</span>}
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
