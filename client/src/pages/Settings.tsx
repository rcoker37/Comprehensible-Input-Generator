import { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { supabase } from "../lib/supabase";
import "./Settings.css";

export default function Settings() {
  const { user, profile, signOut, refreshProfile } = useAuth();
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("deepseek/deepseek-r1");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (profile) {
      setApiKey(profile.openrouter_api_key || "");
      setModel(profile.preferred_model || "deepseek/deepseek-r1");
    }
  }, [profile]);

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    setMessage(null);
    const { error } = await supabase
      .from("profiles")
      .update({
        openrouter_api_key: apiKey || null,
        preferred_model: model,
      })
      .eq("user_id", user.id);

    if (error) {
      setMessage(`Error: ${error.message}`);
    } else {
      setMessage("Settings saved!");
      await refreshProfile();
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
          <label htmlFor="api-key">
            OpenRouter API Key
          </label>
          <input
            id="api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-or-..."
          />
          <span className="field-hint">
            Get a key at openrouter.ai. Required to generate stories.
          </span>
        </div>
        <div className="settings-field">
          <label htmlFor="model">Preferred Model</label>
          <input
            id="model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="deepseek/deepseek-r1"
          />
          <span className="field-hint">
            OpenRouter model ID (e.g., deepseek/deepseek-r1, google/gemma-3-27b-it)
          </span>
        </div>
        <button onClick={handleSave} disabled={saving} className="save-btn">
          {saving ? "Saving..." : "Save Settings"}
        </button>
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
