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

	it('no template interpolates a tier, effort or thinking field bare', () => {
		// As text only: not an attribute's value (`data-x={r.tier}`) nor a key built in a template
		// literal (`llm.tier.${r.tier}`), which name nothing on screen.
		const bare = /(?<![=$])\{\s*[\w.?!]*\.(?:tier|effort|thinking)\s*\}/g;
		// A workspace's plan tier is a plan, not a model tier, and has no name of its own yet.
		const notAModelTier = new Set(['WorkspaceLimitsView.svelte: {hardLimits.tier}']);
		const found: string[] = [];
		for (const f of files) {
			const src = readFileSync(join(COMPONENTS, f), 'utf-8');
			for (const m of src.matchAll(bare)) if (!notAModelTier.has(`${f}: ${m[0]}`)) found.push(`${f}: ${m[0]}`);
		}
		expect(found).toEqual([]);
		// The controls: the pattern finds the form it is there to keep out, and lets the others pass.
		expect('<span>{child.tier}</span>'.match(bare)).not.toBeNull();
		expect('<span>{step.effort}</span>'.match(bare)).not.toBeNull();
		expect('data-x={r.tier}'.match(bare)).toBeNull();
		expect('`llm.tier.${r.tier}`'.match(bare)).toBeNull();
	});
});
