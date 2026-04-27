import type { Config, LLMResponse, ToolDef, FunctionCall } from '../types.js';
import { execSync } from 'child_process';

let cachedAzureToken = '';
let tokenExpiresAt = 0;

function getAzureToken(): string {
  if (cachedAzureToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedAzureToken;
  }
  try {
    const raw = execSync(
      'az account get-access-token --resource https://cognitiveservices.azure.com',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const parsed = JSON.parse(raw);
    cachedAzureToken = parsed.accessToken;
    tokenExpiresAt = new Date(parsed.expiresOn).getTime();
    return cachedAzureToken;
  } catch {
    throw new Error('Failed to get Azure token. Run: az login');
  }
}

export async function callLLM(
  config: Config,
  input: unknown[],
  tools: ToolDef[],
): Promise<LLMResponse> {
  const { url, headers } = buildRequest(config);

  const body: Record<string, unknown> = {
    model: config.model,
    input,
    max_output_tokens: config.maxOutputTokens,
  };
  if (tools.length > 0) body.tools = tools;
  if (config.reasoningEffort !== 'medium') {
    body.reasoning = { effort: config.reasoningEffort };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  if (!res.ok) {
    const err = await res.text().catch(() => res.statusText);
    throw new Error(`LLM ${res.status}: ${err.slice(0, 300)}`);
  }

  return (await res.json()) as LLMResponse;
}

function buildRequest(config: Config): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  switch (config.provider) {
    case 'azure': {
      const ep = config.endpoint.replace(/\/+$/, '');
      const token = config.apiKey || getAzureToken();
      // If it looks like a JWT, use Bearer; otherwise api-key
      if (token.startsWith('eyJ')) {
        headers['Authorization'] = `Bearer ${token}`;
      } else {
        headers['api-key'] = token;
      }
      return { url: `${ep}/openai/responses?api-version=${config.apiVersion}`, headers };
    }
    case 'openai':
      headers['Authorization'] = `Bearer ${config.apiKey}`;
      return { url: 'https://api.openai.com/v1/responses', headers };

    case 'anthropic':
      headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      return { url: 'https://api.anthropic.com/v1/messages', headers };

    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

export function extractFunctionCalls(response: LLMResponse): FunctionCall[] {
  return response.output.filter(
    (item): item is FunctionCall => item.type === 'function_call',
  );
}

export function extractText(response: LLMResponse): string {
  if (response.output_text) return response.output_text;
  for (const item of response.output) {
    if (item.type === 'message') {
      const msg = item as { content?: { type: string; text?: string }[] };
      if (Array.isArray(msg.content)) {
        return msg.content
          .filter((c) => c.type === 'output_text' && c.text)
          .map((c) => c.text!)
          .join('');
      }
    }
  }
  return '';
}
