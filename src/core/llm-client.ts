/**
 * Centralized LLM client factory.
 *
 * Supports four providers:
 *   - anthropic (default): direct Anthropic API
 *   - vertex: Google Cloud Vertex AI (Claude via @anthropic-ai/vertex-sdk)
 *   - custom: LiteLLM or other Anthropic-compatible proxy
 *   - openai: OpenAI-compatible APIs (Mistral, Gemini, etc.)
 *
 * For vertex, call `initLLMProvider()` once at startup (async)
 * before calling `createLLMClient()` (sync).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../types/index.js';
import { OpenAIAdapter } from './openai-adapter.js';

// Cached dynamic module reference — loaded once via initLLMProvider()
type VertexCtor = new (opts: { projectId?: string | undefined; region?: string | undefined; accessToken?: string | undefined }) => Anthropic;

let _vertexCtor: VertexCtor | null = null;
let _activeProvider: LLMProvider = 'anthropic';

/**
 * Load the provider SDK module. Must be called before `createLLMClient()`
 * when using vertex. Safe to call multiple times.
 */
export async function initLLMProvider(provider: LLMProvider): Promise<void> {
  _activeProvider = provider;
  // 'anthropic', 'custom', and 'openai' need no dynamic import
  if (provider === 'vertex' && !_vertexCtor) {
    try {
      const mod = await import('@anthropic-ai/vertex-sdk');
      _vertexCtor = (mod.default ?? mod.AnthropicVertex) as unknown as VertexCtor;
    } catch {
      throw new Error(
        'Vertex provider requires @anthropic-ai/vertex-sdk. Install it with:\n' +
        '  pnpm add @anthropic-ai/vertex-sdk\n' +
        'Then configure GCP credentials (GOOGLE_APPLICATION_CREDENTIALS env var or gcloud auth).',
      );
    }
  }
}

export interface LLMClientOptions {
  provider?: LLMProvider | undefined;
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  /** GCP project ID for Vertex AI. */
  gcpProjectId?: string | undefined;
  /** GCP region for Vertex AI (e.g. 'europe-west4', 'us-east5'). */
  gcpRegion?: string | undefined;
  /** Model ID for OpenAI-compatible providers (e.g. 'mistral-large-latest'). */
  openaiModelId?: string | undefined;
}

/**
 * Create an Anthropic-compatible client for the configured provider.
 * Returns the base Anthropic type — Vertex SDK extends it.
 * For 'openai' provider, returns an OpenAIAdapter cast to Anthropic
 * (Agent only uses client.beta.messages.stream() which the adapter implements).
 */
export function createLLMClient(opts: LLMClientOptions = {}): Anthropic {
  const provider = opts.provider ?? _activeProvider;

  if (provider === 'openai') {
    if (!opts.apiBaseURL || !opts.apiKey || !opts.openaiModelId) {
      throw new Error('OpenAI provider requires apiBaseURL, apiKey, and openaiModelId.');
    }
    return new OpenAIAdapter({
      baseURL: opts.apiBaseURL,
      apiKey: opts.apiKey,
      modelId: opts.openaiModelId,
    }) as unknown as Anthropic;
  }

  if (provider === 'vertex') {
    if (!_vertexCtor) {
      throw new Error('Vertex provider not initialized. Call initLLMProvider("vertex") first.');
    }
    return new _vertexCtor({
      projectId: opts.gcpProjectId,
      region: opts.gcpRegion,
    });
  }

  // Standard Anthropic API
  if (opts.apiKey) {
    return new Anthropic({ apiKey: opts.apiKey, baseURL: opts.apiBaseURL });
  }
  if (opts.apiBaseURL) {
    return new Anthropic({ baseURL: opts.apiBaseURL });
  }
  return new Anthropic();
}

/** Get the currently active provider (set by initLLMProvider). */
export function getActiveProvider(): LLMProvider {
  return _activeProvider;
}

/** Whether the active provider is a custom (non-Anthropic) proxy or OpenAI-compatible. */
export function isCustomProvider(): boolean {
  return _activeProvider === 'custom' || _activeProvider === 'openai';
}
