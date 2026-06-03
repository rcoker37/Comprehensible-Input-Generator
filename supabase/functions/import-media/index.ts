// Media import from jimaku.cc. Three actions on one endpoint:
//
//   { action: 'search', query, anime? }            → JimakuEntry[]
//   { action: 'files', entry_id }                   → JimakuFile[]
//   { action: 'import', entry_id, title, kind,      → { series_id, episodes: [{id, number, title}] }
//                        files: [{url, name, number?}] }
//
// 'import' downloads each selected subtitle file, parses it into plain
// dialogue lines, and creates a media_series (one per jimaku entry per user)
// plus one media_episodes row per file with status='pending'. It does NOT
// annotate — the client calls annotate-media per pending episode afterward.
//
// Requires JIMAKU_API_KEY in the Edge Function secrets and outbound network
// access to jimaku.cc.

import { getUserFromAuthHeader, supabaseAdmin } from "../_shared/story.ts";
import { downloadFile, listFiles, searchEntries } from "../_shared/jimaku.ts";
import { episodeNumberFromName, parseSubtitle } from "../_shared/subtitles.ts";

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

interface ImportFile {
  url: string;
  name: string;
  number?: number | null;
}

async function resolveSeries(args: {
  userId: string;
  jimakuId: string;
  title: string;
  kind: string;
}): Promise<number> {
  const { userId, jimakuId, title, kind } = args;
  // One series per (user, jimaku entry). Reuse if it already exists so
  // re-importing more episodes appends instead of duplicating the show.
  const { data: existing } = await supabaseAdmin
    .from("media_series")
    .select("id")
    .eq("user_id", userId)
    .eq("jimaku_id", jimakuId)
    .maybeSingle();
  if (existing) {
    await supabaseAdmin
      .from("media_series")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", existing.id);
    return existing.id;
  }
  const { data: inserted, error } = await supabaseAdmin
    .from("media_series")
    .insert({ user_id: userId, title, kind, jimaku_id: jimakuId })
    .select("id")
    .single();
  if (error || !inserted) throw new Error(error?.message || "Failed to create series");
  return inserted.id;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = await getUserFromAuthHeader(req);
    if (!auth) return json(401, { error: "Unauthorized" });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return json(400, { error: "Invalid body" });

    const action = body.action;

    if (action === "search") {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) return json(400, { error: "Missing query" });
      const anime = body.anime !== false; // default to anime-only
      const entries = await searchEntries(query, anime);
      return json(200, { entries });
    }

    if (action === "files") {
      const entryId = typeof body.entry_id === "number" ? body.entry_id : null;
      if (entryId == null) return json(400, { error: "Missing entry_id" });
      const files = await listFiles(entryId);
      return json(200, { files });
    }

    if (action === "import") {
      const entryId = body.entry_id;
      const jimakuId = entryId != null ? String(entryId) : null;
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const kind = body.kind === "vtuber" ? "vtuber" : "anime";
      const files = Array.isArray(body.files) ? (body.files as ImportFile[]) : [];
      if (!jimakuId) return json(400, { error: "Missing entry_id" });
      if (!title) return json(400, { error: "Missing title" });
      if (files.length === 0) return json(400, { error: "No files selected" });

      const seriesId = await resolveSeries({
        userId: auth.userId,
        jimakuId,
        title,
        kind,
      });

      const created: Array<{ id: number; number: number | null; title: string }> = [];
      for (const f of files) {
        if (!f?.url || !f?.name) continue;
        let text: string;
        try {
          text = await downloadFile(f.url);
        } catch (err) {
          console.error("import-media: download failed", f.url, err);
          continue;
        }
        const lines = parseSubtitle(f.name, text);
        if (lines.length === 0) continue;
        const number =
          typeof f.number === "number" ? f.number : episodeNumberFromName(f.name);
        const epTitle = number != null ? `Episode ${number}` : f.name.replace(/\.[^.]+$/, "");

        const { data: ep, error: epErr } = await supabaseAdmin
          .from("media_episodes")
          .insert({
            series_id: seriesId,
            user_id: auth.userId,
            number,
            title: epTitle,
            raw_content: lines.join("\n"),
            content: "",
            status: "pending",
          })
          .select("id, number, title")
          .single();
        if (epErr) {
          // 23505 = this (series, number) was already imported; skip quietly.
          if (epErr.code !== "23505") {
            console.error("import-media: episode insert failed", f.name, epErr);
          }
          continue;
        }
        if (ep) created.push({ id: ep.id, number: ep.number, title: ep.title });
      }

      if (created.length === 0) {
        return json(422, { error: "No importable subtitles found in the selected files." });
      }

      created.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
      return json(200, { series_id: seriesId, episodes: created });
    }

    return json(400, { error: "Unknown action" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    console.error("import-media error:", err);
    return json(500, { error: message });
  }
});
