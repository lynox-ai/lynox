import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

// The runs list's narrow line reads „1/3 · <date>“ (U-352). Server output trims whitespace at the
// edges of an element's text, entities included, while the client keeps it: a separator written in
// markup reads „1/3·<date>“ when the list is rendered on the server. jsdom only runs the client
// output, so this compiles the component for the server and reads what it emits.

const source = readFileSync(new URL('./BulkRunsView.svelte', import.meta.url), 'utf8');

describe('the runs list rendered on the server', () => {
	it('emits no separator whose spaces were trimmed', () => {
		const server = compile(source, { generate: 'server', filename: 'BulkRunsView.svelte' }).js.code;
		const client = compile(source, { generate: 'client', filename: 'BulkRunsView.svelte' }).js.code;
		// Control: the client output of the same source compiles and carries the narrow line.
		expect(client).toContain('bulk-run-count-narrow');
		expect(server).toContain('bulk-run-count-narrow');
		expect(server).not.toMatch(/>·</);
	});
});
