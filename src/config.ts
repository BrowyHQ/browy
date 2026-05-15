import type { Config, CdpEndpoint } from './types.js';
import { loadPrefs } from './agent/prefs.js';

function parseEndpoints(env: string | undefined, fallback: CdpEndpoint[]): CdpEndpoint[] {
  if (!env) return fallback;
  // Format: "Brand=url,Brand=url"  e.g. "Brave=http://localhost:9222,Edge=http://localhost:9223"
  const out: CdpEndpoint[] = [];
  for (const item of env.split(',')) {
    const [brand, url] = item.split('=').map(s => s.trim());
    if (brand && url) out.push({ brand, url });
  }
  return out.length ? out : fallback;
}

// Load config from environment variables + defaults
export function loadConfig(): Config {
  const defaults = {
    provider: 'azure' as const,
    endpoint: 'https://aipos-llm-sw.openai.azure.com/',
    apiKey: '',
    model: 'claude-sonnet-4.5',
    apiVersion: '2025-04-01-preview',
    maxOutputTokens: 4096,
    reasoningEffort: 'medium' as const,
    cdpUrl: 'http://localhost:9222',
    cdpEndpoints: [
      { brand: 'Brave',  url: 'http://localhost:9222' },
      { brand: 'Edge',   url: 'http://localhost:9223' },
      { brand: 'Chrome', url: 'http://localhost:9224' },
    ] as CdpEndpoint[],
    uiPort: 7890,
  };

  const prefs = loadPrefs();
  const cdpUrl = process.env.BA_CDP_URL || defaults.cdpUrl;
  const endpoints = parseEndpoints(process.env.BA_CDP_ENDPOINTS, defaults.cdpEndpoints);
  // Make sure the legacy single-url is in the endpoint list so behaviour is
  // preserved for users who set only BA_CDP_URL.
  if (!endpoints.some(e => e.url === cdpUrl)) {
    endpoints.unshift({ brand: 'Browser', url: cdpUrl });
  }

  return {
    provider: (process.env.BA_PROVIDER as Config['provider']) || defaults.provider,
    endpoint: process.env.BA_ENDPOINT || defaults.endpoint,
    apiKey: process.env.BA_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || defaults.apiKey,
    // Precedence: env > saved pref (last user choice) > bundled default.
    model: process.env.BA_MODEL || prefs.model || defaults.model,
    apiVersion: process.env.BA_API_VERSION || defaults.apiVersion,
    maxOutputTokens: parseInt(process.env.BA_MAX_TOKENS || '', 10) || defaults.maxOutputTokens,
    reasoningEffort: (process.env.BA_REASONING as Config['reasoningEffort']) || defaults.reasoningEffort,
    cdpUrl,
    cdpEndpoints: endpoints,
    uiPort: parseInt(process.env.BA_UI_PORT || '', 10) || defaults.uiPort,
  };
}
