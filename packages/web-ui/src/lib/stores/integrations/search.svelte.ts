// === Integrations: web-search providers (Tavily + SearXNG) ===
//
// Owns the search-provider state cluster from IntegrationsView:
//  - Tavily API-key save (single field, mirrors saveAnthropicApiKey shape)
//  - SearXNG URL save / remove / health-check
//  - Transient "saved!" flags with auto-clear timers
//
// The shared `configured` flags + `searxng_url` initial value still come
// from the secrets-status fetch in `./secrets.svelte.ts`; this module owns
// the *write* + form-buffer side and the health-probe.
//
// Foundation for P3-PR-A1. Zero behaviour change — straight port from
// IntegrationsView.svelte:339-442.

import { getApiBase } from '../../config.svelte.js';
import { t } from '../../i18n.svelte.js';
import { addToast } from '../toast.svelte.js';
import { loadSecretStatuses, markSearxngRemoved } from './secrets.svelte.js';

// ---------------------------------------------------------------------------
// Tavily / Web search
// ---------------------------------------------------------------------------

let searchKey = $state('');
let searchSaving = $state(false);
let searchSaved = $state(false);

export function getSearchKey(): string {
	return searchKey;
}
export function setSearchKey(v: string): void {
	searchKey = v;
}
export function isSearchSaving(): boolean {
	return searchSaving;
}
export function isSearchSaved(): boolean {
	return searchSaved;
}

export async function saveSearch(): Promise<void> {
	if (!searchKey.trim()) return;
	searchSaving = true;
	try {
		const res = await fetch(`${getApiBase()}/secrets/TAVILY_API_KEY`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: searchKey }),
		});
		if (!res.ok) throw new Error();
		searchKey = '';
		searchSaved = true;
		setTimeout(() => (searchSaved = false), 2000);
		await loadSecretStatuses();
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
	searchSaving = false;
}

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
