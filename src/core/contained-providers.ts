import type Anthropic from '@anthropic-ai/sdk';
import { FixedTextError } from './error-egress.js';
import { poolSuppliesLLMKeys } from './llm/provider-keys.js';
import { FIREWORKS_API_BASE } from './tier-presets.js';
import { getProviderDescriptor, isMistralHost } from '../types/models.js';
import type { ModelProfile } from '../contract/shapes.js';
import { shopifyExchangeSwitchOn } from '../tools/builtin/http.js';

/**
 * The providers an instance set up for a Shopify store may send text to
 * (PRD-SHOPIFY-CONTAINMENT-ERASURE §E7 "Providers").
 *
 * The PRD binds the list to a contained container. It is built per instance instead: while the
 * Shopify exchange switch (`shopifyExchangeSwitchOn`) is on, every model, speech-to-text and speech request of the
 * instance is held to it, contained or not. That refuses more than the PRD, never less: the
 * container of a request is not known where the request leaves (no ambient thread or run), and a
 * thread id the client sends or leaves out would decide the answer.
 *
 * On the list: Anthropic's own API and Fireworks' canonical endpoint, each with the key the
 * control plane supplies. Refused: Mistral (its zero-retention agreement is not in place),
 * Vertex (not cleared by legal), any other base URL, and a key the user brought (BYOK).
 */

/** Why a provider is not on the list. */
export type RefusedProviderClass = 'mistral' | 'vertex' | 'custom_base' | 'byok';

/** Whether the list applies to this instance: the Shopify exchange switch, read at each call. */
export function providerListApplies(): boolean {
  return shopifyExchangeSwitchOn();
}

const ANTHROPIC_API = 'https://api.anthropic.com';

function sameEndpoint(a: string, b: string): boolean {
  return a.trim().replace(/\/+$/, '') === b;
}

/** A key is the pool's when the control plane supplies this instance's keys and it is that key. */
function isPoolKey(key: string | null | undefined, envName: 'ANTHROPIC_API_KEY' | 'FIREWORKS_API_KEY'): boolean {
  if (!poolSuppliesLLMKeys()) return false;
  if (key === undefined || key === null || key === '') return true;
  return key === process.env[envName];
}

/** What a client sends to: its wire, the base URL it will use and the key it carries. */
export interface ProviderTarget {
  readonly wire: 'anthropic' | 'vertex' | 'openai';
  /** The registry provider the client was asked for (`custom` is a proxy on the Anthropic wire). */
  readonly provider: string;
  /** The base URL the client really uses: for the Anthropic SDK, its own `baseURL` after defaults. */
  readonly baseURL: string | undefined;
  readonly apiKey: string | null | undefined;
  /** The Anthropic SDK's bearer token (`ANTHROPIC_AUTH_TOKEN`): never the pool's credential. */
  readonly authToken?: string | null | undefined;
  readonly googleVertexAuth?: boolean | undefined;
}

/** Why the target is not on the list, or `null` when it is. */
export function refusedProviderClass(target: ProviderTarget): RefusedProviderClass | null {
  if (target.wire === 'vertex' || target.provider === 'vertex' || target.googleVertexAuth === true) return 'vertex';
  const base = target.baseURL ?? '';
  if (isMistralHost(base)) return 'mistral';
  if (target.wire === 'anthropic') {
    if (target.provider !== 'anthropic') return 'custom_base';
    if (base !== '' && !sameEndpoint(base, ANTHROPIC_API)) return 'custom_base';
    if (target.authToken !== undefined && target.authToken !== null && target.authToken !== '') return 'byok';
    return isPoolKey(target.apiKey, 'ANTHROPIC_API_KEY') ? null : 'byok';
  }
  if (!sameEndpoint(base, FIREWORKS_API_BASE)) return 'custom_base';
  return isPoolKey(target.apiKey, 'FIREWORKS_API_KEY') ? null : 'byok';
}

/**
 * {@link refusedProviderClass} for a tier snapshot before its client exists: the wire from the
 * provider registry, and on the Anthropic wire the base URL the SDK would fall back to
 * (`ANTHROPIC_BASE_URL`) when the snapshot names none.
 */
export function refusedSnapshotClass(snap: { provider: string; apiBaseURL?: string | undefined; apiKey?: string | undefined }): RefusedProviderClass | null {
  const wire = getProviderDescriptor(snap.provider)?.wireClient ?? 'anthropic';
  const baseURL = wire === 'anthropic'
    ? (snap.apiBaseURL !== undefined && snap.apiBaseURL !== '' ? snap.apiBaseURL : process.env['ANTHROPIC_BASE_URL'])
    : snap.apiBaseURL;
  // A registry `mistral` slot runs as provider `openai` (`clientForTierSnapshot`).
  return refusedProviderClass({ wire, provider: snap.provider === 'mistral' ? 'openai' : snap.provider, baseURL, apiKey: snap.apiKey });
}

/** {@link refusedProviderClass} for a named model profile (always the OpenAI wire). */
export function refusedProfileClass(profile: Pick<ModelProfile, 'provider' | 'api_base_url' | 'api_key' | 'auth'>): RefusedProviderClass | null {
  return refusedProviderClass({
    wire: 'openai', provider: profile.provider, baseURL: profile.api_base_url, apiKey: profile.api_key,
    googleVertexAuth: profile.auth === 'google-vertex',
  });
}

export const PROVIDER_NOT_ON_LIST_REFUSAL =
  'Nothing was sent: on an instance connected to a Shopify store, lynox sends text only to Anthropic or Fireworks, '
  + 'and the model chosen for this runs elsewhere. Choose an Anthropic or Fireworks model in the settings.';

export const BATCH_REFUSAL =
  'Nothing was sent: on an instance connected to a Shopify store, lynox does not use the batch API.';

function refuse(): never {
  throw new FixedTextError(PROVIDER_NOT_ON_LIST_REFUSAL, PROVIDER_NOT_ON_LIST_REFUSAL);
}

/**
 * A client that sends nothing: every request method throws the refusal. Built in place of a
 * client whose provider is not on the list, so that a caller that holds it — the engine at boot,
 * a helper — fails at its first request instead of the boot failing.
 */
export function refusingClient(): Anthropic {
  const messages = { create: refuse, stream: refuse, countTokens: refuse, batches: { create: refuse } };
  return { messages, beta: { messages } } as unknown as Anthropic;
}
