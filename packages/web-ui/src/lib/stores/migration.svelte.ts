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
import { MIGRATION_BROWSER_CODES, knownMigrationCode, migrationErrorPlain, migrationErrorView, migrationNotStarted, type MigrationErrorParams, type MigrationRetry } from '../migration-error-text.js';
import { isValidTargetUrl } from '../migration-target-url.js';

export type { MigrationRetry } from '../migration-error-text.js';

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
/**
 * What the user can do after an error, as the engine says it (`retry` on its `error` event):
 * start again now, wait until the target releases its session, check the target first, or nothing
 * a retry would change (`none`: back to the inputs only).
 */
let retry = $state<MigrationRetry>('now');
/** When the error came (ms); with `later` the target holds its session for at most 30 minutes from then. */
let errorAt = $state(0);
/** The step the error came from, so the step marks stay where it happened. */
let errorStep = $state<MigrationStep>('preview');
/** The error's code (the engine's, or the wizard's own) and its parameters; the card says it in the UI's language. */
let errorCode = $state('');
let errorParams = $state<MigrationErrorParams>({});
/**
 * The reason this instance gave for not starting the migration without a code, cleaned and cut.
 * Shown next to the wizard's own sentence: a proxy in front of it can answer in its place.
 */
let errorReason = $state('');
/** The migration never started (the start request was turned down), so the wizard does not say it did not finish. */
let errorNotStarted = $state(false);
let abortController: AbortController | null = null;

// ── Getters ──

export function getStep(): MigrationStep { return step; }
export function getRetry(): MigrationRetry { return retry; }
export function getErrorAt(): number { return errorAt; }
export function getErrorStep(): MigrationStep { return errorStep; }
export function getErrorCode(): string { return errorCode; }
export function getErrorParams(): MigrationErrorParams { return errorParams; }
export function getErrorReason(): string { return errorReason; }
export function getErrorNotStarted(): boolean { return errorNotStarted; }

/** The longest a target holds an unfinished session (30 minutes). */
export const MIGRATION_HOLD_MS = 30 * 60 * 1000;

/**
 * The error card for `code`. An engine code the UI has no sentence for is said as one lynox could
 * not read. `error` holds the sentence as one line; the card builds it from the code itself.
 */
function fail(code: string, from: { retry: MigrationRetry; params?: MigrationErrorParams; reason?: string }): void {
	if (step !== 'error') errorStep = step;
	const known = code === 'start_refused' || knownMigrationCode(code) ? code : 'unknown';
	errorCode = known;
	errorParams = known === code ? from.params ?? {} : {};
	errorReason = from.reason ?? '';
	errorNotStarted = migrationNotStarted(known);
	error = migrationErrorPlain(migrationErrorView(errorCode, errorParams, errorReason));
	retry = from.retry;
	errorAt = Date.now();
	step = 'error';
}

/**
 * The retry of one of the wizard's own codes. A cancel gives `check`: the engine carries on after
 * the browser stops listening, so whether the target restored the data is not known.
 */
function browserRetry(code: keyof typeof MIGRATION_BROWSER_CODES): MigrationRetry {
	return MIGRATION_BROWSER_CODES[code];
}
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
			// The wizard's own sentence: the answer can be a proxy's page or the engine's English text.
			await res.body?.cancel().catch(() => {});
			error = t('migration.error_preview');
			return;
		}
		preview = (await res.json()) as MigrationPreview;
	} catch {
		error = t('migration.error_preview');
	} finally {
		loading = false;
	}
}

export function goToPlan(): void {
	step = 'plan';
	error = '';
}

/** Back from an error to the inputs, as they were: the way out where a retry would change nothing. */
export function backToInputs(): void {
	step = 'plan';
	error = '';
	errorCode = '';
	errorParams = {};
	errorReason = '';
	errorNotStarted = false;
	retry = 'now';
	errorAt = 0;
	progress = null;
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
		fail('start_missing_input', { retry: 'none' });
		return;
	}

	// The engine's rule, checked before sending: what it would turn down is not sent.
	if (!isValidTargetUrl(targetUrl)) {
		fail('browser_invalid_url', { retry: browserRetry('browser_invalid_url') });
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
			// Turned down before anything went out: the sentence for the engine's code, or, from an
			// answer without one (a proxy, the auth layer), the wizard's sentence with the answer's reason.
			// The answer is read first, so it cannot land on a state the user has moved on from.
			const refused = await refusal(res);
			// Cancelled while the answer was read: `cancelMigration` has already said so.
			if (step !== 'transferring') return;
			if (refused.code !== null && migrationNotStarted(refused.code) && knownMigrationCode(refused.code)) fail(refused.code, { retry: 'none' });
			else fail('start_refused', { retry: browserRetry('start_refused'), reason: refused.reason });
			return;
		}

		// Read SSE stream
		const reader = res.body?.getReader();
		if (!reader) {
			fail('connection_lost', { retry: browserRetry('connection_lost') });
			return;
		}

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

		// The stream ended without a result: what happened on the target is not known.
		if (step === 'transferring') fail('connection_lost', { retry: browserRetry('connection_lost') });
	} catch (err: unknown) {
		if ((err as Error).name === 'AbortError') {
			// `cancelMigration` has already said so.
			if (step === 'transferring') fail('cancelled', { retry: browserRetry('cancelled') });
		} else if (step === 'transferring') {
			// A failed fetch or a broken stream: the browser's own text goes to the console only.
			if (err instanceof Error) {
				console.warn('[migration] the request to this instance failed:', err.message);
				fail('connection_failed', { retry: browserRetry('connection_failed') });
			} else {
				// Not a failure this code can read: what happened on the target is not known.
				fail('unknown', { retry: 'check' });
			}
		}
	} finally {
		abortController = null;
	}
}

