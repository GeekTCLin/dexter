import { getSetting, setSetting } from '../utils/config.js';
import {
  checkApiKeyExistsForProvider,
  saveApiKeyForProvider,
  SEARCH_PROVIDERS,
  type SearchProviderId,
} from '../utils/env.js';
import { getDefaultModelForProvider, getModelsForProvider } from '../utils/model.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ConfigResponse {
  provider: string;
  modelId: string;
  models: Array<{ id: string; name: string }>;
  searchProvider: SearchProviderId;
  memoryEnabled: boolean;
  hasApiKey: boolean;
}

const DEFAULT_SEARCH_PROVIDER: SearchProviderId = 'bing';

function resolveSearchProvider(value: string | undefined): SearchProviderId {
  // Stored values may be stale/unknown (e.g. the removed 'perplexity'); fall back.
  return value && value in SEARCH_PROVIDERS ? (value as SearchProviderId) : DEFAULT_SEARCH_PROVIDER;
}

function buildConfig(): ConfigResponse {
  const provider = getSetting('provider', DEFAULT_PROVIDER);
  const savedModel = getSetting<string | null>('modelId', null);
  const modelId = savedModel ?? getDefaultModelForProvider(provider) ?? DEFAULT_MODEL;
  const models = getModelsForProvider(provider).map((model) => ({
    id: model.id,
    name: model.displayName,
  }));
  const searchProvider = resolveSearchProvider(
    getSetting<string | undefined>('webSearchPreferredProvider', undefined),
  );
  const memoryEnabled =
    getSetting<{ enabled?: boolean } | undefined>('memory', undefined)?.enabled ?? true;

  return {
    provider,
    modelId,
    models,
    searchProvider,
    memoryEnabled,
    hasApiKey: checkApiKeyExistsForProvider(provider),
  };
}

/**
 * Handle the config endpoints from doc §4/§7. Returns null when the request is
 * not a config route so the caller can continue routing.
 */
export async function handleConfigRoute(
  method: string,
  pathname: string,
  body: unknown,
): Promise<Response | null> {
  if (pathname === '/api/config' && method === 'GET') {
    return json(buildConfig());
  }

  if (method !== 'POST') return null;

  if (pathname === '/api/config/model') {
    const { provider, modelId } = (body ?? {}) as { provider?: unknown; modelId?: unknown };
    if (typeof provider !== 'string' || typeof modelId !== 'string' || !provider || !modelId) {
      return json({ ok: false, error: 'provider and modelId are required' }, 400);
    }
    setSetting('provider', provider);
    setSetting('modelId', modelId);
    return json({ ok: true });
  }

  if (pathname === '/api/config/api-key') {
    const { provider, key } = (body ?? {}) as { provider?: unknown; key?: unknown };
    if (typeof provider !== 'string' || typeof key !== 'string' || !provider || !key) {
      return json({ ok: false, error: 'provider and key are required' }, 400);
    }
    return json({ ok: saveApiKeyForProvider(provider, key) });
  }

  if (pathname === '/api/config/search') {
    const { searchProvider } = (body ?? {}) as { searchProvider?: unknown };
    if (typeof searchProvider !== 'string' || !(searchProvider in SEARCH_PROVIDERS)) {
      return json({ ok: false, error: 'invalid searchProvider' }, 400);
    }
    setSetting('webSearchPreferredProvider', searchProvider as SearchProviderId);
    return json({ ok: true });
  }

  if (pathname === '/api/config/memory') {
    const { enabled } = (body ?? {}) as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      return json({ ok: false, error: 'enabled must be a boolean' }, 400);
    }
    const existing = getSetting<Record<string, unknown>>('memory', {});
    setSetting('memory', { ...existing, enabled });
    return json({ ok: true });
  }

  return null;
}
