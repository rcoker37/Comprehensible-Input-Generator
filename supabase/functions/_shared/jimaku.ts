// Thin client for the jimaku.cc API (Japanese subtitles for anime / drama /
// VTuber streams). The API key is read from the JIMAKU_API_KEY env var (set it
// alongside the other Edge Function secrets). Auth is a bare API key in the
// Authorization header — no "Bearer " prefix.
//
// Endpoints used:
//   GET /api/entries/search?query=<q>[&anime=true]  → entry list
//   GET /api/entries/<id>/files                      → downloadable subtitle files
//
// Docs: https://jimaku.cc/api/docs

const JIMAKU_BASE = "https://jimaku.cc/api";

export interface JimakuEntry {
  id: number;
  name: string;
  english_name?: string | null;
  japanese_name?: string | null;
  anilist_id?: number | null;
  flags?: Record<string, boolean>;
}

export interface JimakuFile {
  name: string;
  url: string;
  size?: number;
  last_modified?: string;
}

function apiKey(): string {
  const key = Deno.env.get("JIMAKU_API_KEY");
  if (!key) {
    throw new Error(
      "JIMAKU_API_KEY is not configured. Add it to the Edge Function secrets.",
    );
  }
  return key;
}

async function jimakuGet<T>(path: string): Promise<T> {
  const res = await fetch(`${JIMAKU_BASE}${path}`, {
    headers: { Authorization: apiKey() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`jimaku ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export function searchEntries(query: string, anime: boolean): Promise<JimakuEntry[]> {
  const params = new URLSearchParams({ query });
  if (anime) params.set("anime", "true");
  return jimakuGet<JimakuEntry[]>(`/entries/search?${params.toString()}`);
}

export function listFiles(entryId: number): Promise<JimakuFile[]> {
  return jimakuGet<JimakuFile[]>(`/entries/${entryId}/files`);
}

// Files are served from a CDN host that does not require the API key, but we
// send it anyway — harmless and future-proof if that changes.
export async function downloadFile(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Authorization: apiKey() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`jimaku file ${res.status} for ${url}`);
  }
  return await res.text();
}
