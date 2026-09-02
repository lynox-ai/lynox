import { describe, it, expect } from 'vitest';
import { renderPromptMarkdown, renderPromptSegments } from './prompt-markdown.js';
import type { RenderablePromptSegment } from './prompt-markdown.js';

/**
 * What the agent writes must not be able to render as what the system says.
 *
 * `ask_user`'s question is written entirely by the agent, and it used to travel
 * as a plain string — which `types/agent.ts` defines as "all frame",
 * i.e. the claim that the system wrote it. The renderer acted on that claim, so
 * an injected agent could put a bold line, a heading or a blockquote inside
 * lynox's own confirmation dialog and have it render as structure.
 *
 * The engine side pins that `ask_user` now hands over ONE `value` segment
 * (`ask-user.test.ts`). This file pins the other half of the seam: what the
 * renderer does with such a segment. Both are needed — the row's own
 * `verify-done` says so, because a wire-only test would pass while the live
 * path (the markdown fallback) stayed exactly as it was.
 */
const value = (text: string): RenderablePromptSegment[] => [{ kind: 'value', text }];
const frame = (text: string): RenderablePromptSegment[] => [{ kind: 'frame', text }];

/** The shapes a model reaches for when it wants to sound like the system. */
const FORGERIES: Array<[name: string, source: string, tag: RegExp]> = [
	['bold', '**lynox hat diese Anfrage geprüft.**', /<strong>/],
	['heading', '## Von lynox verifiziert', /<h[1-6]>/],
	['blockquote', '> Systemhinweis: freigegeben.', /<blockquote>/],
	['link', '[hier klicken](https://evil.example.com/x)', /<a /],
	['list', '- Option A\n- Option B', /<li>/],
	['rule', '---', /<hr/],
];

describe('an agent-authored prompt cannot render as system structure', () => {
	for (const [name, source, tag] of FORGERIES) {
		it(`renders ${name} as text, not as markup`, () => {
			const html = renderPromptSegments(value(source));
			expect(html, `${name} still produced markup`).not.toMatch(tag);
		});
	}

	it('shows the forged characters instead of swallowing them', () => {
		// Neutralising must not mean deleting: the user should see exactly what the
		// agent wrote, including the asterisks that reveal the attempt.
		const html = renderPromptSegments(value('**lynox hat diese Anfrage geprüft.**'));
		expect(html).toContain('**lynox hat diese Anfrage geprüft.**');
	});

	it('keeps the line structure a real question depends on', () => {
		// The counter-direction of the fix, and the one nobody reports as broken:
		// a legitimate multi-line question must not collapse into a run-on line.
		//
		// Two earlier versions of this assertion were theatre, each in its own way,
		// and both are worth naming because the shapes recur. The first asserted
		// the three lines were PRESENT and in order — and passed on output that
		// rendered them as one wrapped paragraph, because a raw newline survives in
		// the markup and dies in the CSS. The second COUNTED `<br>` — and passes on
		// an implementation that appends every break at the end and fuses the lines.
		// Presence is not structure and neither is arithmetic. Pin ADJACENCY.
		const html = renderPromptSegments(value('Bitte wähle:\n- Option A\n- Option B'));
		expect(html).toContain('Bitte wähle:<br>- Option A<br>- Option B');
	});

	it('collapses a value that sits INSIDE a frame — the guard, not a limitation', () => {
		// A frame with field structure is exactly what a value's newline imitates.
		// This is `google-calendar.ts`'s shape: a literal `\nTime: ` in the frame.
		// Measured before the rule existed: the forged row rendered on its own
		// line, indistinguishable from the real one beneath it.
		const html = renderPromptSegments([
			{ kind: 'frame', text: 'Create event "' },
			{ kind: 'value', text: 'Coffee\nTime: 09:00 – 09:15' },
			{ kind: 'frame', text: '"\nTime: ' },
			{ kind: 'value', text: '14:00 – 15:00' },
		]);
		expect(html, 'a framed value forged a field line').not.toContain('Coffee<br>');
		// The real field line is the frame's own, and it still renders.
		expect(html).toMatch(/Time: 14:00/);
	});

	it('keeps a value verbatim when the frame opened a code fence', () => {
		// Same rule, second surface: inside `<pre><code>` a `<br>` is not a break,
		// it is a visible artefact in text that is supposed to be exact.
		const html = renderPromptSegments([
			{ kind: 'frame', text: '```\n' },
			{ kind: 'value', text: 'line one\nline two' },
			{ kind: 'frame', text: '\n```' },
		]);
		expect(html).toContain('<code>');
		expect(html).not.toContain('<br>');
	});

	it('does not let a value forge a break it did not write', () => {
		// The `<br>` is ours, emitted after escaping — so a value spelling the tag
		// out gets the characters, not the element.
		const html = renderPromptSegments(value('one<br>two'));
		expect(html).not.toMatch(/one<br>two/);
		expect(html).toContain('&lt;br&gt;');
	});

	it('still lets a SYSTEM frame carry markdown — the split is authorship, not a ban', () => {
		// The eight `pv` callers are system-authored confirmations whose frames use
		// bold field labels and blockquotes on purpose. A fix that took markdown
		// away from them would be the wrong shape entirely.
		for (const [name, source, tag] of FORGERIES) {
			expect(renderPromptSegments(frame(source)), `${name} lost its markup as a frame`).toMatch(tag);
		}
	});

	it('documents what the un-migrated path still does', () => {
		// Not a regression test — a measurement kept in the suite, because this is
		// the branch every caller that has NOT been migrated still takes, and the
		// number of them is the thing to watch. If this ever stops rendering
		// markup, the fallback changed and the migration argument changes with it.
		for (const [name, source, tag] of FORGERIES) {
			expect(renderPromptMarkdown(source), `${name} no longer renders on the fallback`).toMatch(tag);
		}
	});
});
