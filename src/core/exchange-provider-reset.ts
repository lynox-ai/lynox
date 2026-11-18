import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomicSync } from './atomic-write.js';
import { getLynoxDir, readUserConfig, saveUserConfig } from './config.js';
import { processErrorText } from './error-egress.js';
import { providerListApplies } from './contained-providers.js';
import { poolSuppliesLLMKeys } from './llm/provider-keys.js';
import { isMistralHost } from '../types/index.js';
import type { LynoxUserConfig } from '../types/index.js';

/**
 * Turning the Shopify exchange on for a running instance whose owner picked Mistral.
 *
 * The control plane then stops supplying the Mistral key, and the provider list refuses Mistral
 * anyway (`contained-providers.ts`). Left alone, `config.json` still names the Mistral endpoint:
 * no model call goes out and the page asks a managed customer for an Anthropic key of their own.
 * So the engine puts the pick back on Anthropic at boot, the one place that can write `config.json`
 * (the control plane cannot), and keeps a notice of it for the line the page shows ("lynox switched
 * to Anthropic because …").
 *
 * Only where it helps: the exchange is on, the control plane supplies this instance's keys and an
 * Anthropic key is there to run on. A self-hosted or BYOK instance keeps its pick and its refusal.
 */

/** What the page reads to say why the provider changed. */
export interface ProviderResetNotice {
  /** The provider's display name, as the line names it. */
  readonly from: string;
  /** When the engine changed the pick (ISO). */
  readonly at: string;
}

const NOTICE_FILENAME = 'provider-reset.json';

function noticePath(): string {
  return join(getLynoxDir(), NOTICE_FILENAME);
}

/** The pick the store exchange cannot run: the Mistral preset (`openai` on a Mistral host). */
function picksMistral(config: LynoxUserConfig): boolean {
  return config.provider === 'openai' && isMistralHost(config.api_base_url);
}

/**
 * At boot, before the configuration is loaded: puts a Mistral pick back on Anthropic and records
 * the notice. Returns the notice it wrote, or `null` when nothing changed.
 */
export function resetProviderOffList(now: Date = new Date()): ProviderResetNotice | null {
  // The exchange is off (again): a notice from an earlier boot would say Mistral is unavailable
  // while its tile works, so it goes.
  if (!providerListApplies()) {
    clearProviderResetNotice();
    return null;
  }
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (!poolSuppliesLLMKeys() || anthropicKey === undefined || anthropicKey === '') return null;
  const file = readUserConfig();
  if (!picksMistral(file)) return null;

  // The fields the Mistral preset staged go with it: its endpoint, its model and a key stored for
  // it. On Anthropic the loader fills the key from the control plane's.
  const next: LynoxUserConfig = { ...file, provider: 'anthropic' };
  delete next.api_base_url;
  delete next.openai_model_id;
  // The Mistral tile also staged the retired residency switch; nothing reads it, and Anthropic is not it.
  if (next.llm_mode === 'eu-sovereign') delete next.llm_mode;
  if (next.api_key !== undefined && next.api_key !== anthropicKey) delete next.api_key;
  saveUserConfig(next);

  const notice: ProviderResetNotice = { from: 'Mistral', at: now.toISOString() };
  try {
    writeFileAtomicSync(noticePath(), JSON.stringify(notice) + '\n');
  } catch (err: unknown) {
    // The pick did move; only the line about it is missing.
    process.stderr.write(`[lynox] The provider pick went from Mistral back to Anthropic, but the notice could not be written: ${processErrorText(err)}\n`);
  }
  return notice;
}

/** The notice, while nobody has dismissed it or picked a provider since. Anything else reads as none. */
export function readProviderResetNotice(): ProviderResetNotice | null {
  const path = noticePath();
  if (!existsSync(path)) return null;
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (typeof v !== 'object' || v === null) return null;
    const o = v as Record<string, unknown>;
    if (typeof o['from'] !== 'string' || o['from'] === '' || typeof o['at'] !== 'string') return null;
    return { from: o['from'], at: o['at'] };
  } catch {
    return null;
  }
}

/** Ends the notice: the owner clicked "Got it", or picked a provider themselves. */
export function clearProviderResetNotice(): void {
  rmSync(noticePath(), { force: true });
}
