import { tf, t } from '../i18n.svelte.js';
import { setApart } from './plan-takeover.js';
import { visible, type StampAllowed } from './workflow-stamp.js';

/**
 * A value of the contract between the marks the view draws as a box, written exactly: a value is
 * matched as written, so whitespace other than a single space between two characters (a run of
 * spaces, a leading or trailing one, a tab, a line break) is printed as its code point instead of
 * being folded away, as are the characters `visible` prints.
 */
export function exactApart(text: string): string {
	const shown = visible(text).replace(/\s/gu, (c: string, i: number, s: string) =>
		c === ' ' && i > 0 && i < s.length - 1 && s[i - 1] !== ' ' && s[i + 1] !== ' '
			? c
			: `<U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`);
	return setApart(shown);
}

/** The lines the view prints under a parameter for what its contract allows, one per facet. */
export function allowedLines(a: StampAllowed | null): string[] {
	if (a === null) return [];
	const lines: string[] = [];
	if (a.enum !== null) {
		lines.push(a.enum.length === 0
			? t('workflow_library.stamp.allowed_none')
			: tf('workflow_library.stamp.allowed_list', { values: a.enum.map((v) => exactApart(String(v))).join(', ') }));
	}
	if (a.regex !== null) lines.push(tf('workflow_library.stamp.allowed_pattern', { pattern: exactApart(a.regex) }));
	if (a.min !== null && a.max !== null) {
		lines.push(tf('workflow_library.stamp.allowed_range', { min: exactApart(String(a.min)), max: exactApart(String(a.max)) }));
	} else if (a.min !== null) {
		lines.push(tf('workflow_library.stamp.allowed_min', { min: exactApart(String(a.min)) }));
	} else if (a.max !== null) {
		lines.push(tf('workflow_library.stamp.allowed_max', { max: exactApart(String(a.max)) }));
	}
	return lines;
}

/**
 * The writes a stored contract lets a run make without asking, one line per method and URL, as
 * the engine grants them: only `http_request`, and only for a method, host and path the contract
 * names (no path is no grant, not the whole host), in the order the stamp preview lists them. Null without a contract; an empty list for a
 * contract that grants nothing, which the view says in a sentence. No other tool is listed: the
 * engine grants none.
 */
export function contractLines(contract: unknown): string[] | null {
	if (contract === undefined || contract === null) return null;
	if (typeof contract !== 'object' || Array.isArray(contract)) return [];
	const c = contract as Record<string, unknown>;
	const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
	if (!list(c['grantedTools']).includes('http_request')) return [];
	return list(c['hostPatterns']).flatMap((h) => list(c['pathPatterns']).flatMap((p) => list(c['httpMethods']).map((m) => `${m} https://${h}${p}`)));
}
