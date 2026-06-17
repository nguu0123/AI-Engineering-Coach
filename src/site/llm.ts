/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type LocalLlmMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface LocalLlmConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

export function getLocalLlmConfig(): LocalLlmConfig | undefined {
  const provider = (process.env.AIEC_LLM_PROVIDER || '').toLowerCase();
  const ollamaBase = process.env.OLLAMA_BASE_URL;
  const explicitBase = process.env.AIEC_LLM_BASE_URL || process.env.OPENAI_BASE_URL;
  const isOllama = provider === 'ollama' || !!ollamaBase;
  const baseUrl = explicitBase || (isOllama ? `${(ollamaBase || 'http://127.0.0.1:11434').replace(/\/+$/, '')}/v1` : undefined);
  const apiKey = process.env.AIEC_LLM_API_KEY || process.env.OPENAI_API_KEY;

  if (!baseUrl && !apiKey) return undefined;
  const resolvedBaseUrl = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const localhost = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(resolvedBaseUrl);
  if (!apiKey && !localhost) return undefined;

  return {
    baseUrl: resolvedBaseUrl,
    apiKey,
    model: process.env.AIEC_LLM_MODEL || process.env.OPENAI_MODEL || process.env.OLLAMA_MODEL || (isOllama ? 'llama3.1' : 'gpt-4.1-mini'),
    timeoutMs: Number(process.env.AIEC_LLM_TIMEOUT_MS || 90_000),
  };
}

export function localLlmUnavailableMessage(): string {
  return 'Local AI provider is not configured. Set AIEC_LLM_BASE_URL and AIEC_LLM_MODEL for an OpenAI-compatible server, or set OPENAI_API_KEY/OPENAI_MODEL, or set OLLAMA_BASE_URL/OLLAMA_MODEL.';
}

function endpointFor(baseUrl: string): string {
  return baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
}

function normalizeTimeout(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? ms : 90_000;
}

async function postChatCompletion(
  config: LocalLlmConfig,
  messages: LocalLlmMessage[],
  jsonMode: boolean,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), normalizeTimeout(config.timeoutMs));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: 0.2,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  try {
    const response = await fetch(endpointFor(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed: ${response.status}${detail ? ` ${detail.slice(0, 300)}` : ''}`);
    }

    const payload = await response.json() as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? payload.choices?.[0]?.text;
    if (!content) throw new Error('LLM response did not include message content');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function callLocalLlm(messages: LocalLlmMessage[]): Promise<string> {
  const config = getLocalLlmConfig();
  if (!config) throw new Error(localLlmUnavailableMessage());
  return postChatCompletion(config, messages, false);
}

export async function callLocalLlmJson<T>(messages: LocalLlmMessage[]): Promise<T> {
  const config = getLocalLlmConfig();
  if (!config) throw new Error(localLlmUnavailableMessage());

  let text: string;
  try {
    text = await postChatCompletion(config, messages, true);
  } catch (error) {
    if (!(error instanceof Error) || !/response_format|json_object|format|schema|400|422/i.test(error.message)) {
      throw error;
    }
    text = await postChatCompletion(config, messages, false);
  }

  try {
    return JSON.parse(text.trim()) as T;
  } catch {
    return parseLlmJson<T>(text);
  }
}

function parseLlmJson<T>(text: string): T {
  let cleaned = text.trim();
  cleaned = cleaned.replaceAll(/^```(?:json|jsonc|jsonl)?\s*/gm, '').replaceAll(/```\s*$/gm, '').trim();
  cleaned = cleaned.replaceAll(/^\s*\/\/[^\n]*$/gm, '');

  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every(line => line.startsWith('{') && line.endsWith('}'))) {
    try { return JSON.parse(`[${lines.join(',')}]`) as T; } catch { /* fall through */ }
  }

  const arrStart = cleaned.indexOf('[');
  const objStart = cleaned.indexOf('{');
  if (arrStart === -1 && objStart === -1) throw new Error('No JSON structure found in LLM response');

  const start = arrStart === -1 ? objStart : objStart === -1 ? arrStart : Math.min(arrStart, objStart);
  const closeChar = cleaned[start] === '[' ? ']' : '}';
  const end = cleaned.lastIndexOf(closeChar);
  if (end <= start) throw new Error('Malformed JSON structure in LLM response');

  cleaned = cleaned.slice(start, end + 1);
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }

  let fixed = cleaned;
  fixed = fixed.replaceAll(/,\s*([}\]])/g, '$1');
  fixed = fixed.replaceAll(/[\u201C\u201D\u2033]/g, '"').replaceAll(/[\u2018\u2019\u2032]/g, "'");
  fixed = fixed.replaceAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"');
  // eslint-disable-next-line no-control-regex
  fixed = fixed.replaceAll(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  try { return JSON.parse(fixed) as T; } catch { /* fall through */ }

  const balanced = balanceTruncatedJson(fixed).replaceAll(/,(\s*[}\]])/g, '$1');
  return JSON.parse(balanced) as T;
}

function balanceTruncatedJson(input: string): string {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') closers.push('}');
    else if (char === '[') closers.push(']');
    else if (char === '}' || char === ']') closers.pop();
  }

  let result = input;
  if (inString) result += '"';
  for (let i = closers.length - 1; i >= 0; i--) result += closers[i];
  return result;
}
