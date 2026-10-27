import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APPROVAL_DECIDE_REFUSALS, APPROVAL_OUTCOME_SENTENCES, approvalNextStepKey, approvalOutcomeKey, type ApprovalStatus, type ApprovalViewer } from './approvals.js';

/**
 * Every key the approval queue's page asks for exists in both languages.
 *
 * `t()` returns the key itself on a miss, so a missing key does not fail anything: it renders
 * `approvals.error.checksum` where the owner needs to read why the list was reloaded. Keys are
 * collected from the sources, plus the ones the page builds from a value (status, hold, setup
 * line, refusal code), so a key added later is covered without editing this test.
 *
 * Source is read, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const I18N = read('../i18n.svelte.ts');
const SOURCES = ['./ApprovalCard.svelte', './ApprovalsView.svelte', './approvals.ts', './AppShell.svelte', './CommandPalette.svelte'].map(read);

function entry(key: string): { de: string; en: string } | null {
	const line = I18N.split('\n').find((l) => l.includes(`'${key}':`));
	if (!line) return null;
	const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
	const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(line);
	return de && en ? { de: de[1]!, en: en[1]! } : null;
}

const STATUSES = ['pending', 'approved', 'executing', 'done', 'rejected', 'failed', 'unknown', 'expired'];
const HELD = ['send_limit', 'retry'];
const SETUP = ['set_up_by', 'last_changed_by', 'test_run_by'];

const VIEWERS: ApprovalViewer[] = ['owner', 'mandate', 'none'];

/** Every outcome and next-step key the helpers can build, over every status, code and viewer. */
function outcomeKeys(): string[] {
	const keys: string[] = [];
	for (const status of STATUSES as ApprovalStatus[]) {
		for (const outcome of [...APPROVAL_OUTCOME_SENTENCES, 'sent', 'something_new', null]) {
			for (const viewer of VIEWERS) {
				const o = approvalOutcomeKey({ status, outcome }, viewer);
				const n = approvalNextStepKey({ status, outcome }, viewer);
				if (o !== null) keys.push(o);
				if (n !== null) keys.push(n);
			}
		}
	}
	return keys;
}

function usedKeys(): string[] {
	const literal = SOURCES.flatMap((src) => [...src.matchAll(/'((?:approvals|nav\.approvals)[a-z_.]*)'/g)].map((m) => m[1]!))
		.filter((k) => !k.endsWith('.'));
	const built = [
		...STATUSES.map((s) => `approvals.status.${s}`),
		...HELD.map((h) => `approvals.held.${h}`),
		...SETUP.map((s) => `approvals.setup.${s}`),
		...APPROVAL_DECIDE_REFUSALS.map((c) => `approvals.error.${c}`),
		...outcomeKeys(),
	];
	return [...new Set([...literal, ...built])];
}

