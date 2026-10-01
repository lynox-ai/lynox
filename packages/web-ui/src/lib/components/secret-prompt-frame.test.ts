import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';


/**
* The credential dialog's title has to be OURS.
*
* It used to render `{pendingSecret.prompt}` — the sentence the AGENT wrote — in
* `text-sm font-medium text-text`, the same classes the product's own titles use
* a few blocks down in this file. So a dialog asking for a credential was titled
* by whoever wrote the tool call, and external content the agent read (a mail
* body, a fetched page) can be what wrote it. The text was never the hole: it is
* escaped, and this dialog has never rendered markdown. The SLOT was.
*
* There is no component renderer in this package's tests, so a source assertion
* is the only instrument for a Svelte template — the same one
* `prompt-markdown.test.ts` uses on this file, for the same reason. To keep it
* from being a string count, it pins the STRUCTURE: which expression sits in the
* title slot, and where the agent's text is allowed to appear.
*/
const CHATVIEW = readFileSync(
	fileURLToPath(new URL('./ChatView.svelte', import.meta.url)),
	'utf-8',
);

const I18N = readFileSync(
	fileURLToPath(new URL('../i18n.svelte.ts', import.meta.url)),
	'utf-8',
);

/**
* The secret block alone, bounded by its OWN closing tag — the `{#if
* pendingSecret}` block sits at one tab, so `\n\t{/if}` closes it and nothing
* else. Deliberately not bounded by "the next `{#if pending…}`": the first
* such marker after the opener is the block's own inner conditional, so that
* boundary silently truncated the slice to the title row and made four
* assertions below pass on absence. A boundary that keys on a NEIGHBOUR — or,
* as there, on a CHILD — is the recurring bug in this shape, so the length is
* asserted at both ends.
*/
const secretBlock = (() => {
	const start = CHATVIEW.indexOf('{#if pendingSecret}');
	expect(start, 'the secret prompt block is gone from ChatView').toBeGreaterThan(-1);
	const rest = CHATVIEW.slice(start);
	const end = rest.indexOf('\n\t{/if}');
	const raw = end === -1 ? rest : rest.slice(0, end);
	// Strip markup comments: this guard measures the TEMPLATE, not prose about it.
	// The block's own comment quotes the old `{pendingSecret.prompt}` title while
	// explaining why it is gone, and an unstripped scan read that quotation as a
	// live occurrence — the guard failing on its own documentation.
	return raw.replace(/<!--[\s\S]*?-->/g, '');
})();

