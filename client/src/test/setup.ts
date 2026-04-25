import { vi } from "vitest";

// supabase.ts builds the client at import time using these env vars; stub
// them so test files that transitively import the client don't throw.
vi.stubEnv("VITE_SUPABASE_URL", "http://localhost:54321");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
