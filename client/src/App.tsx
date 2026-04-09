import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import AppLayout from "./components/AppLayout";
import ErrorBoundary from "./components/ErrorBoundary";
import Login from "./pages/Login";
import "./App.css";

const Generator = lazy(() => import("./pages/Generator"));
const Stories = lazy(() => import("./pages/Stories"));
const StoryDetail = lazy(() => import("./pages/StoryDetail"));
const KanjiManager = lazy(() => import("./pages/KanjiManager"));
const Settings = lazy(() => import("./pages/Settings"));

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AppLayout />}>
              <Route
                path="/"
                element={
                  <ErrorBoundary>
                    <Suspense fallback={<div className="loading">Loading...</div>}>
                      <Generator />
                    </Suspense>
                  </ErrorBoundary>
                }
              />
              <Route
                path="/stories"
                element={
                  <ErrorBoundary>
                    <Suspense fallback={<div className="loading">Loading...</div>}>
                      <Stories />
                    </Suspense>
                  </ErrorBoundary>
                }
              />
              <Route
                path="/stories/:id"
                element={
                  <ErrorBoundary>
                    <Suspense fallback={<div className="loading">Loading...</div>}>
                      <StoryDetail />
                    </Suspense>
                  </ErrorBoundary>
                }
              />
              <Route
                path="/kanji"
                element={
                  <ErrorBoundary>
                    <Suspense fallback={<div className="loading">Loading...</div>}>
                      <KanjiManager />
                    </Suspense>
                  </ErrorBoundary>
                }
              />
              <Route
                path="/settings"
                element={
                  <ErrorBoundary>
                    <Suspense fallback={<div className="loading">Loading...</div>}>
                      <Settings />
                    </Suspense>
                  </ErrorBoundary>
                }
              />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
