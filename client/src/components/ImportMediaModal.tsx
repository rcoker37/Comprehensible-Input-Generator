import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  importMedia,
  listMediaFiles,
  searchMedia,
} from "../api/client";
import { useMedia } from "../contexts/MediaContext";
import type { JimakuEntry, JimakuFile, MediaKind } from "../types";
import AnimatedDots from "./AnimatedDots";
import "./ImportMediaModal.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Step = "search" | "files";

export default function ImportMediaModal({ open, onClose }: Props) {
  const navigate = useNavigate();
  const { annotateEpisodes, refreshSeries } = useMedia();

  const [kind, setKind] = useState<MediaKind>("anime");
  const [query, setQuery] = useState("");
  const [step, setStep] = useState<Step>("search");
  const [searching, setSearching] = useState(false);
  const [entries, setEntries] = useState<JimakuEntry[]>([]);
  const [entry, setEntry] = useState<JimakuEntry | null>(null);
  const [files, setFiles] = useState<JimakuFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setStep("search");
    setQuery("");
    setEntries([]);
    setEntry(null);
    setFiles([]);
    setSelected(new Set());
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setEntries(await searchMedia(query.trim(), kind === "anime"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const pickEntry = async (e: JimakuEntry) => {
    setEntry(e);
    setStep("files");
    setLoadingFiles(true);
    setError(null);
    setFiles([]);
    setSelected(new Set());
    try {
      const fs = await listMediaFiles(e.id);
      setFiles(fs);
      // Default: select every subtitle file.
      setSelected(new Set(fs.map((f) => f.url)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load files");
    } finally {
      setLoadingFiles(false);
    }
  };

  const toggleFile = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleImport = async () => {
    if (!entry) return;
    const chosen = files.filter((f) => selected.has(f.url));
    if (chosen.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      const { seriesId, episodes } = await importMedia({
        entryId: entry.id,
        title: entry.japanese_name || entry.name,
        kind,
        files: chosen.map((f) => ({ url: f.url, name: f.name })),
      });
      annotateEpisodes(episodes.map((e) => e.id));
      refreshSeries();
      close();
      navigate(`/media/series/${seriesId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setImporting(false);
    }
  };

  return (
    <div className="import-modal-backdrop" onClick={close}>
      <div className="import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="import-modal-header">
          <h2>Import subtitles</h2>
          <button className="import-modal-close" onClick={close} aria-label="Close">
            ✕
          </button>
        </div>

        {step === "search" ? (
          <>
            <div className="import-kind-row">
              {(["anime", "vtuber"] as const).map((k) => (
                <button
                  key={k}
                  className={`chip ${kind === k ? "active" : ""}`}
                  onClick={() => setKind(k)}
                >
                  {k === "anime" ? "Anime" : "VTuber"}
                </button>
              ))}
            </div>
            <div className="import-search-row">
              <input
                type="text"
                value={query}
                placeholder="Search jimaku.cc…"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSearch();
                }}
                autoFocus
              />
              <button onClick={handleSearch} disabled={searching || !query.trim()}>
                {searching ? "…" : "Search"}
              </button>
            </div>
            {error && <div className="error">{error}</div>}
            <div className="import-results">
              {entries.map((e) => (
                <button key={e.id} className="import-entry" onClick={() => pickEntry(e)}>
                  <span className="import-entry-name">
                    {e.japanese_name || e.name}
                  </span>
                  {e.english_name && (
                    <span className="import-entry-sub">{e.english_name}</span>
                  )}
                </button>
              ))}
              {!searching && entries.length === 0 && query && (
                <p className="empty">No results.</p>
              )}
            </div>
          </>
        ) : (
          <>
            <button className="import-back" onClick={() => setStep("search")}>
              &larr; Back to results
            </button>
            <p className="import-entry-title">{entry?.japanese_name || entry?.name}</p>
            {error && <div className="error">{error}</div>}
            {loadingFiles ? (
              <div className="loading">Loading files<AnimatedDots /></div>
            ) : (
              <div className="import-files">
                {files.map((f) => (
                  <label key={f.url} className="import-file">
                    <input
                      type="checkbox"
                      checked={selected.has(f.url)}
                      onChange={() => toggleFile(f.url)}
                    />
                    <span>{f.name}</span>
                  </label>
                ))}
                {files.length === 0 && <p className="empty">No subtitle files.</p>}
              </div>
            )}
            <div className="import-actions">
              <button onClick={close} disabled={importing}>
                Cancel
              </button>
              <button
                className="import-confirm"
                onClick={handleImport}
                disabled={importing || selected.size === 0}
              >
                {importing
                  ? "Importing…"
                  : `Import ${selected.size} file${selected.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
