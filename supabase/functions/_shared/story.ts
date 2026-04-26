// Auth + story-load helpers shared by word-context edge functions.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { StoredWordThreads } from "./word-thread.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

export interface AuthedRequest {
  authHeader: string;
  userId: string;
}

export async function getUserFromAuthHeader(
  req: Request
): Promise<AuthedRequest | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return { authHeader, userId: user.id };
}

export interface LoadedStory {
  id: number;
  content: string;
  explanations: StoredWordThreads | null;
  user_id: string;
}

export async function loadStoryForUser(
  authHeader: string,
  storyId: number
): Promise<LoadedStory> {
  const supabaseUser = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await supabaseUser
    .from("stories")
    .select("id, content, explanations, user_id")
    .eq("id", storyId)
    .single();
  if (error || !data) throw new Error("Story not found");
  return data as LoadedStory;
}
