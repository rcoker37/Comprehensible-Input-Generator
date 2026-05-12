import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import AnimatedDots from "./AnimatedDots";

export default function ProtectedRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="loading">Loading<AnimatedDots /></div>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