describe('the page\'s sources', () => {
	it('the body keeps its line breaks and scrolls after about twelve lines', () => {
		const body = /<div class="([^"]*)" data-body>/.exec(read('./ApprovalCard.svelte'))?.[1] ?? '';
		expect(body.split(/\s+/)).toContain('whitespace-pre-wrap');
		expect(body.split(/\s+/)).toContain('max-h-[calc(12*1.5em+1.5rem)]');
		expect(body.split(/\s+/)).toContain('overflow-y-auto');
	});

	// What the item holds and when the count is polled is tested on the store
	// (`approvals-nav.svelte.test.ts`); the shell is too large to mount, so these pin only that it
	// calls the store and renders the badge it is given.
	it('the shell starts the count on mount, stops it on destroy, and takes the nav item from the store', () => {
		const shell = read('./AppShell.svelte');
		const mount = /onMount\(async \(\) => \{([\s\S]*?)\n\t\}\);/.exec(shell)?.[1] ?? '';
		expect(mount).toMatch(/^\t\tstopApprovalsNav = startApprovalsNav\(\);$/m);
		const destroy = /onDestroy\(\(\) => \{([\s\S]*?)\n\t\}\);/.exec(shell)?.[1] ?? '';
		expect(destroy).toMatch(/^\t\tstopApprovalsNav\?\.\(\);$/m);
		expect(shell).toMatch(/const approvals = approvalsNavItem\(\);\s*if \(approvals !== null\) items\.push\(approvals\);/);
		// Nothing else in the shell decides whose session it is for the queue.
		expect(shell).not.toMatch(/renew\.principal|getApprovalsBadge|getApprovalsEnabled/);
	});

	it('the shell renders the badge it is given: a count beside the label, a dot on the collapsed rail', () => {
		const shell = read('./AppShell.svelte');
		expect(shell).toMatch(/\{#if item\.badge && !railExpanded\}\s*<span class="[^"]*rounded-full[^"]*" aria-hidden="true"><\/span>\s*\{\/if\}/);
		expect(shell).toMatch(/\{#if item\.badge\}\s*<span [^>]*data-nav-badge>\s*<span aria-hidden="true">\{item\.badge\}<\/span>\s*<span class="sr-only">\{tf\('nav\.approvals_badge', \{ count: String\(item\.badge\) \}\)\}<\/span>\s*<\/span>\s*\{\/if\}/);
	});

	it('the palette offers the item only while the queue is on', () => {
		const palette = read('./CommandPalette.svelte');
		expect(palette).toMatch(/id: 'nav-approvals'[^\n]*approvalsOnly: true/);
		expect(palette).toContain('(!i.approvalsOnly || getApprovalsEnabled())');
	});
});

describe('the approval queue speaks both languages', () => {
	it('every key the page asks for resolves in de AND en', () => {
		const keys = usedKeys();
		// Guard the guard: a collector that stopped matching would assert over nothing.
		expect(keys.length).toBeGreaterThanOrEqual(40);
		expect(keys).toContain('nav.approvals');
		expect(keys).toContain('approvals.error.other');
		for (const key of keys) {
			const e = entry(key);
			expect(e, `${key} is missing from i18n.svelte.ts`).not.toBeNull();
			expect(e!.de.length, `${key} has no German`).toBeGreaterThan(0);
			expect(e!.en.length, `${key} has no English`).toBeGreaterThan(0);
		}
	});

	it('the page builds its refusal keys from the same list it is checked against', () => {
		expect(read('./approvals.ts')).toContain('`approvals.error.${code}`');
		expect(read('./ApprovalCard.svelte')).toContain('`approvals.status.${card.status}`');
		expect(read('./ApprovalCard.svelte')).toContain('`approvals.held.${card.held}`');
		expect(read('./ApprovalCard.svelte')).toContain('`approvals.setup.${line.kind}`');
	});

	it('the Reply-To sentence is exactly the reviewed one, both placeholders in both languages', () => {
		expect(entry('approvals.reply_to_elsewhere')).toEqual({
			de: 'Die Antwort geht an {replyTo}. Die Mail kam von {from} und nennt für Antworten diese andere Adresse.',
			en: 'The reply goes to {replyTo}. The email came from {from} and gives this other address for replies.',
		});
	});

	it('the page has a sentence for exactly the engine\'s outcome codes, `sent` aside', () => {
		const engine = readFileSync(fileURLToPath(new URL('../../../../../src/core/approval-view.ts', import.meta.url)), 'utf8');
		const block = /export const APPROVAL_OUTCOMES = \[([\s\S]*?)\] as const;/.exec(engine)?.[1] ?? '';
		const codes = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
		expect(codes.length).toBeGreaterThan(20);
		expect([...APPROVAL_OUTCOME_SENTENCES].sort()).toEqual(codes.filter((c) => c !== 'sent').sort());
	});

	it('the engine\'s label for a mandate without a name has a translation, and the page knows the label', () => {
		const engine = readFileSync(fileURLToPath(new URL('../../../../../src/core/approval-view.ts', import.meta.url)), 'utf8');
		const label = /export const UNNAMED_MANDATE = '([^']+)';/.exec(engine)?.[1];
		expect(label).toBeDefined();
		expect(read('./approvals.ts')).toContain(`export const UNNAMED_MANDATE = '${label!}';`);
		expect(entry('approvals.unnamed_mandate')).not.toBeNull();
	});

	it('the receive-only step names the settings path by the labels the navigation shows', () => {
		const step = entry('approvals.next.receive_only');
		const label = (key: string): { de: string; en: string } => entry(key) ?? { de: `missing ${key}`, en: `missing ${key}` };
		const [settings, channels, mail] = ['nav.settings', 'settings.channels', 'settings.channels.mail'].map(label);
		expect(step?.de).toContain(`${settings!.de} › ${channels!.de} › ${mail!.de}`);
		expect(step?.en).toContain(`${settings!.en} › ${channels!.en} › ${mail!.en}`);
	});

	it('nothing offers to approve or send everything at once', () => {
		const ALL = /alle\s+(freigeben|senden|bestätigen|genehmigen)|approve\s+all|send\s+all|confirm\s+all|select\s+all|alle\s+auswählen/i;
		const texts = usedKeys().map((k) => entry(k)).flatMap((e) => (e === null ? [] : [e.de, e.en]));
		for (const text of texts) expect(text).not.toMatch(ALL);
		for (const src of SOURCES.slice(0, 3)) {
			expect(src).not.toMatch(ALL);
			expect(src).not.toMatch(/approveAll|sendAll|approve_all|send_all/i);
		}
		// The detector is not blind.
		expect('Alle freigeben').toMatch(ALL);
		expect('Approve all').toMatch(ALL);
	});
});