/** Longest reason shown from a refused start. */
const REASON_MAX = 200;
/** Most of a refused start's answer read for its reason (bytes); a longer answer gives none. */
const REASON_READ_MAX = 8 * 1024;

/** The answer's body up to `REASON_READ_MAX` bytes; null when it is longer or cannot be read. */
async function readCapped(res: Response): Promise<string | null> {
	const reader = res.body?.getReader();
	if (!reader) return null;
	const parts: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > REASON_READ_MAX) { await reader.cancel().catch(() => {}); return null; }
			parts.push(value);
		}
	} catch {
		return null;
	}
	const all = new Uint8Array(size);
	let at = 0;
	for (const p of parts) { all.set(p, at); at += p.byteLength; }
	return new TextDecoder().decode(all);
}

/**
 * The `code` and the `error` of a JSON answer that refused the start, the error without control and
 * bidi characters, on one line and cut at `REASON_MAX`; neither for any other body (a proxy's page,
 * plain text).
 */
async function refusal(res: Response): Promise<{ code: string | null; reason: string }> {
	let said: { error?: unknown; code?: unknown };
	const body = await readCapped(res);
	if (body === null) return { code: null, reason: '' };
	try { said = JSON.parse(body) as { error?: unknown; code?: unknown }; } catch { return { code: null, reason: '' }; }
	const code = typeof said?.code === 'string' ? said.code : null;
	return { code, reason: typeof said?.error === 'string' ? reasonText(said.error) : '' };
}

function reasonText(said: string): string {
	const text = said.replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
	const chars = [...text];
	return chars.length > REASON_MAX ? `${chars.slice(0, REASON_MAX - 1).join('')}…` : text;
}

export function cancelMigration(): void {
	abortController?.abort();
	fail('cancelled', { retry: browserRetry('cancelled') });
	progress = null;
}

export function reset(): void {
	step = 'preview';
	preview = null;
	loading = false;
	error = '';
	retry = 'now';
	errorAt = 0;
	errorCode = '';
	errorParams = {};
	errorReason = '';
	errorNotStarted = false;
	errorStep = 'preview';
	progress = null;
	verification = null;
	doneWorkspace = undefined;
	doneSkipped = [];
	targetUrl = '';
	migrationToken = '';
	abortController?.abort();
	abortController = null;
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
				const omitted = migrationWorkspaceNotice(result);
				if (omitted) addToast(t(omitted.toast), 'info', 8000);
				// Files the export could not carry: not the green toast either (row 1033, ux U-056).
				else if (doneSkipped.length === 1) addToast(t('migration.success_skipped_one'), 'info', 8000);
				else if (doneSkipped.length > 1) addToast(tf('migration.success_skipped_many', { n: String(doneSkipped.length) }), 'info', 8000);
				else addToast(t('migration.success'), 'success', 5000);
			} else {
				// The engine says `done` only on success: anything else is a result lynox cannot read,
				// and what the target restored is not known.
				fail('unknown', { retry: 'check' });
			}
			break;
		}

		case 'error': {
			// Shown once, in the wizard's error card: no toast on top of it. The card says the code's
			// sentence; the engine's English `message` is for the log and the API, not shown.
			const said = data['retry'];
			const next: MigrationRetry = said === 'later' || said === 'check' || said === 'none' ? said : 'now';
			const code = typeof data['code'] === 'string' ? data['code'] : 'unknown';
			fail(code, { retry: next, params: stopParams(data['params']) });
			break;
		}
	}
}

/** The `params` of an `error` event: only plain values, anything else left out. */
function stopParams(raw: unknown): MigrationErrorParams {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
	const out: Record<string, string | number | boolean> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
	}
	return out;
}
