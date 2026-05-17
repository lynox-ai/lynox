// === Integrations: web-search store (SearXNG) ===
//
// Owns the SearXNG URL save / remove / health-check + transient "saved!"
// flag with an auto-clear timer.
//
// The shared `configured` flag + `searxng_url` initial value still come
// from the secrets-status fetch in `./secrets.svelte.ts`; this module owns
// the *write* + form-buffer side and the health-probe.
//
// Tavily key save was dropped 2026-05-17 (P3-FOLLOWUP-HOTFIX) — SearXNG is
// the only surfaced provider now. Engine backend still honours an existing
// TAVILY_API_KEY env var for backwards-compat but nothing in the UI sets it.

import { getApiBase } from '../../config.svelte.js';
import { t } from '../../i18n.svelte.js';
import { addToast } from '../toast.svelte.js';
import { loadSecretStatuses, markSearxngRemoved } from './secrets.svelte.js';

// ---------------------------------------------------------------------------
// SearXNG
// ---------------------------------------------------------------------------

let searxngUrl = $state('');
let searxngSaving = $state(false);
let searxngSaved = $state(false);
let searxngChecking = $state(false);
let searxngHealthy = $state<boolean | null>(null);

export function getSearxngUrl(): string {
	return searxngUrl;
}
export function setSearxngUrl(v: string): void {
	searxngUrl = v;
}
export function isSearxngSaving(): boolean {
	return searxngSaving;
}
export function isSearxngSaved(): boolean {
	return searxngSaved;
}
export function isSearxngChecking(): boolean {
	return searxngChecking;
}
export function getSearxngHealthy(): boolean | null {
	return searxngHealthy;
}
export function resetSearxngHealth(): void {
	searxngHealthy = null;
}

export async function checkSearxng(url: string): Promise<void> {
	searxngChecking = true;
	searxngHealthy = null;
	try {
		const res = await fetch(`${getApiBase()}/searxng/check`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ url }),
		});
		if (!res.ok) throw new Error();
		const data = (await res.json()) as { healthy: boolean };
		searxngHealthy = data.healthy;
	} catch {
		searxngHealthy = false;
	}
	searxngChecking = false;
}

export async function saveSearxng(): Promise<void> {
	const url = searxngUrl.trim().replace(/\/+$/, '');
	if (!url) return;
	searxngSaving = true;
	try {
		const res = await fetch(`${getApiBase()}/config`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ searxng_url: url }),
		});
		if (!res.ok) throw new Error();
		searxngUrl = '';
		searxngSaved = true;
		searxngHealthy = null;
		setTimeout(() => (searxngSaved = false), 2000);
		await loadSecretStatuses();
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
	searxngSaving = false;
}

export async function removeSearxng(): Promise<void> {
	searxngSaving = true;
	try {
		const res = await fetch(`${getApiBase()}/config`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ searxng_url: null }),
		});
		if (!res.ok) throw new Error();
		markSearxngRemoved();
		searxngHealthy = null;
		await loadSecretStatuses();
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
	searxngSaving = false;
}
