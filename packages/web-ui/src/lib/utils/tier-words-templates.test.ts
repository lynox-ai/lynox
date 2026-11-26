import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// A tier, a thoroughness and a thinking setting are shown by their names (`tier-words.ts`, U-477),
// never as the stored value. There is no layout or locale question here, only the templates.

describe('no view prints a stored tier, thoroughness or thinking value as text', () => {
	const COMPONENTS = fileURLToPath(new URL('../components/', import.meta.url));
	const files = readdirSync(COMPONENTS).filter((f) => f.endsWith('.svelte'));

	it('reads the components it checks', () => {
		// A positive control: an empty list would pass the check below on nothing.
		expect(files.length).toBeGreaterThan(50);
		expect(files).toContain('StampPreviewBody.svelte');
	});

	// Every text interpolation (not an attribute's value, not a block's condition, not a key built in
	// a template literal) that reads a tier, thoroughness, thinking or step model field.
	function fieldReads(src: string): string[] {
		const reads: string[] = [];
		// The markup only: a component's script and style are not shown.
		const markup = src.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '');
		for (const m of markup.matchAll(/(?<![=$])\{([^{}]*)\}/g)) {
			const expr = m[1]!.trim();
			if (/^[#:/@]/.test(expr) && !expr.startsWith('@render')) continue;
			// A key or a text in quotes names no field (`t('workflow_library.stamp.model')`).
			const code = expr.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''");
			if (/\.(?:tier|effort|thinking|model_tier|model)\b/.test(code)) reads.push(expr);
		}
		return reads;
	}
	// Named: through the names (`tier-words.ts`), or a settings key for a tier, or the stamp's snippet.
	const named = (expr: string): boolean => /\b(?:tierName|effortName|thinkingName)\(|llm\.tier\.|modelValue\(/.test(expr);
	// A field that holds a resolved model id, never a tier, or a plan's tier that is not a model tier.
	// `msg.thinking` is the text a model thought, not a thinking setting.
	const notATier = new Set(['ChatView.svelte: child.model', 'WorkspaceLimitsView.svelte: hardLimits.tier', "ChatView.svelte: maskText(msg.thinking ?? '')"]);

	it('no template shows a stored tier, thoroughness, thinking or step model without its name', () => {
		const found: string[] = [];
		for (const f of files) {
			for (const expr of fieldReads(readFileSync(join(COMPONENTS, f), 'utf-8'))) {
				if (!named(expr) && !notATier.has(`${f}: ${expr}`)) found.push(`${f}: ${expr}`);
			}
		}
		expect(found).toEqual([]);
		// A positive control on the real files: the reads it judged include the named ones it must see.
		const stamp = fieldReads(readFileSync(join(COMPONENTS, 'StampPreviewBody.svelte'), 'utf-8'));
		expect(stamp).toContain('@render modelValue(step.model)');
		expect(stamp).toContain('effortName(step.effort)');
		expect(fieldReads(readFileSync(join(COMPONENTS, 'StampConfirm.svelte'), 'utf-8'))).toContain('tierName(s.model_tier) ?? markHidden(s.model_tier)');
	});

	it('the check finds the forms it keeps out and lets the named ones pass', () => {
		// The controls: each form a fix replaced is found, each named one and each attribute is not.
		for (const raw of ['<span>{child.tier}</span>', '<span>{step.effort}</span>', '{markHidden(s.model_tier)}', '<span>{mStep.model}</span>', '<span>{visible(step.model)}</span>']) {
			const reads = fieldReads(raw);
			expect(reads, raw).toHaveLength(1);
			expect(named(reads[0]!), raw).toBe(false);
		}
		for (const ok of ['{tierName(child.tier) ?? child.tier}', '{effortName(step.effort)}', '{@render modelValue(step.model)}']) {
			const reads = fieldReads(ok);
			expect(reads, ok).toHaveLength(1);
			expect(named(reads[0]!), ok).toBe(true);
		}
		// Out of its reach, said so: an interpolation with a brace inside (a template literal's
		// `${…}`, an object) is not read; the settings' keys built that way name nothing raw today.
		expect(fieldReads("{t(`llm.tier.${tier.tier}`)}")).toEqual([]);
		expect(fieldReads('data-x={r.tier}')).toEqual([]);
		expect(fieldReads('{#if child.tier}')).toEqual([]);
	});
});
