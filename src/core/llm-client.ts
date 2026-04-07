/**
 * Centralized LLM client factory.
 *
 * Supports three providers:
 *   - anthropic (default): direct Anthropic API
 *   - bedrock: AWS Bedrock (requires @anthropic-ai/bedrock-sdk)
 *   - custom: LiteLLM or other Anthropic-compatible proxy
 *
 * For bedrock, call `initLLMProvider()` once at startup (async)
 * before calling `createLLMClient()` (sync).
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../types/index.js';

// Cached dynamic module reference — loaded once via initLLMProvider()
type BedrockCtor = new (opts: { awsRegion?: string | undefined; awsAccessKey?: string | undefined; awsSecretKey?: string | undefined; awsSessionToken?: string | undefined }) => Anthropic;

let _bedrockCtor: BedrockCtor | null = null;
let _activeProvider: LLMProvider = 'anthropic';
let _bedrockEuOnly = false;

/**
 * Load the provider SDK module. Must be called before `createLLMClient()`
 * when using bedrock. Safe to call multiple times.
 */
export async function initLLMProvider(provider: LLMProvider): Promise<void> {
  _activeProvider = provider;
  // 'anthropic' and 'custom' use the standard SDK — no dynamic import needed
  if (provider === 'bedrock' && !_bedrockCtor) {
    try {
      const mod = await import('@anthropic-ai/bedrock-sdk');
      _bedrockCtor = (mod.default ?? mod.AnthropicBedrock) as BedrockCtor;
    } catch {
      throw new Error(
        'Bedrock provider requires @anthropic-ai/bedrock-sdk. Install it with:\n' +
        '  pnpm add @anthropic-ai/bedrock-sdk\n' +
        'Then configure AWS credentials (env vars or ~/.aws/credentials).',
      );
    }
  }
}

export interface LLMClientOptions {
  provider?: LLMProvider | undefined;
  apiKey?: string | undefined;
  apiBaseURL?: string | undefined;
  awsRegion?: string | undefined;
  awsAccessKey?: string | undefined;
  awsSecretKey?: string | undefined;
  awsSessionToken?: string | undefined;
}

/**
 * Create an Anthropic-compatible client for the configured provider.
 * Returns the base Anthropic type — bedrock SDK extends it.
 */
export function createLLMClient(opts: LLMClientOptions = {}): Anthropic {
  const provider = opts.provider ?? _activeProvider;

  if (provider === 'bedrock') {
    if (!_bedrockCtor) {
      throw new Error('Bedrock provider not initialized. Call initLLMProvider("bedrock") first.');
    }
    return new _bedrockCtor({
      awsRegion: opts.awsRegion,
      awsAccessKey: opts.awsAccessKey,
      awsSecretKey: opts.awsSecretKey,
      awsSessionToken: opts.awsSessionToken,
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

/** Whether the active provider is a custom (non-Anthropic) proxy. */
export function isCustomProvider(): boolean {
  return _activeProvider === 'custom';
}

/** Whether Bedrock EU cross-region inference is active. */
export function isBedrockEuOnly(): boolean {
  return _bedrockEuOnly;
}

/** Set the Bedrock EU-only flag. Called from Engine.init(). */
export function setBedrockEuOnly(eu: boolean): void {
  _bedrockEuOnly = eu;
}
