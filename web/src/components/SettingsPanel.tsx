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
  { id: "bing", name: "Bing（国内）" },
  { id: "baidu", name: "百度" },
  { id: "exa", name: "Exa" },
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
          正在加载配置…
        </div>
      </div>
    );
  }

  if (error && !config) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="text-center text-red-600">
          <p className="mb-2">加载配置失败。</p>
          <p className="text-sm text-ink-tertiary">{error}</p>
          <Link
            to="/"
            className="inline-block mt-4 text-sm text-accent hover:text-accent-dark"
          >
            返回对话
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
          <h1 className="text-display-lg font-display text-ink">设置</h1>
          <p className="text-sm text-ink-tertiary mt-1">
            配置 Dexter 的研究能力
          </p>
        </div>
        <Link
          to="/"
          className="px-3 py-1.5 text-xs font-medium text-accent border border-accent rounded-lg hover:bg-accent hover:text-white transition-colors"
        >
          返回对话
        </Link>
      </div>

      {error && (
        <div className="mb-6 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {saving && (
        <div className="fixed top-4 right-4 px-3 py-1.5 bg-accent text-white text-xs rounded-lg shadow-lg animate-fade-in z-50">
          保存中…
        </div>
      )}

      <div className="space-y-8">
        {/* Model Provider */}
        <section className="bg-surface-raised border border-surface-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-1">
            LLM 服务商与模型
          </h2>
          <p className="text-xs text-ink-tertiary mb-4">
            选择用于研究分析的 AI 模型
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-ink-secondary mb-1.5">
                服务商
              </label>
              <div className="text-sm font-mono text-ink px-3 py-2 bg-surface-sunken border border-surface-border rounded-lg">
                {config?.provider ?? "—"}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-secondary mb-1.5">
                模型
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
          <h2 className="text-sm font-semibold text-ink mb-1">API 密钥</h2>
          <p className="text-xs text-ink-tertiary mb-4">
            {config?.hasApiKey
              ? `已为 ${config?.provider} 设置 API 密钥。输入新密钥可替换。`
              : `尚未为 ${config?.provider} 配置 API 密钥。`}
          </p>
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <input
                type={showApiKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  config?.hasApiKey ? "输入新密钥…" : "输入 API 密钥…"
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
                {showApiKey ? "隐藏" : "显示"}
              </button>
            </div>
            <button
              onClick={handleSaveApiKey}
              disabled={!apiKey.trim()}
              className="px-4 py-2 text-xs font-medium bg-accent text-white rounded-lg hover:bg-accent-dark transition-colors disabled:opacity-30"
            >
              保存
            </button>
          </div>
        </section>

        {/* Search Provider */}
        <section className="bg-surface-raised border border-surface-border rounded-xl p-5">
          <h2 className="text-sm font-semibold text-ink mb-1">网络搜索</h2>
          <p className="text-xs text-ink-tertiary mb-4">
            选择网络研究的搜索引擎
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
                长期记忆
              </h2>
              <p className="text-xs text-ink-tertiary">
                开启后可在跨会话中保留记忆
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
