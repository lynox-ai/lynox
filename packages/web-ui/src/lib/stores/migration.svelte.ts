/**
 * Migration store — manages the wizard state for self-hosted → managed migration.
 *
 * Flow:
 *   1. Preview — shows what data will be migrated
 *   2. Plan — enter the target instance's URL and migration token
 *   3. Transferring — ECDH + encrypt + transfer (engine-to-engine via SSE)
 *   4. Done — show verification summary
 *
 * A target only enters the store through setTarget, behind the user's click.
 *
 * The actual crypto happens engine-to-engine (POST /api/migration/export).
 * The browser only orchestrates and shows progress.
 */

import { getApiBase } from '../config.svelte.js';
import { addToast } from './toast.svelte.js';
import { t, tf } from '../i18n.svelte.js';
import { migrationWorkspaceNotice } from '../backup-coverage.js';

// ── Types ──

export type MigrationStep = 'preview' | 'plan' | 'transferring' | 'done' | 'error';

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
	memoryFilesImported: number;
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
/** The `done` event's `workspace` record: `'omitted-sidecar'` when the export left the workspace out. */
let doneWorkspace = $state<unknown>(undefined);
/**
 * The `done` event's `skipped`: workspace entries the export could not carry (a link, a special
 * file, a name that cannot be transferred), as `workspace/<path>` (row 1033).
 */
let doneSkipped = $state<readonly string[]>([]);
let targetUrl = $state('');
let migrationToken = $state('');
let abortController: AbortController | null = null;

// ── Getters ──

export function getStep(): MigrationStep { return step; }
export function getPreview(): MigrationPreview | null { return preview; }
export function getLoading(): boolean { return loading; }
export function getError(): string { return error; }
export function getProgress(): TransferProgress | null { return progress; }
export function getVerification(): MigrationVerification | null { return verification; }
export function getDoneWorkspace(): unknown { return doneWorkspace; }
export function getDoneSkipped(): readonly string[] { return doneSkipped; }
export function getTargetUrl(): string { return targetUrl; }
export function getMigrationToken(): string { return migrationToken; }

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

export function goToPlan(): void {
	step = 'plan';
	error = '';
}

export function goBack(): void {
	if (step === 'plan') step = 'preview';
	error = '';
}

export function setTarget(url: string, token: string): void {
	targetUrl = url.trim();
	migrationToken = token.trim();
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
	doneWorkspace = undefined;
	doneSkipped = [];

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
	doneWorkspace = undefined;
	doneSkipped = [];
	targetUrl = '';
	migrationToken = '';
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
			const result = data as { success: boolean; verification: MigrationVerification; workspace?: unknown; skipped?: unknown };
			if (result.success) {
				verification = result.verification;
				doneWorkspace = result.workspace;
				doneSkipped = Array.isArray(result.skipped) ? result.skipped.filter((p): p is string => typeof p === 'string') : [];
				step = 'done';
				// A green "completed successfully" alone would be read and dismissed while the workspace
				// files stayed behind (ux U-046).
				const omitted = migrationWorkspaceNotice(result, false);
				if (omitted) addToast(t(omitted.toast), 'info', 8000);
				// Files the export could not carry: not the green toast either (row 1033, ux U-056).
				else if (doneSkipped.length === 1) addToast(t('migration.success_skipped_one'), 'info', 8000);
				else if (doneSkipped.length > 1) addToast(tf('migration.success_skipped_many', { n: String(doneSkipped.length) }), 'info', 8000);
				else addToast(t('migration.success'), 'success', 5000);
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
