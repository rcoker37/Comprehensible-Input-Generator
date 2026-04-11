import { useState } from "react";
import { useAuth } from "../contexts/AuthContext";
import { setOpenRouterApiKey, clearOpenRouterApiKey } from "../api/client";
import "./Settings.css";

export default function Settings() {
  const { user, profile, signOut, refreshProfile } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleSave = async () => {
    if (!user) return;
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setMessage("Error: API key cannot be empty");
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await setOpenRouterApiKey(trimmed);
      setMessage("API key saved!");
      setApiKey("");
      await refreshProfile();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Failed to save"}`);
    }
    setSaving(false);
  };

  const handleClear = async () => {
    if (!user) return;
    setSaving(true);
    setMessage(null);
    try {
      await clearOpenRouterApiKey();
      setMessage("API key cleared.");
      setApiKey("");
      await refreshProfile();
    } catch (err) {
      setMessage(`Error: ${err instanceof Error ? err.message : "Failed to clear"}`);
    }
    setSaving(false);
  };

  return (
    <div className="settings-page">
      <h1>Settings</h1>

      <div className="settings-section">
        <h2>Account</h2>
        <div className="settings-field">
          <label>Email</label>
          <span>{user?.email}</span>
        </div>
        <div className="settings-field">
          <label>Display Name</label>
          <span>{profile?.display_name || "—"}</span>
        </div>
      </div>

      <div className="settings-section">
        <h2>LLM Configuration</h2>
        <div className="settings-field">
          <label>Status</label>
          <span>
            {profile?.has_openrouter_api_key
              ? "API key configured"
              : "No API key configured"}
          </span>
        </div>
        <div className="settings-field">
          <label htmlFor="api-key">
            {profile?.has_openrouter_api_key
              ? "Replace OpenRouter API Key"
              : "OpenRouter API Key"}
          </label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-or-..."
            autoComplete="off"
          />
          <span className="field-hint">
            Get a key at openrouter.ai. Required to generate stories. Keys are
            stored encrypted server-side and never returned to the browser.
          </span>
        </div>
        <button onClick={handleSave} disabled={saving} className="save-btn">
          {saving ? "Saving..." : "Save API Key"}
        </button>
        {profile?.has_openrouter_api_key && (
          <button
            onClick={handleClear}
            disabled={saving}
            className="save-btn"
            style={{ marginLeft: 8 }}
          >
            Clear API Key
          </button>
        )}
        {message && (
          <div className={message.startsWith("Error") ? "error" : "success"}>
            {message}
          </div>
        )}
      </div>

      <div className="settings-section">
        <button onClick={signOut} className="signout-btn">
          Sign Out
        </button>
      </div>
    </div>
  );
}
