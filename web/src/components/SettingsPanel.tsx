import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useStore } from "../store/useStore";
import {
  getConfig,
  updateModel,
  updateApiKey,
  updateSearchProvider,
  updateMemory,
} from "../api/client";
import type { SearchProviderId } from "../types";

/** Mirrors SEARCH_PROVIDERS in src/utils/env.ts. */
const SEARCH_PROVIDER_OPTIONS: Array<{ id: SearchProviderId; name: string }> = [
  { id: "exa", name: "Exa" },
  { id: "perplexity", name: "Perplexity" },
  { id: "tavily", name: "Tavily" },
  { id: "langsearch", name: "LangSearch" },
];


export function SettingsPanel() {
  const config = useStore((s) => s.config);
  const setConfig = useStore((s) => s.setConfig);
  const [loading, setLoading] = useState(!config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  useEffect(() => {
    if (!config) {
      getConfig()
        .then(setConfig)
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    }
  }, [config, setConfig]);

  const handleSaveModel = async (provider: string, modelId: string) => {
    setSaving(true);
    setError(null);
    try {
      await updateModel(provider, modelId);
      if (config) setConfig({ ...config, provider, modelId });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveApiKey = async () => {
    if (!apiKey.trim() || !config) return;
    setSaving(true);
    setError(null);
    try {
      await updateApiKey(config.provider, apiKey);
      if (config) setConfig({ ...config, hasApiKey: true });
      setApiKey("");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveSearch = async (searchProvider: SearchProviderId) => {
    setSaving(true);
    setError(null);
    try {
      await updateSearchProvider(searchProvider);
      if (config) setConfig({ ...config, searchProvider });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveMemory = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await updateMemory(enabled);
      if (config) setConfig({ ...config, memoryEnabled: enabled });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center text-ink-tertiary animate-pulse-soft">
          Loading configuration...
        </div>
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center text-red-600">
          <p className="mb-2">Failed to load configuration.</p>
          <p className="text-sm text-ink-tertiary">{error}</p>
          <Link
            to="/"
            className="inline-block mt-4 text-sm text-accent hover:text-accent-dark"
          >
            Back to chat
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-display-lg font-display text-ink">Settings</h1>
          <p className="text-sm text-ink-tertiary mt-1">
            Configure Dexter's research capabilities
          </p>
        </div>
        <Link
          to="/"
          className="px-3 py-1.5 text-xs font-medium text-accent border border-accent rounded-lg hover:bg-accent hover:text-white transition-colors"
        >
          Back to Chat
        </Link>
      </div>

      {error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {saving && (
        <div className="fixed top-4 right-4 px-3 py-1.5 bg-accent text-white text-xs rounded-lg shadow-lg animate-fade-in z-50">
          Saving...
        </div>
      )}

      <div className="space-y-8">
        {/* Model Provider */}
        <section className="bg-surface-raised border border-surface-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-1">
            LLM Provider & Model
          </h2>
          <p className="text-xs text-ink-tertiary mb-4">
            Select the AI model for research analysis
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-ink-secondary mb-1.5">
                Provider
              </label>
              <div className="text-sm font-mono text-ink px-3 py-2 bg-surface-sunken border border-surface-border rounded-lg">
                {config?.provider ?? "—"}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-secondary mb-1.5">
                Model
              </label>
              <select
                value={config?.modelId ?? ""}
                onChange={(e) => {
                  if (config) handleSaveModel(config.provider, e.target.value);
                }}
                className="w-full text-sm font-mono text-ink px-3 py-2 bg-surface-sunken border border-surface-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {(config?.models ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name || m.id}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        {/* API Key */}
        <section className="bg-surface-raised border border-surface-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-1">API Key</h2>
          <p className="text-xs text-ink-tertiary mb-4">
            {config?.hasApiKey
              ? `API key is set for ${config?.provider}. Enter a new one to replace.`
              : `No API key configured for ${config?.provider}.`}
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  config?.hasApiKey ? "Enter new key..." : "Enter API key..."
                }
                className="w-full text-sm font-mono text-ink px-3 py-2 pr-10 bg-surface-sunken border border-surface-border rounded-lg focus:outline-none focus:ring-1 focus:ring-accent"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveApiKey();
                }}
              />
              <button
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-tertiary hover:text-ink-secondary text-xs"
              >
                {showApiKey ? "Hide" : "Show"}
              </button>
            </div>
            <button
              onClick={handleSaveApiKey}
              disabled={!apiKey.trim()}
              className="px-4 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent-dark transition-colors disabled:opacity-30"
            >
              Save
            </button>
          </div>
        </section>

        {/* Search Provider */}
        <section className="bg-surface-raised border border-surface-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-1">Web Search</h2>
          <p className="text-xs text-ink-tertiary mb-4">
            Preferred search provider for web research
          </p>
          <div className="flex flex-wrap gap-2">
            {SEARCH_PROVIDER_OPTIONS.map(({ id, name }) => (
              <button
                key={id}
                onClick={() => handleSaveSearch(id)}
                className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors ${
                  config?.searchProvider === id
                    ? "bg-accent text-white border-accent"
                    : "bg-surface-sunken text-ink-secondary border-surface-border hover:border-accent"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </section>

        {/* Memory */}
        <section className="bg-surface-raised border border-surface-border rounded-xl p-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-ink mb-1">
                Long-term Memory
              </h2>
              <p className="text-xs text-ink-tertiary">
                Enable persistent memory across conversations
              </p>
            </div>
            <button
              onClick={() =>
                config && handleSaveMemory(!config.memoryEnabled)
              }
              className={`relative w-11 h-6 rounded-full transition-colors ${
                config?.memoryEnabled ? "bg-accent" : "bg-surface-border"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  config?.memoryEnabled ? "translate-x-5" : ""
                }`}
              />
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
