/**
 * Migration store — manages the wizard state for self-hosted → managed migration.
 *
 * Flow:
 *   1. Preview — shows what data will be migrated
 *   2. Plan — choose plan + checkout OR enter existing instance details
 *   3. Provisioning — wait for new instance to become healthy (after checkout return)
 *   4. Transferring — ECDH + encrypt + transfer (engine-to-engine via SSE)
 *   5. Done — show verification summary
 *
 * The actual crypto happens engine-to-engine (POST /api/migration/export).
 * The browser only orchestrates and shows progress.
 */

import { getApiBase } from '../config.svelte.js';
import { addToast } from './toast.svelte.js';
import { t } from '../i18n.svelte.js';

// ── Types ──

export type MigrationStep = 'preview' | 'plan' | 'provisioning' | 'transferring' | 'done' | 'error';

export interface MigrationPreview {
	secrets: number;
	databases: string[];
	artifacts: number;
	hasConfig: boolean;
}

export interface MigrationVerification {
	secretsImported: number;
	databasesRestored: string[];
	artifactsImported: number;
	configApplied: boolean;
}

export interface TransferProgress {
	phase: string;
	message: string;
	current?: number | undefined;
	total?: number | undefined;
}

// ── State ──

let step = $state<MigrationStep>('preview');
let preview = $state<MigrationPreview | null>(null);
let loading = $state(false);
let error = $state('');
let progress = $state<TransferProgress | null>(null);
let verification = $state<MigrationVerification | null>(null);
let targetUrl = $state('');
let migrationToken = $state('');
let provisioningElapsed = $state(0);
let abortController: AbortController | null = null;
let provisioningTimer: ReturnType<typeof setInterval> | null = null;

// ── Getters ──

export function getStep(): MigrationStep { return step; }
export function getPreview(): MigrationPreview | null { return preview; }
export function getLoading(): boolean { return loading; }
export function getError(): string { return error; }
export function getProgress(): TransferProgress | null { return progress; }
export function getVerification(): MigrationVerification | null { return verification; }
export function getTargetUrl(): string { return targetUrl; }
export function getMigrationToken(): string { return migrationToken; }
export function getProvisioningElapsed(): number { return provisioningElapsed; }

// ── Actions ──

export async function loadPreview(): Promise<void> {
	loading = true;
	error = '';
	try {
		const res = await fetch(`${getApiBase()}/migration/preview`);
		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(detail || 'Failed to load preview');
		}
		preview = (await res.json()) as MigrationPreview;
	} catch (err: unknown) {
		error = err instanceof Error ? err.message : t('migration.error_preview');
	} finally {
		loading = false;
	}
}

/**
 * Initialize from URL parameters (checkout return flow).
 * Validates and sanitizes all inputs before accepting.
 */
export function initFromParams(params: URLSearchParams): boolean {
	const url = params.get('instanceUrl')?.trim() ?? '';
	const token = params.get('migrationToken')?.trim() ?? '';

	if (!url || !token) return false;

	// Validate URL format
	if (!isValidTargetUrl(url)) return false;

	// Validate token format (64 hex chars = 32 bytes)
	if (!/^[a-f0-9]{64}$/.test(token)) return false;

	targetUrl = url;
	migrationToken = token;
	return true;
}

export function goToPlan(): void {
	step = 'plan';
	error = '';
}

export function goBack(): void {
	if (step === 'plan') step = 'preview';
	if (step === 'provisioning') step = 'plan';
	stopProvisioningPoll();
	error = '';
}

export function setTarget(url: string, token: string): void {
	targetUrl = url.trim();
	migrationToken = token.trim();
}

/**
 * Build the checkout URL with return parameters.
 * The checkout page will redirect back here after payment + provisioning.
 */
export function getCheckoutUrl(plan: 'starter' | 'eu'): string {
	// The returnUrl tells checkout where to redirect after provisioning
	const currentUrl = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : '';
	const returnUrl = encodeURIComponent(currentUrl);
	return `https://lynox.ai/checkout?plan=${plan}&migration=true&returnUrl=${returnUrl}`;
}

/**
 * Start polling the target instance's health endpoint.
 * Used after checkout return when the instance may still be provisioning.
 */
