// === Integrations: shared secrets-status store ===
//
// Several channel-cards in IntegrationsView (Anthropic, Tavily/Search, SearXNG)
// read from the same `/api/secrets/status` endpoint. This store centralises that
// fetch + the per-secret "configured" flags so each channel route in P3-PR-A2
// can subscribe to only the slice it needs.
//
// Also owns the Anthropic-API-Key save flow because it is a single field
// without enough complexity to deserve its own channel store.
//
// Foundation for P3-PR-A1 (IntegrationsView state extraction). Zero behaviour
// change versus the original inline `$state` cluster.

import { getApiBase } from '../../config.svelte.js';
import { t } from '../../i18n.svelte.js';
import { addToast } from '../toast.svelte.js';

// ---------------------------------------------------------------------------
// State (module-level $state — same Svelte 5 pattern as other stores)
// ---------------------------------------------------------------------------

let secretsLoading = $state(true);
let apiKeyConfigured = $state(false);
let searchConfigured = $state(false);
let searxngConfigured = $state(false);
let searxngConfiguredUrl = $state('');

// Anthropic API key form state
let apiKey = $state('');
let apiKeySaving = $state(false);

// ---------------------------------------------------------------------------
// Reactive getters (function-form so consumers stay in $state-tracking scope)
// ---------------------------------------------------------------------------

export function isSecretsLoading(): boolean {
	return secretsLoading;
}
export function isApiKeyConfigured(): boolean {
	return apiKeyConfigured;
}
export function isSearchConfigured(): boolean {
	return searchConfigured;
}
export function isSearxngConfigured(): boolean {
	return searxngConfigured;
}
export function getSearxngConfiguredUrl(): string {
	return searxngConfiguredUrl;
}

// Anthropic API key form
export function getApiKey(): string {
	return apiKey;
}
export function setApiKey(v: string): void {
	apiKey = v;
}
export function isApiKeySaving(): boolean {
	return apiKeySaving;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface SecretsStatusResponse {
	configured: { search: boolean; api_key: boolean; searxng: boolean };
	searxng_url: string | null;
}

export async function loadSecretStatuses(): Promise<void> {
	secretsLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/secrets/status`);
		if (!res.ok) throw new Error();
		const data = (await res.json()) as SecretsStatusResponse;
		apiKeyConfigured = data.configured.api_key;
		searchConfigured = data.configured.search;
		searxngConfigured = data.configured.searxng;
		searxngConfiguredUrl = data.searxng_url ?? '';
	} catch {
		/* ignore — keep previous values, original behaviour */
	}
	secretsLoading = false;
}

export async function saveAnthropicApiKey(): Promise<void> {
	if (!apiKey.trim()) return;
	apiKeySaving = true;
	try {
		const res = await fetch(`${getApiBase()}/secrets/ANTHROPIC_API_KEY`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: apiKey.trim() }),
		});
		if (!res.ok) throw new Error();
		apiKey = '';
		addToast(t('integrations.api_key_saved'), 'success');
		await loadSecretStatuses();
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
	apiKeySaving = false;
}

// Direct setters for the SearXNG "remove" flow that needs to invalidate
// the cached configured flag without a full status reload race.
export function markSearxngRemoved(): void {
	searxngConfigured = false;
	searxngConfiguredUrl = '';
}