describe('the credential dialog frames the agent, it does not let the agent frame it', () => {
	it('slices only its own block — the whole of it, and no more', () => {
		expect(secretBlock).toContain('data-prompt-kind="secret"');
		// Lower bound: the slice must reach the save button, i.e. the end of the
		// dialog. Without this, a truncated slice makes the assertions below pass
		// by absence — which is exactly what the first version of this file did.
		expect(secretBlock, 'the slice stops before the end of the dialog').toContain(
			`{t('chat.secret_save')}`,
		);
		// Upper bound, keyed on the block's OWN structure rather than on whichever
		// dialog happens to sit next to it: every prompt block carries exactly one
		// `data-pending-prompt`, so two means the slice swallowed a neighbour. A
		// `not.toContain('pendingMailConnect')` goes quietly vacuous the day that
		// block is renamed — the same neighbour-keyed mistake this file's slice
		// comment warns about, one level up.
		expect((secretBlock.match(/data-pending-prompt/g) ?? []).length).toBe(1);
	});

	it('puts a product string in the title slot', () => {
		// The title span: icon row, `text-sm font-medium text-text`.
		expect(secretBlock).toMatch(
			/<span class="text-sm font-medium text-text">\{t\('chat\.secret_title'\)\}<\/span>/,
		);
	});

	it('never renders the agent text in the title slot', () => {
		expect(secretBlock).not.toMatch(
			/<span class="text-sm font-medium text-text">\{pendingSecret\.prompt\}<\/span>/,
		);
	});

	it('renders the agent text only through the cleaned derivation', () => {
		// The block must never reach for the raw string. It renders
		// `secretAgentText`, which is `sanitizeFramingField(...)` computed once so
		// the `{#if}` guard and the render agree on the same value.
		const bareUses = secretBlock.match(/\{pendingSecret\.prompt\b(?![\w.])/g) ?? [];
		expect(bareUses.length, 'agent text is rendered without the framing sanitiser').toBe(0);
		expect(secretBlock).toContain('{secretAgentText}');
		expect(CHATVIEW).toMatch(/const secretAgentText = \$derived\([\s\S]{0,120}sanitizeFramingField\(pendingSecret\.prompt/);
	});

	it('guards the box on the CLEANED text, not the raw string', () => {
		// Guarding on the raw string and rendering the cleaned one opens a box
		// labelled "the assistant's reason" containing nothing, for a prompt that
		// is only zero-width characters. A frame around nothing reads worse than
		// no frame.
		expect(secretBlock).toContain('{#if secretAgentText}');
		expect(secretBlock).not.toContain('{#if pendingSecret.prompt}');
	});

	it('does not size the render cap to the agent span', () => {
		// The tool caps the AGENT's own text at 300 server-side. Everything past
		// that in this string is the engine's "already in the vault" hint, appended
		// after it — so a cap near 300 truncates the one line in the box the agent
		// does not author, and truncates more the more sibling keys exist. The
		// client cap is a backstop for prompts restored from before the server
		// bound, not a second bound on the agent.
		const cap = /sanitizeFramingField\(pendingSecret\.prompt,\s*(\d+)\)/.exec(CHATVIEW)?.[1];
		expect(cap, 'the render no longer caps the agent text at all').toBeDefined();
		expect(Number(cap), 'the cap is small enough to eat the engine hint').toBeGreaterThanOrEqual(1000);
	});

	it('keeps the agent sentence out of the OS notification', () => {
		// The notification is titled with product copy and fires when the tab is
		// hidden — outside the page and outside this frame. Its body must not be
		// the agent's wording for a credential prompt.
		//
		// Pin the BRANCH ORDER, not co-occurrence. The first version matched
		// `'secret'` and `notify_body` within an 80-character window, which the
		// INVERTED ternary also satisfies — `'secret' ? head?.question : notify_body`
		// ships the exact regression this test names and stayed green. A gap wide
		// enough to skip an arm is wide enough to skip the meaning.
		expect(CHATVIEW).toMatch(/head\?\.kind === 'secret'\s*\?\s*t\('attention\.notify_body'\)/);
		expect(CHATVIEW, 'the secret branch reaches for the agent text').not.toMatch(
			/head\?\.kind === 'secret'\s*\?\s*head\?\.question/,
		);
	});

	it('labels the agent text as the assistant’s, inside the muted box', () => {
		expect(secretBlock).toContain(`{t('chat.secret_agent_said')}`);
		expect(secretBlock).toContain('bg-bg-muted');
	});

	it('gives a screen reader the product label alone', () => {
		// The input's accessible name is the same slot in audio. It is the product
		// string and nothing else: welding the agent-CHOSEN key name into the same
		// string with an em dash reproduces the defect one level down —
		// `LYNOX_VERIFIED_ENTER_YOUR_ACCOUNT_PASSWORD` announced as part of our own
		// label. The key name is already on screen in its own element.
		expect(secretBlock).toMatch(/aria-label=\{t\('chat\.secret_title'\)\}/);
		expect(secretBlock).not.toMatch(/aria-label=\{pendingSecret\.prompt/);
		expect(secretBlock).not.toMatch(/aria-label="[^"]*pendingSecret\.name/);
	});

	it('bounds the agent text so it cannot push the controls off screen', () => {
		expect(secretBlock).toMatch(/max-h-\d+ overflow-y-auto/);
		expect(secretBlock).toContain('[overflow-wrap:anywhere]');
	});

	it('ships both languages for every new key', () => {
		// `translations` is module-private, so this reads the table's source. Each
		// key must carry a non-empty de AND en, and they must differ — a key copied
		// from one language into the other is the failure this catches, and it is
		// the one the repo's own i18n rule warns about ("write each language
		// natively … never translate one from the other").
		for (const key of ['chat.secret_title', 'chat.secret_key_label', 'chat.secret_agent_said']) {
			const line = I18N.split('\n').find((l) => l.includes(`'${key}':`));
			expect(line, `${key} is missing from the translation table`).toBeDefined();
			const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(line!)?.[1];
			const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(line!)?.[1];
			expect(de, `${key} has no German`).toBeTruthy();
			expect(en, `${key} has no English`).toBeTruthy();
			expect(de, `${key} is the same string in both languages`).not.toBe(en);
		}
	});
});
