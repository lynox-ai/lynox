// === Integrations: web-search store (SearXNG) ===
//
// Owns the SearXNG URL save / remove / health-check + transient "saved!"
// flag with an auto-clear timer.
//
// The shared `configured` flag + `searxng_url` initial value still come
// from the secrets-status fetch in `./secrets.svelte.ts`; this module owns
// the *write* + form-buffer side and the health-probe.
//
// Tavily backend retired entirely 2026-05-24. SearXNG is the supported
// full-quality provider; without it the engine falls back to a best-effort
// DuckDuckGo HTML-scrape so `web_research` keeps working without the agent
// having to fabricate.

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

// ---------------------------------------------------------------------------
// Reranker capability
// ---------------------------------------------------------------------------
//
// Mirrors the runtime guard in `src/integrations/search/search-reranker.ts`:
// the reranker uses Anthropic Haiku and silently no-ops on `custom` / `openai`
// (Mistral) providers. We surface that state here so the SearchSettings page
// can show "Reranker is currently Anthropic-only" instead of letting a user
// flip LYNOX_SEARCH_RERANK=true and wonder why nothing changes.

export interface RerankerCapabilityState {
	supported: boolean;
	enabled: boolean;
	provider: 'anthropic' | 'vertex' | 'custom' | 'openai';
	reason?: 'provider-unsupported' | 'disabled-by-env';
}

let rerankerCapability = $state<RerankerCapabilityState | null>(null);
let rerankerCapabilityLoading = $state(false);

export function getRerankerCapability(): RerankerCapabilityState | null {
	return rerankerCapability;
}
export function isRerankerCapabilityLoading(): boolean {
	return rerankerCapabilityLoading;
}

export async function loadRerankerCapability(): Promise<void> {
	rerankerCapabilityLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/search/reranker/capability`);
		if (!res.ok) throw new Error();
		rerankerCapability = (await res.json()) as RerankerCapabilityState;
	} catch {
		rerankerCapability = null;
	}
	rerankerCapabilityLoading = false;
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
