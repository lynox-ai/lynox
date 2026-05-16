// === Integrations: Google Workspace OAuth ===
//
// Owns the entire Google-OAuth surface from IntegrationsView:
//  - `googleStatus` from `/api/google/status`
//  - Self-host credential entry (CLIENT_ID + CLIENT_SECRET into vault)
//  - Device-flow OR redirect-flow auth init
//  - Auth poll (3 s × 5 min cap) until tokens land
//  - Revoke + reset-credentials
//  - Managed-broker (`claim_nonce`) flow used on managed instances
//
// Foundation for P3-PR-A1. Zero behaviour change — straight port from
// IntegrationsView.svelte:83-313.

import { getApiBase } from '../../config.svelte.js';
import { t } from '../../i18n.svelte.js';
import { addToast } from '../toast.svelte.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoogleStatus {
	available: boolean;
	authenticated?: boolean;
	scopes?: string[];
	expiresAt?: string | null;
	hasRefreshToken?: boolean;
}

export interface DeviceFlow {
	verificationUrl: string;
	userCode: string;
}

export type ScopeMode = 'readonly' | 'full';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let googleStatus = $state<GoogleStatus | null>(null);
let googleLoading = $state(true);
let flow = $state<DeviceFlow | null>(null);
let connecting = $state(false);
let revoking = $state(false);
let googleClientId = $state('');
let googleClientSecret = $state('');
let googleCredSaving = $state(false);
let googleCredSaved = $state(false);
let scopeMode = $state<ScopeMode>('readonly');

// Managed-broker state
let managedGoogleClaiming = $state(false);

// Auth-poll handle — module-scoped so multiple consumers can clear it.
let authPollInterval: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function getGoogleStatus(): GoogleStatus | null {
	return googleStatus;
}
export function isGoogleLoading(): boolean {
	return googleLoading;
}
export function getDeviceFlow(): DeviceFlow | null {
	return flow;
}
export function isConnecting(): boolean {
	return connecting;
}
export function isRevoking(): boolean {
	return revoking;
}
export function getGoogleClientId(): string {
	return googleClientId;
}
export function setGoogleClientId(v: string): void {
	googleClientId = v;
}
export function getGoogleClientSecret(): string {
	return googleClientSecret;
}
export function setGoogleClientSecret(v: string): void {
	googleClientSecret = v;
}
export function isGoogleCredSaving(): boolean {
	return googleCredSaving;
}
export function isGoogleCredSaved(): boolean {
	return googleCredSaved;
}
export function getScopeMode(): ScopeMode {
	return scopeMode;
}
export function setScopeMode(m: ScopeMode): void {
	scopeMode = m;
}
export function isManagedGoogleClaiming(): boolean {
	return managedGoogleClaiming;
}

// ---------------------------------------------------------------------------
// Scope helpers — detect current scope mode from granted scopes
// ---------------------------------------------------------------------------

const WRITE_SCOPE_PREFIX = [
	'.send',
	'.modify',
	'/spreadsheets',
	'/drive',
	'/calendar.events',
	'/documents',
];

export function detectScopeMode(scopes: string[]): ScopeMode {
	return scopes.some((s) =>
		WRITE_SCOPE_PREFIX.some((w) => s.includes(w) && !s.includes('.readonly')),
	)
		? 'full'
		: 'readonly';
}

/** `true` when the granted scopes don't match the user's current toggle. */
export function isScopeMismatch(): boolean {
	if (!googleStatus?.authenticated || !googleStatus.scopes) return false;
	return detectScopeMode(googleStatus.scopes) !== scopeMode;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function loadGoogleStatus(): Promise<void> {
	googleLoading = true;
	try {
		const res = await fetch(`${getApiBase()}/google/status`);
		if (!res.ok) throw new Error();
		googleStatus = (await res.json()) as GoogleStatus;
		if (googleStatus?.scopes?.length) {
			scopeMode = detectScopeMode(googleStatus.scopes);
		}
	} catch {
		googleStatus = null;
	}
	googleLoading = false;
}

export async function saveGoogleCredentials(): Promise<void> {
	const trimmedId = googleClientId.trim();
	const trimmedSecret = googleClientSecret.trim();
	if (!trimmedId || !trimmedSecret) return;
	googleCredSaving = true;
	try {
		const [r1, r2] = await Promise.all([
			fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_ID`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: trimmedId }),
			}),
			fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_SECRET`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: trimmedSecret }),
			}),
		]);
		if (!r1.ok || !r2.ok) throw new Error();
		googleClientId = '';
		googleClientSecret = '';
		googleCredSaved = true;
		addToast(t('integrations.credentials_saved'), 'success');
		// Reload Google integration in the running Engine (no restart needed)
		await fetch(`${getApiBase()}/google/reload`, { method: 'POST' });
		await new Promise((r) => setTimeout(r, 500));
		googleCredSaved = false;
		await loadGoogleStatus();
		// Auto-start auth flow after credentials are saved
		if (googleStatus?.available && !googleStatus.authenticated) {
			await startGoogleAuth();
		}
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
	googleCredSaving = false;
}

