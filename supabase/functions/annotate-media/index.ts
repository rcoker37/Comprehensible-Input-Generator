// Background furigana annotation for a single imported media episode. Mirrors
// generate-story: returns 202 immediately, runs the annotation inside
// EdgeRuntime.waitUntil, flips media_episodes.status to 'complete' / 'failed'.
// The client polls the row and the MediaContext orchestrates one call per
// pending episode.
//
// POST body: { episode_id: number }

import { getUserFromAuthHeader, supabaseAdmin } from "../_shared/story.ts";
import { getApiKey } from "../_shared/openrouter.ts";
import { annotateEpisode } from "../_shared/annotate.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => null);
    const episodeId =
      body && typeof body.episode_id === "number" ? body.episode_id : null;
    if (episodeId == null) return json(400, { error: "Missing episode_id" });

    // Ownership check.
    const { data: ep, error: epErr } = await supabaseAdmin
      .from("media_episodes")
      .select("id, user_id")
      .eq("id", episodeId)
      .maybeSingle();
    if (epErr) return json(500, { error: epErr.message });
    if (!ep || ep.user_id !== auth.userId) return json(404, { error: "Episode not found" });

    const apiKey = await getApiKey(auth.userId).catch(() => null);
    if (!apiKey) {
      return json(400, { error: "Please configure your OpenRouter API key in Settings." });
    }

    EdgeRuntime.waitUntil(annotateEpisode({ episodeId, apiKey }));
    return json(202, { episode_id: episodeId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("annotate-media error:", err);
    return json(500, { error: message });
  }
});
