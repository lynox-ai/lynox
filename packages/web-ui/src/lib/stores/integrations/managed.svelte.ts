// === Integrations: managed-tier detection ===
//
// Several channel-cards (Anthropic, SearXNG) and Google-OAuth hide
// or reshape themselves on managed instances. Centralised here so the per-
// channel routes in P3-PR-A2 share one fetch + one source of truth.
//
// Foundation for P3-PR-A1. Zero behaviour change.

import { getApiBase } from '../../config.svelte.js';

let managedTier = $state<string | undefined>(undefined);

export function getManagedTier(): string | undefined {
	return managedTier;
}

/** `true` when running on a managed instance (any non-empty tier string). */
export function isManaged(): boolean {
	return !!managedTier;
}

export async function loadManagedStatus(): Promise<void> {
	try {
		const res = await fetch(`${getApiBase()}/config`);
		if (!res.ok) return;
		const data = (await res.json()) as Record<string, unknown>;
		if (typeof data['managed'] === 'string') managedTier = data['managed'];
	} catch {
		/* ignore — original behaviour */
	}
}
