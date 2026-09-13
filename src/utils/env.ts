import { existsSync, readFileSync, writeFileSync } from 'fs';
import { config } from 'dotenv';
import { getProviderById } from '@/providers';

// Load .env on module import
config({ quiet: true });

export function getApiKeyNameForProvider(providerId: string): string | undefined {
  return getProviderById(providerId)?.apiKeyEnvVar;
}

export function getProviderDisplayName(providerId: string): string {
  return getProviderById(providerId)?.displayName ?? providerId;
}

export function checkApiKeyExistsForProvider(providerId: string): boolean {
  const apiKeyName = getApiKeyNameForProvider(providerId);
  if (!apiKeyName) return true;
  return checkApiKeyExists(apiKeyName);
}

export function checkApiKeyExists(apiKeyName: string): boolean {
  const value = process.env[apiKeyName];
  if (value && value.trim() && !value.trim().startsWith('your-')) {
    return true;
  }

  // Also check .env file directly
  if (existsSync('.env')) {
    const envContent = readFileSync('.env', 'utf-8');
    const lines = envContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key.trim() === apiKeyName) {
          const val = valueParts.join('=').trim();
          if (val && !val.startsWith('your-')) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

export function saveApiKeyToEnv(apiKeyName: string, apiKeyValue: string): boolean {
  try {
    let lines: string[] = [];
    let keyUpdated = false;

    if (existsSync('.env')) {
      const existingContent = readFileSync('.env', 'utf-8');
      const existingLines = existingContent.split('\n');

      for (const line of existingLines) {
        const stripped = line.trim();
        if (!stripped || stripped.startsWith('#')) {
          lines.push(line);
        } else if (stripped.includes('=')) {
          const key = stripped.split('=')[0].trim();
          if (key === apiKeyName) {
            lines.push(`${apiKeyName}=${apiKeyValue}`);
            keyUpdated = true;
          } else {
            lines.push(line);
          }
        } else {
          lines.push(line);
        }
      }

      if (!keyUpdated) {
        if (lines.length > 0 && !lines[lines.length - 1].endsWith('\n')) {
          lines.push('');
        }
        lines.push(`${apiKeyName}=${apiKeyValue}`);
      }
    } else {
      lines.push('# LLM API Keys');
      lines.push(`${apiKeyName}=${apiKeyValue}`);
    }

    writeFileSync('.env', lines.join('\n'));

    // Reload environment variables
    config({ override: true, quiet: true });

    return true;
  } catch {
    return false;
  }
}

export function saveApiKeyForProvider(providerId: string, apiKey: string): boolean {
  const apiKeyName = getApiKeyNameForProvider(providerId);
  if (!apiKeyName) return false;
  return saveApiKeyToEnv(apiKeyName, apiKey);
}

export type SearchProviderId = 'bing' | 'baidu' | 'exa' | 'tavily' | 'langsearch';

export const SEARCH_PROVIDERS: Record<
  SearchProviderId,
  { displayName: string; apiKeyEnvVar?: string }
> = {
  bing: { displayName: 'Bing (国内)', apiKeyEnvVar: undefined },
  baidu: { displayName: '百度', apiKeyEnvVar: undefined },
  exa: { displayName: 'Exa', apiKeyEnvVar: 'EXASEARCH_API_KEY' },
  tavily: { displayName: 'Tavily', apiKeyEnvVar: 'TAVILY_API_KEY' },
  langsearch: { displayName: 'LangSearch', apiKeyEnvVar: 'LANGSEARCH_API_KEY' },
};

/** Providers that need no API key and are always usable. */
export const KEYLESS_SEARCH_PROVIDERS: SearchProviderId[] = ['bing', 'baidu'];

export function getSearchProviderDisplayName(providerId: SearchProviderId): string {
  return SEARCH_PROVIDERS[providerId].displayName;
}

export function getApiKeyNameForSearchProvider(providerId: SearchProviderId): string | undefined {
  return SEARCH_PROVIDERS[providerId].apiKeyEnvVar;
}

export function checkApiKeyForSearchProvider(providerId: SearchProviderId): boolean {
  const apiKeyEnvVar = SEARCH_PROVIDERS[providerId].apiKeyEnvVar;
  // Keyless providers are always available.
  if (!apiKeyEnvVar) return true;
  return checkApiKeyExists(apiKeyEnvVar);
}

export function saveApiKeyForSearchProvider(providerId: SearchProviderId, apiKey: string): boolean {
  const apiKeyEnvVar = SEARCH_PROVIDERS[providerId].apiKeyEnvVar;
  // Nothing to persist for keyless providers.
  if (!apiKeyEnvVar) return false;
  return saveApiKeyToEnv(apiKeyEnvVar, apiKey);
}
