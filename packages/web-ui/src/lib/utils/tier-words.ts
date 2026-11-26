import { t } from '../i18n.svelte.js';
import { normalizeTier, type ModelTier } from '../contract/vocab.js';
import type { StampEffort, StampThinking } from './workflow-stamp.js';

/**
 * The names a model tier, a thoroughness and a thinking setting carry wherever the app shows them,
 * the ones the settings use (U-477). A stored value (`balanced`, `xhigh`, `adaptive`) is never
 * shown as text; a model a step names by its id is, set apart, since that is the model's name.
 */

const TIERS: readonly ModelTier[] = ['fast', 'balanced', 'deep'];

export function isModelTier(v: string): v is ModelTier {
	return (TIERS as readonly string[]).includes(v);
}

/** A tier's name, or null for anything that is not a tier (a model id), which is shown as it is. An
 *  older alias (`haiku`, `sonnet`, `opus`) runs as its tier (`normalizeTier`), so it is named as that. */
export function tierName(v: string): string | null {
	const tier = normalizeTier(v);
	return tier === undefined ? null : t(`llm.tier.${tier}`);
}

export function effortName(e: StampEffort): string {
	return t(`llm.effort_short.${e}`);
}

export function thinkingName(v: StampThinking): string {
	return t(`llm.thinking_short.${v}`);
}
