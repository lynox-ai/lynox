import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A trigger that waits for a person's confirmation has to look different from
 * one that runs, the view has to offer the confirmation, and what it shows
 * beside that button has to be what the run would actually do.
 *
 * Before this, the view declared neither `confirmed_at` nor any call to
 * `POST /api/tasks/:id/confirm`: a waiting trigger rendered exactly like a
 * working one, next to a next-run date that never came. Which triggers wait is
 * decided by `awaitsConfirmation`, and `trigger-consent.test.ts` holds that
 * against the scheduler. This file holds the view to it.
 *
 * There is no component renderer in this package's tests, so, as in
 * `secret-prompt-frame.test.ts`, the assertions read SOURCE. An adversarial
 * round showed what that costs when they read it loosely: with `[^>]*` standing
 * in for a tag's attributes, the Confirm button could be given `class="hidden"`,
 * or `disabled={true}`, or lose its `aria-label`, and every assertion stayed
 * green. So the elements that carry the consent are compared WHOLE — the same
 * reason a rarely-changed artefact is pinned whole elsewhere: an attribute no
 * assertion happens to mention is exactly where a regression hides.
 */
const VIEW = readFileSync(fileURLToPath(new URL('./TriggersView.svelte', import.meta.url)), 'utf-8');
const SCRIPT_END = VIEW.indexOf('</script>');
const SCRIPT = VIEW.slice(0, SCRIPT_END);
const TEMPLATE = VIEW.slice(SCRIPT_END).replace(/<!--[\s\S]*?-->/g, '');
// The owner's confirm lives in `StampConfirm` since 641 4b (ii-a): it shows the schedule from the
// stamp preview and confirms with its digest. Its behaviour is rendered in
// `triggersview-stamp.svelte.test.ts`; what is held here is that it is the ONE confirm.
const STAMP = readFileSync(fileURLToPath(new URL('./StampConfirm.svelte', import.meta.url)), 'utf-8');
const STAMP_TEMPLATE = STAMP.slice(STAMP.indexOf('</script>')).replace(/<!--[\s\S]*?-->/g, '');