export function startProvisioningPoll(): void {
	if (!targetUrl) return;
	step = 'provisioning';
	error = '';
	provisioningElapsed = 0;

	stopProvisioningPoll(); // cleanup any existing timer

	const startTime = Date.now();
	const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutes max

	provisioningTimer = setInterval(async () => {
		provisioningElapsed = Math.floor((Date.now() - startTime) / 1000);

		if (Date.now() - startTime > MAX_WAIT_MS) {
			stopProvisioningPoll();
			error = t('migration.error_provision_timeout');
			step = 'error';
			return;
		}

		try {
			const res = await fetch(`${targetUrl}/health`, {
				signal: AbortSignal.timeout(5000),
			});
			if (res.ok) {
				stopProvisioningPoll();
				// Instance is ready — start migration automatically
				startMigration();
			}
		} catch {
			// Instance not ready yet — keep polling
		}
	}, 3000);
}

function stopProvisioningPoll(): void {
	if (provisioningTimer) {
		clearInterval(provisioningTimer);
		provisioningTimer = null;
	}
}

/**
 * Start the migration. Opens an SSE connection to the source engine,
 * which handles ECDH + encryption + transfer to the target.
 */
export async function startMigration(): Promise<void> {
	if (!targetUrl || !migrationToken) {
		error = t('migration.error_missing_target');
		step = 'error';
		return;
	}

	// Validate before sending
	if (!isValidTargetUrl(targetUrl)) {
		error = t('migration.error_invalid_url');
		step = 'error';
		return;
	}

	step = 'transferring';
	error = '';
	progress = { phase: 'starting', message: t('migration.starting') };
	verification = null;

	abortController = new AbortController();

	try {
		const res = await fetch(`${getApiBase()}/migration/export`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ targetUrl, migrationToken }),
			signal: abortController.signal,
		});

		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			throw new Error(detail || 'Migration request failed');
		}

		// Read SSE stream
		const reader = res.body?.getReader();
		if (!reader) throw new Error('No response stream');

		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			let currentEvent = '';
			for (const line of lines) {
				if (line.startsWith('event: ')) {
					currentEvent = line.slice(7);
				} else if (line.startsWith('data: ') && currentEvent) {
					try {
						const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
						handleSSEEvent(currentEvent, data);
					} catch { /* skip malformed */ }
					currentEvent = '';
				}
			}
		}

		if (step === 'transferring') {
			error = t('migration.error_incomplete');
			step = 'error';
		}
	} catch (err: unknown) {
		if ((err as Error).name === 'AbortError') {
			error = t('migration.cancelled');
		} else {
			error = err instanceof Error ? err.message : t('migration.error_unknown');
		}
		if (step === 'transferring' || step === 'error') step = 'error';
	} finally {
		abortController = null;
	}
}

export function cancelMigration(): void {
	abortController?.abort();
	stopProvisioningPoll();
	step = 'error';
	error = t('migration.cancelled');
	progress = null;
}

export function reset(): void {
	step = 'preview';
	preview = null;
	loading = false;
	error = '';
	progress = null;
	verification = null;
	targetUrl = '';
	migrationToken = '';
	provisioningElapsed = 0;
	stopProvisioningPoll();
	abortController?.abort();
	abortController = null;
}

// ── Validation ──

function isValidTargetUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		// Must be HTTPS or local network (for testing)
		if (parsed.protocol === 'https:') return true;
		if (parsed.protocol === 'http:') {
			const host = parsed.hostname;
			return host === 'localhost' || host === '127.0.0.1' || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
		}
		return false;
	} catch {
		return false;
	}
}

// ── SSE Event Handling ──

function handleSSEEvent(event: string, data: Record<string, unknown>): void {
	switch (event) {
		case 'preview':
			preview = data as unknown as MigrationPreview;
			break;

		case 'progress':
			progress = {
				phase: String(data['phase'] ?? ''),
				message: String(data['message'] ?? ''),
				current: typeof data['current'] === 'number' ? data['current'] : undefined,
				total: typeof data['total'] === 'number' ? data['total'] : undefined,
			};
			break;

		case 'done': {
			const result = data as { success: boolean; verification: MigrationVerification };
			if (result.success) {
				verification = result.verification;
				step = 'done';
				addToast(t('migration.success'), 'success', 5000);
			} else {
				error = t('migration.error_restore');
				step = 'error';
			}
			break;
		}

		case 'error':
			error = String(data['message'] ?? t('migration.error_unknown'));
			step = 'error';
			addToast(error, 'error', 5000);
			break;
	}
}
