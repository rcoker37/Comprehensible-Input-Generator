import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import Generator from "./pages/Generator";
import Stories from "./pages/Stories";
import StoryDetail from "./pages/StoryDetail";
import KanjiManager from "./pages/KanjiManager";
import "./App.css";

function App() {
  return (
    <BrowserRouter>
      <div className="app">
        <nav className="nav">
          <div className="nav-brand">読む練習</div>
          <div className="nav-links">
            <NavLink to="/">Generate</NavLink>
            <NavLink to="/stories">Stories</NavLink>
            <NavLink to="/kanji">Kanji</NavLink>
          </div>
        </nav>
        <main className="main">
          <Routes>
            <Route path="/" element={<Generator />} />
            <Route path="/stories" element={<Stories />} />
            <Route path="/stories/:id" element={<StoryDetail />} />
            <Route path="/kanji" element={<KanjiManager />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

export default App;