/** The body of `{#if <cond>}` that opens on the line holding `marker`, up to its own `{/if}` at the same indent. */
function ifBlockAround(marker: string): { cond: string; body: string } {
	const at = TEMPLATE.indexOf(marker);
	expect(at, `${marker} is gone from TriggersView`).toBeGreaterThan(-1);
	// Uniqueness, because every assertion below reads the FIRST match: a second
	// Confirm button appended beside the gated one passed this whole file once.
	expect(TEMPLATE.indexOf(marker, at + 1), `${marker} appears more than once`).toBe(-1);
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

/** One line of the template, trimmed — the unit the whole-tag comparisons below use. */
function line(contains: string): string {
	const at = TEMPLATE.indexOf(contains);
	expect(at, `${contains} is gone from TriggersView`).toBeGreaterThan(-1);
	expect(TEMPLATE.indexOf(contains, at + 1), `${contains} appears more than once`).toBe(-1);
	const start = TEMPLATE.lastIndexOf('\n', at) + 1;
	const end = TEMPLATE.indexOf('\n', at);
	return TEMPLATE.slice(start, end === -1 ? undefined : end).trim();
}

describe('the triggers view shows the waiting state and offers the confirmation', () => {
	it('uses the tested helpers, not local copies of the rules', () => {
		// Every decision this block makes — who waits, what the run is told, which
		// page a watch reads, what is safe to render — lives in a module with
		// behaviour tests. A copy in the component would be a second rule with no
		// test, and the source assertions here cannot see what a copy does.
		expect(SCRIPT).toContain(
			"import { awaitsConfirmation, displaySafe, instructionOf, showsInstruction, showsWatchTarget, watchOf } from '../utils/trigger-consent.js';",
		);
		expect(SCRIPT).toContain("import { awaitsOwnerStamp, listedLine, listedNote, stampable, usesConnections, type StampListed } from '../utils/stamp-confirm.js';");
		for (const name of ['awaitsConfirmation', 'displaySafe', 'instructionOf', 'showsInstruction', 'showsWatchTarget', 'watchOf', 'awaitsOwnerStamp', 'listedLine', 'listedNote', 'stampable', 'usesConnections']) {
			expect(SCRIPT, name).not.toMatch(new RegExp(`function\\s+${name}|${name}\\s*=`));
		}
		// Who waits is the two tested rules together, nothing besides: an agent run nobody confirmed,
		// and anything a mandate set up or last changed (engine `mandateNeedsOwnerStamp`).
		const held = SCRIPT.slice(SCRIPT.indexOf('function held('), SCRIPT.indexOf('\n\t}', SCRIPT.indexOf('function held(')));
		expect(held.split('\n').map((l) => l.trim()).slice(1).join(' ')).toBe('return awaitsConfirmation(trigger) || awaitsOwnerStamp(trigger);');
	});

	it('a waiting trigger carries its own badge, whole', () => {
		const { cond, body } = ifBlockAround("t('triggers.awaiting_confirmation')");
		expect(cond).toBe('held(trigger)');
		expect(body.trim()).toBe(
			'<span class="shrink-0 text-[10px] rounded-[var(--radius-sm)] bg-warning/15 px-1.5 py-0.5 text-warning" data-trigger-held>'
			+ "{t('triggers.awaiting_confirmation')}</span>",
		);
	});

	it('says nothing about WHEN the run comes', () => {
		// Two earlier versions did, and both spoke for reasons consent does not
		// settle. The scheduler's answer is not this block's to give. (`StampConfirm` shows the
		// schedule's cron, because the stamp holds it; never a next run.)
		const { body } = ifBlockAround('data-trigger-consent');
		expect(body).not.toMatch(/next_run_at|fmtDate|schedule_cron/);
		expect(STAMP).not.toMatch(/next_run_at|fmtDate/);
	});

	it('the consent block is compared WHOLE — nothing may be added to it', () => {
		// Every assertion in this file named elements it expected, so anything ADDED
		// passed: a `<div class="hidden">` wrapped around the watch box, a second
		// raw `<p>` beside the address, the cadence moved out of its gate. Each was
		// measured green. Naming more elements buys one more round; comparing the
		// artefact whole ends the class — this block is small, it is ours, and it
		// changes once a quarter, which is exactly when a whole comparison is the
		// right instrument. It subsumes what several separate assertions used to
		// state — the root element, the button's attributes and order, the labels,
		// the absence of a link or a raw `{trigger.x}` — because none of those can
		// change without changing the shape. Two instruments for one question is one
		// too many to keep in step.
		const { body } = ifBlockAround('data-trigger-consent');
		const shape = body.split('\n').map((l) => l.trim()).filter((l) => l !== '').join('\n');
		expect(shape).toBe([
			'<div class="mt-2 space-y-1.5" data-trigger-consent>',
			`<p class="text-xs text-warning">{t('triggers.awaiting_hint')}</p>`,
			'{#if ownerStamps(trigger)}',
			'<StampConfirm id={trigger.id} mode="held" cronText={cronToHuman} onstamped={() => void stamped(trigger)} />',
			'{:else if showsInstruction(trigger)}',
			'<div class="text-xs text-text-muted" data-consent-instruction>',
			`<span class="font-medium" data-consent-label="instruction">{t('triggers.instruction')}:</span>`,
			'<p class="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">{displaySafe(instructionOf(trigger))}</p>',
			'</div>',
			'{/if}',
			'{#if !ownerStamps(trigger) && showsWatchTarget(trigger)}',
			'<div class="text-xs text-text-muted" data-consent-watch>',
			`<span class="font-medium" data-consent-label="watch">{t('triggers.watch_url')}:</span>`,
			'<p class="mt-0.5 break-words rounded-[var(--radius-sm)] border border-border bg-bg px-2 py-1.5">'
				+ `<span class="font-medium text-text">{watchOf(trigger)?.host ?? ''}</span>{watchOf(trigger)?.rest ?? ''}</p>`,
			'{#if watchOf(trigger)?.intervalMinutes}',
			`<p class="mt-0.5" data-consent-cadence>{tf('triggers.watch_every', { minutes: String(watchOf(trigger)?.intervalMinutes) })}</p>`,
			'{/if}',
			'</div>',
			'{/if}',
			'</div>',
		].join('\n'));
	});

	it('confirming sends the preview\'s digest to the confirm route, and reports what it did', () => {
		const start = STAMP.indexOf('async function confirm(');
		expect(start, 'confirm is gone from StampConfirm').toBeGreaterThan(-1);
		const fn = STAMP.slice(start, STAMP.indexOf('\n\t}', start));
		expect(fn).toContain("fetch(`${getApiBase()}/tasks/${encodeURIComponent(id)}/confirm`, {");
		expect(fn).toContain("method: 'POST'");
		expect(fn).toContain('body: JSON.stringify({ expect: shown.expect })');
		// The message may not claim a schedule the scheduler does not honour.
		expect(fn).toContain("addToast(t('triggers.confirmed'), 'success')");
		expect(fn).toContain("addToast(t('triggers.confirm_failed'), 'error')");
	});

	it('a waiting trigger shows no next-run label and no run-now', () => {
		const next = ifBlockAround("t('tasks.next_run')");
		// The whole condition, not `toContain`: an `|| true` appended to it leaves the
		// expected text in place and puts the date back on a waiting trigger.
		expect(next.cond).toBe('trigger.next_run_at && trigger.enabled !== 0 && !held(trigger) && trigger.paused !== true');
		const run = ifBlockAround('runNow(trigger)');
		expect(run.cond).toBe('!held(trigger)');
		expect(run.body.trim().startsWith('<button onclick={() => runNow(trigger)}')).toBe(true);
	});

	it('there is exactly ONE Confirm button in the whole view', () => {
		// Not a style rule: a second one, appended inside the block behind
		// `{#if !showsInstruction(trigger)}`, gives a watch the button that the gate
		// exists to withhold — and every "pinned whole" assertion here reads the
		// first match, so it went green.
		// Since 641 4b (ii-a) the view itself has none; `StampConfirm` has the one.
		expect(TEMPLATE.split("t('triggers.confirm')")).toHaveLength(1);
		expect(STAMP_TEMPLATE.split("t('triggers.confirm')")).toHaveLength(2);
		expect(STAMP_TEMPLATE.split('confirm()')).toHaveLength(2);
	});

	it('the card stacks below `sm`, which is what makes the instruction readable there', () => {
		// The commit that added this said the tests pinned it; they did not, and all
		// three class changes reverted green. The controls are ~290px on a ~310px
		// card, so side by side left the text column a few pixels and the title —
		// `line-clamp`, so `overflow: hidden` — collapsed to nothing.
		expect(line('<div class="flex flex-col gap-2 sm:flex-row')).toBe(
			'<div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">',
		);
		expect(line('<div class="flex flex-wrap items-center gap-2 sm:shrink-0')).toBe(
			'<div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:mt-0.5">',
		);
		// …and the badges wrap instead of squeezing the title out of its own row.
		expect(line('<div class="flex flex-wrap items-center gap-x-2 gap-y-1">')).toBe(
			'<div class="flex flex-wrap items-center gap-x-2 gap-y-1">',
		);
	});

	it('the controls hide on hover-capable pointers, not at a width', () => {
		// A touch screen wider than `sm` has no hover either: keyed on the width, the
		// controls were unreachable there with no rule left to bring them back.
		for (const control of ['runNow(trigger)', 'togglePause(trigger)', 'manageInChat(trigger)', 'deleteTrigger(trigger)']) {
			const tag = line(`<button onclick={() => ${control}}`);
			expect(tag, control).toContain('[@media(hover:hover)]:opacity-0');
			expect(tag, control).toContain('group-hover:opacity-100');
			// Any width-keyed hide, not just the one that was there: `md:opacity-0`
			// beside the pointer rule passed, and reintroduces the same dead end on a
			// touch screen wider than that breakpoint.
			expect(tag, control).not.toMatch(/(sm|md|lg|xl|2xl):opacity-0/);
		}
	});
});
