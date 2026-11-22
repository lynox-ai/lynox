/**
 * The migration wizard's error sentence, from the code the engine (or the wizard itself) gives and
 * its parameters, in the UI's language.
 *
 * The sentence comes as segments: plain text, and values (a variable name, a path, a folder) that
 * the card sets apart in a box of their own. The target's words or this instance's error text come
 * as a separate box under the sentence, with its label. Everything is text: nothing here is HTML.
 */

import { getLocale, t, tf } from './i18n.svelte.js';

/** What the user can do after the error (the engine's `retry`, or the wizard's own for its codes). */
export type MigrationRetry = 'now' | 'later' | 'check' | 'none';

/** A part of the sentence: words, or a value shown in a box. */
export type MigrationErrorSegment = { readonly text: string } | { readonly value: string };

/** A value under the sentence, with its label: the target's words, or this instance's error text. */
export interface MigrationErrorBox {
	readonly label: string;
	readonly value: string;
}

export interface MigrationErrorView {
	readonly segments: readonly MigrationErrorSegment[];
	readonly box: MigrationErrorBox | null;
}

export type MigrationErrorParams = Readonly<Record<string, string | number | boolean>>;

/**
 * The codes the wizard gives itself, and the retry each one has: the start check in the browser,
 * a stream that ends without a result, a cancel, a request that does not reach this instance, and a
 * start this instance turned down without a code (a proxy, the auth layer).
 *
 * A cancel asks to check the target first, whatever step it came at: it only stops the browser
 * listening. The engine carries on with the migration (connection, transfer, restore), so whether
 * the target restored the data is not known here.
 */
export const MIGRATION_BROWSER_CODES = {
	browser_invalid_url: 'none',
	connection_lost: 'check',
	cancelled: 'check',
	connection_failed: 'now',
	start_refused: 'now',
} as const satisfies Record<string, MigrationRetry>;

/** The engine's codes of a start request it turned down: they say that the migration did not start. */
const START_CODES = new Set(['start_missing_input', 'start_not_https', 'start_invalid_url', 'start_not_public', 'start_managed']);

/** Whether the error is one where the migration did not start at all. */
export function migrationNotStarted(code: string): boolean {
	return START_CODES.has(code) || code === 'browser_invalid_url' || code === 'start_refused';
}

/** The i18n key of a code's sentence. */
export function migrationStopKey(code: string): string {
	return `migration.stop.${code}`;
}

/** Whether the UI has a sentence for `code`; any other code is said as one lynox could not read. */
export function knownMigrationCode(code: string): boolean {
	return t(migrationStopKey(code)) !== migrationStopKey(code);
}

const numberLocale = (): string => (getLocale() === 'de' ? 'de-CH' : 'en-GB');

function num(n: number): string {
	return n.toLocaleString(numberLocale(), { maximumFractionDigits: 1 });
}

/** A size a person reads: bytes, KiB, MiB or GiB with at most one decimal. */
export function migrationSizeText(bytes: number): string {
	const units = ['KiB', 'MiB', 'GiB'] as const;
	if (bytes < 1024) return tf('migration.size_bytes', { n: num(bytes) });
	let value = bytes / 1024;
	let unit: (typeof units)[number] = 'KiB';
	for (const next of units.slice(1)) {
		if (value < 1024) break;
		value /= 1024;
		unit = next;
	}
	return `${num(value)} ${unit}`;
}

/** Two sizes that would read the same are said in bytes, so a refusal never reads "500 MiB, at most 500 MiB". */
function sizePair(a: number, b: number): [string, string] {
	const x = migrationSizeText(a);
	const y = migrationSizeText(b);
	return x === y && a !== b ? [tf('migration.size_bytes', { n: num(a) }), tf('migration.size_bytes', { n: num(b) })] : [x, y];
}

