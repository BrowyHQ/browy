// Shared types for BrowserAgent standalone

export type Provider = 'azure' | 'openai' | 'anthropic';

export interface CdpEndpoint {
  brand: string;
  url: string;
}

export interface Config {
  provider: Provider;
  endpoint: string;
  apiKey: string;
  model: string;
  apiVersion: string;
  maxOutputTokens: number;
  reasoningEffort: 'low' | 'medium' | 'high';
  /** Legacy single-CDP endpoint. Kept for back-compat; `cdpEndpoints` is preferred. */
  cdpUrl: string;
  /** All CDP endpoints to try connecting to. Browy connects to every one
   *  that responds and continually monitors the active tab across all of them. */
  cdpEndpoints: CdpEndpoint[];
  uiPort: number;
}

export const DEFAULT_CONFIG: Config = {
  provider: 'azure',
  endpoint: 'https://aipos-llm-sw.openai.azure.com/',
  apiKey: '',
  model: 'claude-sonnet-4.5',
  apiVersion: '2025-04-01-preview',
  maxOutputTokens: 4096,
  reasoningEffort: 'medium',
  cdpUrl: 'http://localhost:9222',
  cdpEndpoints: [
    { brand: 'Brave',  url: 'http://localhost:9222' },
    { brand: 'Edge',   url: 'http://localhost:9223' },
    { brand: 'Chrome', url: 'http://localhost:9224' },
  ],
  uiPort: 7890,
};

export interface ToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export interface FunctionCall {
  type: 'function_call';
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface LLMResponse {
  id: string;
  output: Array<FunctionCall | { type: string; [key: string]: unknown }>;
  output_text?: string;
  status: string;
}

export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

// WebSocket messages between agent ↔ UI
export type WSMessage =
  | { type: 'chat'; text: string }
  | { type: 'clear' }
  | { type: 'stop' }
  | { type: 'launch_browser'; brand: string }
  | { type: 'list_models' }
  | { type: 'set_model'; id: string }
  | { type: 'response'; text: string; toolCalls?: ToolCallRecord[] }
  | { type: 'delta'; text: string }
  | { type: 'tool_step'; id: string; name: string; args?: Record<string, unknown>; status: 'start' | 'end' | 'error'; result?: string; durationMs?: number }
  | { type: 'reasoning'; text: string }
  | { type: 'activity'; event: string; turn?: number; tool?: string; args?: Record<string, unknown>; result?: string; durationMs?: number; inputCount?: number }
  | { type: 'status'; status: 'idle' | 'thinking' | 'tool_calling' | 'error'; detail?: string }
  | { type: 'focused_tab'; url: string; title: string; brand: string; tabCount: number }
  | { type: 'browsers_status'; browsers: BrowserStatus[] }
  | { type: 'active_browsers'; active: ActiveBrowser[] }
  | { type: 'models_list'; models: ModelOption[] }
  | { type: 'current_model'; id: string }
  | { type: 'launch_result'; brand: string; ok: boolean; error?: string }
  | { type: 'copilot_signin' }
  | { type: 'copilot_status'; state: 'ready' | 'unauth' | 'unknown'; detail?: string }
  | { type: 'connected'; tabs: { id: number; title: string; url: string }[] };

export interface BrowserStatus {
  brand: string;
  port: number;
  installed: boolean;
  connected: boolean;     // we have a live CDP attachment
  exe?: string;
}

export interface ActiveBrowser {
  brand: string;
  port: number;
  tabCount: number;
  activeUrl?: string;
  activeTitle?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  vendor?: string;
}