export async function startGoogleAuth(): Promise<void> {
	connecting = true;
	flow = null;
	try {
		const res = await fetch(`${getApiBase()}/google/auth`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ scopeMode }),
		});
		if (res.ok) {
			const data = (await res.json()) as {
				authUrl?: string;
				verificationUrl?: string;
				userCode?: string;
			};
			if (data.authUrl) {
				// Redirect flow (managed/web-hosted) — redirect to Google consent
				window.location.href = data.authUrl;
				return;
			}
			flow = data as DeviceFlow;
			// Device flow — auto-open verification URL and copy code to clipboard
			if (flow?.verificationUrl) {
				window.open(flow.verificationUrl, '_blank', 'noopener');
				navigator.clipboard
					.writeText(flow.userCode)
					.then(() => {
						addToast(t('integrations.google_code_copied'), 'success', 4000);
					})
					.catch(() => {
						/* clipboard denied */
					});
			}
		} else {
			const err = (await res.json()) as { error?: string };
			const errMsg = err.error ?? '';
			if (errMsg.includes('unauthorized_client')) {
				addToast(t('integrations.google_wrong_client_type'), 'error', 12000);
			} else if (errMsg.includes('invalid_client')) {
				addToast(t('integrations.google_invalid_credentials'), 'error', 12000);
			} else {
				addToast(errMsg || t('common.error'), 'error', 6000);
			}
		}
	} catch {
		addToast(t('common.error'), 'error');
	}
	connecting = false;
	if (authPollInterval) clearInterval(authPollInterval);
	authPollInterval = setInterval(async () => {
		try {
			const r = await fetch(`${getApiBase()}/google/status`);
			if (!r.ok) return;
			const s = (await r.json()) as GoogleStatus;
			if (s.authenticated) {
				googleStatus = s;
				flow = null;
				if (authPollInterval) {
					clearInterval(authPollInterval);
					authPollInterval = null;
				}
			}
		} catch {
			/* ignore */
		}
	}, 3000);
	setTimeout(
		() => {
			if (authPollInterval) {
				clearInterval(authPollInterval);
				authPollInterval = null;
			}
		},
		5 * 60_000,
	);
}

export async function revokeGoogle(): Promise<void> {
	revoking = true;
	try {
		const res = await fetch(`${getApiBase()}/google/revoke`, { method: 'POST' });
		if (!res.ok) throw new Error();
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
	revoking = false;
	await loadGoogleStatus();
}

export async function resetGoogleCredentials(): Promise<void> {
	try {
		await Promise.all([
			fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_ID`, { method: 'DELETE' }),
			fetch(`${getApiBase()}/secrets/GOOGLE_CLIENT_SECRET`, { method: 'DELETE' }),
		]);
		await fetch(`${getApiBase()}/google/reload`, { method: 'POST' });
		flow = null;
		googleCredSaved = false;
		await loadGoogleStatus();
	} catch {
		addToast(t('common.save_failed'), 'error');
	}
}

export async function startManagedGoogleOAuth(): Promise<void> {
	try {
		const res = await fetch(`${getApiBase()}/google/oauth-url`);
		if (!res.ok) throw new Error();
		const data = (await res.json()) as { url: string };
		if (data.url) {
			// Validate the control plane URL is reachable before redirecting.
			// no-cors HEAD always "succeeds" — we redirect and let the user see
			// the result. This is the original IntegrationsView behaviour.
			try {
				await fetch(data.url, { method: 'HEAD', mode: 'no-cors' }).catch(() => null);
				window.location.href = data.url;
			} catch {
				addToast(t('integrations.google_oauth_unavailable'), 'error');
			}
		}
	} catch {
		addToast(t('integrations.google_oauth_unavailable'), 'error');
	}
}

export async function claimManagedGoogleTokens(claimNonce: string): Promise<void> {
	managedGoogleClaiming = true;
	try {
		const res = await fetch(`${getApiBase()}/google/claim-managed`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ claim_nonce: claimNonce }),
		});
		if (res.ok) {
			addToast(t('integrations.google_connected_managed'), 'success');
			await loadGoogleStatus();
		} else {
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			addToast(data.error ?? t('common.error'), 'error');
		}
	} catch {
		addToast(t('common.error'), 'error');
	}
	managedGoogleClaiming = false;
}

/**
 * Tear down the auth-poll interval. Component owners must call this from
 * onDestroy so we don't keep polling after navigation.
 */
export function stopAuthPoll(): void {
	if (authPollInterval) {
		clearInterval(authPollInterval);
		authPollInterval = null;
	}
}
