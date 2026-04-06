import type {
  Kanji,
  KanjiStats,
  Story,
  GenerateRequest,
} from "../types/index.js";

const API = import.meta.env.VITE_API_URL || "/api";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error || `HTTP ${res.status}`
    );
  }
  return res.json() as Promise<T>;
}

// Kanji
export function getKanji(params?: Record<string, string>): Promise<Kanji[]> {
  const qs = params ? "?" + new URLSearchParams(params).toString() : "";
  return fetchJSON(`${API}/kanji${qs}`);
}

export function getKanjiStats(): Promise<KanjiStats> {
  return fetchJSON(`${API}/kanji/stats`);
}

export function getKanjiCount(params: Record<string, string>): Promise<{ count: number }> {
  const qs = "?" + new URLSearchParams(params).toString();
  return fetchJSON(`${API}/kanji/count${qs}`);
}

export function toggleKanji(character: string): Promise<Kanji> {
  return fetchJSON(`${API}/kanji/${encodeURIComponent(character)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
  });
}

export function bulkUpdateKanji(
  action: "markKnown" | "markUnknown",
  filter: { grades?: number[]; jlptLevels?: number[] }
): Promise<{ updated: number }> {
  return fetchJSON(`${API}/kanji/bulk/update`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, filter }),
  });
}

// Stories
export function generateStory(req: GenerateRequest): Promise<Story> {
  return fetchJSON(`${API}/stories/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

export function getStories(): Promise<Story[]> {
  return fetchJSON(`${API}/stories`);
}

export function getStory(id: number): Promise<Story> {
  return fetchJSON(`${API}/stories/${id}`);
}

export function deleteStory(id: number): Promise<void> {
  return fetchJSON(`${API}/stories/${id}`, { method: "DELETE" });
}
