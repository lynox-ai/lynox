import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A trigger that waits for a person's confirmation has to look different from
 * one that runs, and the view has to offer the confirmation.
 *
 * Before this, the view declared neither `confirmed_at` nor any call to
 * `POST /api/tasks/:id/confirm`: a waiting trigger rendered exactly like a
 * working one, next to a next-run date that never came. Which triggers wait is
 * decided by `awaitsConfirmation`, and `trigger-consent.test.ts` holds that
 * against the scheduler. This file holds the view to it.
 *
 * There is no component renderer in this package's tests, so, as in
 * `secret-prompt-frame.test.ts`, the assertions pin STRUCTURE: which expression
 * gates which element. Markup comments are stripped first — the template's own
 * comments name the things asserted on here.
 */
const VIEW = readFileSync(fileURLToPath(new URL('./TriggersView.svelte', import.meta.url)), 'utf-8');
const SCRIPT_END = VIEW.indexOf('</script>');
const SCRIPT = VIEW.slice(0, SCRIPT_END);
const TEMPLATE = VIEW.slice(SCRIPT_END).replace(/<!--[\s\S]*?-->/g, '');

/** The body of `{#if <cond>}` that opens on the line holding `marker`, up to its own `{/if}` at the same indent. */
function ifBlockAround(marker: string): { cond: string; body: string } {
	const at = TEMPLATE.indexOf(marker);
	expect(at, `${marker} is gone from TriggersView`).toBeGreaterThan(-1);
	const open = TEMPLATE.lastIndexOf('{#if ', at);
	expect(open, `no {#if} before ${marker}`).toBeGreaterThan(-1);
	const lineStart = TEMPLATE.lastIndexOf('\n', open) + 1;
	const indent = TEMPLATE.slice(lineStart, open);
	expect(indent, 'the {#if} must start its own line').toMatch(/^\t*$/);
	const condEnd = TEMPLATE.indexOf('}', open);
	const close = TEMPLATE.indexOf(`\n${indent}{/if}`, open);
	expect(close, `the {#if} around ${marker} is never closed at its own indent`).toBeGreaterThan(at);
	return { cond: TEMPLATE.slice(open + '{#if '.length, condEnd), body: TEMPLATE.slice(condEnd + 1, close) };
}

describe('the triggers view shows the waiting state and offers the confirmation', () => {
	it('uses the tested predicate, not a local copy of the rule', () => {
		expect(SCRIPT).toContain("import { awaitsConfirmation } from '../utils/trigger-consent.js';");
		expect(SCRIPT).not.toMatch(/function\s+awaitsConfirmation|awaitsConfirmation\s*=/);
	});

	it('a waiting trigger carries its own badge', () => {
		const { cond, body } = ifBlockAround("t('triggers.awaiting_confirmation')");
		expect(cond).toBe('awaitsConfirmation(trigger)');
		expect(body.trim()).toMatch(/^<span[^>]*>\{t\('triggers\.awaiting_confirmation'\)\}<\/span>$/);
	});

	it('the consent block is gated on exactly the predicate, and its button confirms', () => {
		const { cond, body } = ifBlockAround('data-trigger-consent');
		expect(cond).toBe('awaitsConfirmation(trigger)');
		// Both ends of the slice: it starts at the block's own element and reaches
		// its button, so the assertions below cannot pass on a truncated slice.
		expect(body.trim().startsWith('<div')).toBe(true);
		expect(body).toMatch(/<button onclick=\{\(\) => confirmTrigger\(trigger\)\}[^>]*>\{t\('triggers\.confirm'\)\}<\/button>/);
	});

	it('the consent block shows the instruction being confirmed, as text', () => {
		const { body } = ifBlockAround('data-trigger-consent');
		expect(body).toContain('{trigger.description}');
		expect(body).not.toContain('{@html');
		// Shown whenever it adds to the title — the same test the engine uses to
		// decide whether the description goes into the run's task text.
		const { cond } = ifBlockAround('{trigger.description}');
		expect(cond).toBe('trigger.description && trigger.description.trim() !== trigger.title.trim()');
	});

	it('confirming calls the existing confirm route with POST', () => {
		const start = SCRIPT.indexOf('async function confirmTrigger(');
		expect(start, 'confirmTrigger is gone').toBeGreaterThan(-1);
		const fn = SCRIPT.slice(start, SCRIPT.indexOf('\n\t}', start));
		expect(fn).toContain("fetch(`${getApiBase()}/tasks/${trigger.id}/confirm`, { method: 'POST' })");
		expect(fn).toContain('await loadTriggers()');
	});

	it('a waiting trigger shows no next run and no run-now', () => {
		const next = ifBlockAround("t('tasks.next_run')");
		expect(next.cond).toContain('!awaitsConfirmation(trigger)');
		const run = ifBlockAround('runNow(trigger)');
		expect(run.cond).toBe('!awaitsConfirmation(trigger)');
		expect(run.body.trim().startsWith('<button onclick={() => runNow(trigger)}')).toBe(true);
	});
});
