import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CANONICAL_BILLING_TIERS } from './contract/vocab.js';

/**
 * "Does the control plane supply the LLM key?" has one answer: `cpSuppliesLLMKey`
 * from the contract. Components used to spell the set out themselves
 * (`managed === 'managed' || managed === 'managed_pro' || managed === 'eu'`), in nine
 * places, so adding a billing tier meant finding every copy — and a missed copy made
 * the new tier look like a customer-key instance: provider picker, BYOK setup path.
 *
 * This refuses a comparison of a tier-holding variable against a CP-key tier literal
 * anywhere in `src/` outside the vendored contract. `'hosted'` stays allowed: it is
 * the one customer-key tier, and comparing a normalized value against it is the
 * question "BYOK or not", not an enumeration of the CP-key set.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTRACT_DIR = join(ROOT, 'lib', 'contract');

function sources(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (path !== CONTRACT_DIR) out.push(...sources(path));
		} else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
			out.push(path);
		}
	}
	return out;
}

const ENUMERATION =
	/\b(?:managed|managedMode|managedTier)\s*[!=]==?\s*'(?:managed|managed_pro|managed_max|eu|starter)'/;

const CP_ONLY_LITERAL = /(['"`])managed_(?:pro|max)\1/;

const ACCOUNT_VIEW = 'components/AccountBillingView.svelte';

/** Blanks `//` and block comments, keeping every newline, so line numbers still match. */
function stripComments(src: string): string {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

/**
 * The account view's label switch, found on comment-free source: the one
 * `switch (managed) {` in the file, closed by brace depth. `caseLines` are the lines
 * that sit DIRECTLY in it (depth 1), so a switch nested inside gets no exemption.
 * `null` when the file has no such switch or more than one — the caller fails loud.
 */
function labelSwitch(src: string): { open: number; close: number; caseLines: Set<number>; body: string } | null {
	const lines = stripComments(src).split('\n');
	const opens = lines.flatMap((l, i) => (/\bswitch \(managed\) \{/.test(l) ? [i] : []));
	if (opens.length !== 1) return null;
	const open = opens[0]!;
	const caseLines = new Set<number>();
	let depth = 0;
	for (let i = open; i < lines.length; i++) {
		const line = lines[i]!;
		if (depth === 1 && /^\s*case\b/.test(line)) caseLines.add(i);
		for (const ch of line) {
			if (ch === '{') depth++;
			else if (ch === '}' && --depth === 0) {
				return { open, close: i, caseLines, body: lines.slice(open, i + 1).join('\n') };
			}
		}
	}
	return null;
}

describe('billing tier is asked through the contract, never spelled out', () => {
	it('no component compares a tier value against a CP-key tier literal', () => {
		const files = sources(ROOT);
		// Positive control: the walk must reach the components it guards, or an empty
		// list would pass this test for the wrong reason.
		expect(files.some((f) => f.endsWith('SetupBanner.svelte'))).toBe(true);
		const hits: string[] = [];
		for (const file of files) {
			readFileSync(file, 'utf-8').split('\n').forEach((line, i) => {
				if (ENUMERATION.test(line)) hits.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim()}`);
			});
		}
		expect(hits, 'use cpSuppliesLLMKey / normalizeBillingTier from utils/billing-tier').toEqual([]);
	});

	it('no component names a CP-key-only tier literal outside the contract', () => {
		// `managed_pro` / `managed_max` mean nothing but a billing tier, so ANY standalone
		// literal of them outside the contract is an enumeration of the tier set — a
		// switch case, an `.includes([...])` array, a comparison on any variable name. The
		// comparison check above cannot see those forms; this one does not care about the
		// form. (`'managed'` and `'eu'` also name other things here — the hard_limits
		// shape, an LLM region — so they stay with the narrower check.)
		// The one allowed form is a `case` line of the account label switch: its `never`
		// default makes it exhaustive over BillingTier, so a new tier fails the compile
		// there. Only the case LABEL of a line directly in that switch is exempt — the
		// rest of such a line, a nested switch and anything else in the file are checked.
		const CASE_LABEL = /^\s*case\s+(['"`])managed_(?:pro|max)\1\s*:/;
		const hits: string[] = [];
		let switchFound = false;
		for (const file of sources(ROOT)) {
			const rel = file.slice(ROOT.length).replace(/^lib\//, '');
			const src = readFileSync(file, 'utf-8');
			const sw = rel === ACCOUNT_VIEW ? labelSwitch(src) : null;
			if (rel === ACCOUNT_VIEW) switchFound = sw !== null;
			src.split('\n').forEach((line, i) => {
				const checked = sw?.caseLines.has(i) ? line.replace(CASE_LABEL, '') : line;
				if (CP_ONLY_LITERAL.test(checked)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
			});
		}
		// Without the switch nothing is exempt and the case lines show up as hits below;
		// this says why.
		expect(switchFound, `${ACCOUNT_VIEW}: exactly one \`switch (managed) {\` expected`).toBe(true);
		expect(hits, 'use cpSuppliesLLMKey / normalizeBillingTier from utils/billing-tier').toEqual([]);
	});

	it('the pattern catches the form it exists for', () => {
		expect(ENUMERATION.test("managed = body.managed === 'managed' || body.managed === 'managed_pro';")).toBe(true);
		expect(ENUMERATION.test("{#if managedMode !== 'managed_max'}")).toBe(true);
		expect(ENUMERATION.test("{#if managed === 'hosted'}")).toBe(false);
		expect(CP_ONLY_LITERAL.test("case 'managed_pro':")).toBe(true);
		expect(CP_ONLY_LITERAL.test('if (["managed", "managed_max"].includes(tier))')).toBe(true);
		expect(CP_ONLY_LITERAL.test("t('account.billing.tier.managed_pro')")).toBe(false);
	});

	it('the account label switch is exhaustive by a never default, not by convention', () => {
		const sw = labelSwitch(readFileSync(fileURLToPath(new URL('./components/AccountBillingView.svelte', import.meta.url)), 'utf-8'));
		expect(sw, 'exactly one `switch (managed) {` expected').not.toBeNull();
		// Bound to that switch, on comment-free source: a `never` line in a comment or
		// in another place of the file does not make THIS switch exhaustive.
		expect(sw!.body).toMatch(/default: \{\s*const \w+: never = managed;/);
	});

	it('every canonical tier has an account label in both locales', () => {
		// Read as source: importing i18n.svelte.ts throws under the root vitest config
		// (see preset-cards-i18n.test.ts). A missing key renders the key itself.
		const src = readFileSync(fileURLToPath(new URL('./i18n.svelte.ts', import.meta.url)), 'utf-8');
		for (const tier of CANONICAL_BILLING_TIERS) {
			const line = src.split('\n').find((l) => l.includes(`'account.billing.tier.${tier}':`));
			expect(line, tier).toBeDefined();
			expect(line).toMatch(/de: '[^']+'/);
			expect(line).toMatch(/en: '[^']+'/);
		}
	});
});
