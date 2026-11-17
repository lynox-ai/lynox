// === Integrations: managed-tier detection ===
//
// Several channel-cards (Anthropic, SearXNG) and Google-OAuth hide
// or reshape themselves on managed instances. Centralised here so the per-
// channel routes in P3-PR-A2 share one fetch + one source of truth.
//
// Foundation for P3-PR-A1. Zero behaviour change.

import { getApiBase } from '../../config.svelte.js';
import {
	isHostedInstance,
	cpSuppliesLLMKey as tierCpSuppliesLLMKey,
} from '../../utils/billing-tier.js';

let managedTier = $state<string | undefined>(undefined);

export function getManagedTier(): string | undefined {
	return managedTier;
}

/** `true` when running on a managed instance (any CP-provisioned tier, BYOK incl.). */
export function isManaged(): boolean {
	return isHostedInstance(managedTier);
}

/**
 * `true` only when the control plane supplies the LLM credential (managed /
 * managed_pro / managed_max / eu-sovereign). The Hosted-BYOK starter tier is `isManaged()`
 * but the CUSTOMER brings their own LLM key, so UI surfaces that gate on
 * "key already provided" must distinguish.
 *
 * Found during a staging audit: LLMSettings was hiding the API-key input
 * for every managed tenant including BYOK, leaving the customer with no UI
 * path to set or rotate their own key.
 *
 * Named `…ForInstance` (not plain `cpSuppliesLLMKey`) so this zero-arg,
 * store-bound convenience never shadows the 1-arg contract predicate it
 * delegates to — the orphan-twin sweep keeps the bare name unique to the
 * contract module.
 */
export function cpSuppliesLLMKeyForInstance(): boolean {
	return tierCpSuppliesLLMKey(managedTier);
}

/** Which way out a notice names (U-302). */
export type WayOut = 'loading' | 'failed' | 'managed' | 'self';

let wayOut = $state<WayOut>('loading');

/**
 * Which way out a notice names. `managed` and `self` come from the engine's own switch (`billing_tier_set`
 * from `GET /api/config`: any tier value, canonical or not), so a notice here and a refusal from
 * the engine name the same way out; not `isManaged()`, which only counts a tier that normalizes.
 * `loading` until the answer is in (the notice states the fact alone), `failed` after a read that
 * did not give one (the notice says to reload): naming no way out, or a neutral one, beats naming
 * the wrong one.
 */
export function managedWayOut(): WayOut {
	return wayOut;
}

/** Tests only: back to the state before the first read. */
export function _resetManagedStatus(): void {
	managedTier = undefined;
	wayOut = 'loading';
}

export async function loadManagedStatus(): Promise<void> {
	try {
		const res = await fetch(`${getApiBase()}/config`);
		if (!res.ok) {
			if (wayOut === 'loading') wayOut = 'failed';
			return;
		}
		const data = (await res.json()) as Record<string, unknown>;
		if (typeof data['managed'] === 'string') managedTier = data['managed'];
		if (typeof data['billing_tier_set'] === 'boolean') wayOut = data['billing_tier_set'] ? 'managed' : 'self';
		else if (wayOut === 'loading') wayOut = 'failed';
	} catch {
		// Keep an answer an earlier read gave; without one, the notices say to reload.
		if (wayOut === 'loading') wayOut = 'failed';
	}
}