/** A deadline as the engine counts it (seconds below two minutes, minutes from there), in the UI's language. */
export function migrationDurationText(ms: number): string {
	return ms >= 120_000 ? tf('migration.duration_minutes', { n: num(ms / 60_000) }) : tf('migration.duration_seconds', { n: num(ms / 1000) });
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "part n of m of the data", with the kind's word only for a kind the UI knows. */
function partText(params: MigrationErrorParams): string | null {
	const n = int(params['part']);
	const m = int(params['parts']);
	if (n === null || m === null) return null;
	const kind = str(params['kind']);
	const kindKey = kind === null ? null : `migration.kind.${kind}`;
	const word = kindKey === null ? null : t(kindKey);
	return word !== null && word !== kindKey
		? tf('migration.part_kind', { n: num(n), m: num(m), kind: word })
		: tf('migration.part', { n: num(n), m: num(m) });
}

/** The template split at its `{name}` slots, each filled with its segment; a slot without one stays as written. */
function fill(template: string, vars: Readonly<Record<string, MigrationErrorSegment>>): MigrationErrorSegment[] {
	const out: MigrationErrorSegment[] = [];
	let at = 0;
	for (const m of template.matchAll(/\{(\w+)\}/g)) {
		const slot = vars[m[1] ?? ''];
		if (slot === undefined) continue;
		if (m.index > at) out.push({ text: template.slice(at, m.index) });
		out.push(slot);
		at = m.index + m[0].length;
	}
	if (at < template.length) out.push({ text: template.slice(at) });
	return out;
}

const text = (s: string): MigrationErrorSegment => ({ text: s });
const value = (s: string): MigrationErrorSegment => ({ value: s });

/** The view of C21, said for an unknown code too: "nothing was transferred" only where that is certain. */
function unreadable(params: MigrationErrorParams): MigrationErrorView {
	return { segments: [text(t(params['nothingSent'] === true ? 'migration.stop.unknown_nothing_sent' : 'migration.stop.unknown'))], box: null };
}

/**
 * The sentence for `code` filled from `params`, and the box under it. `reason` is the answer's own
 * text of a start this instance turned down without a code.
 */
export function migrationErrorView(code: string, params: MigrationErrorParams = {}, reason = ''): MigrationErrorView {
	if (code === 'start_refused') {
		return { segments: [text(t('migration.error_not_started'))], box: reason === '' ? null : { label: t('migration.error_reason'), value: reason } };
	}
	// A code this UI does not know says nothing certain about what was sent.
	if (!knownMigrationCode(code)) return unreadable({});
	if (code === 'unknown') return unreadable(params);
	const template = t(migrationStopKey(code));
	const vars: Record<string, MigrationErrorSegment> = {};
	switch (code) {
		case 'vault_key_missing':
			vars['env'] = value('LYNOX_VAULT_KEY');
			vars['envFile'] = value('~/.lynox/.env');
			vars['keyFile'] = value('vault.key');
			break;
		case 'data_too_large': {
			const over: string[] = [];
			const parts = int(params['parts']);
			const maxParts = int(params['maxParts']);
			if (parts !== null && maxParts !== null) over.push(tf('migration.stop.data_too_large_parts', { n: num(parts), m: num(maxParts) }));
			const bytes = int(params['bytes']);
			const maxBytes = int(params['maxBytes']);
			if (bytes !== null && maxBytes !== null) {
				const [size, max] = sizePair(bytes, maxBytes);
				over.push(tf('migration.stop.data_too_large_size', { size, max }));
			}
			if (over.length === 0) return unreadable({ nothingSent: true });
			vars['over'] = text(over.join(t('migration.stop.and')));
			break;
		}
		case 'folder_too_large': {
			const dir = str(params['dir']);
			const entries = int(params['entries']);
			const bytes = int(params['bytes']);
			if (dir === null || entries === null || bytes === null) return unreadable({ nothingSent: true });
			vars['dir'] = value(dir);
			vars['entries'] = text(num(entries));
			vars['size'] = text(migrationSizeText(bytes));
			break;
		}
		case 'chunk_unreachable':
		case 'chunk_refused': {
			const part = partText(params);
			if (part === null) return unreadable(params);
			vars['part'] = text(part);
			break;
		}
		case 'transfer_out_of_time':
		case 'restore_out_of_time': {
			const ms = int(params['durationMs']);
			if (ms === null) return unreadable(params);
			vars['duration'] = text(migrationDurationText(ms));
			break;
		}
	}
	const targetText = str(params['targetText']);
	const detail = str(params['detail']);
	const box = targetText !== null
		? { label: t('migration.target_says'), value: targetText }
		: detail !== null && (code === 'export_failed' || code === 'restore_failed')
			? { label: t('migration.message'), value: detail }
			: null;
	return { segments: fill(template, vars), box };
}

/** The view as one plain line (for `getError`), the values in place. */
export function migrationErrorPlain(view: MigrationErrorView): string {
	return view.segments.map((s) => ('text' in s ? s.text : s.value)).join('');
}
