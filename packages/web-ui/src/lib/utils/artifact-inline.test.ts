import { describe, it, expect } from 'vitest';
import {
	isArtifactContentInline,
	parseArtifactIdFromResult,
	artifactIdMarker,
	artifactFenceHeader,
	extractArtifactId,
	stripArtifactIdMarker,
	resolveArtifactRender,
} from './artifact-inline.js';

// The exact multi-line shape artifact_save returns (src/tools/builtin/artifact.ts:52-55).
function saveResult(id: string, title = 'Report', action = 'Saved', v = 1): string {
	return `${action} artifact "${title}" (id: ${id}, v${v}).\nFile: /x/${id}.html`;
}

describe('isArtifactContentInline', () => {
	const html = '<!DOCTYPE html><html><body><h1>Report</h1></body></html>';

	it('is true when the agent already fenced this exact content inline', () => {
		// The prose fence wraps the raw content, so a substring match holds.
		const prose = '```artifact\n<!-- title: Report -->\n' + html + '\n```';
		expect(isArtifactContentInline(html, [prose])).toBe(true);
	});

	it('is false when no prose block contains the content (a plain create)', () => {
		expect(isArtifactContentInline(html, ['Here is your report.'])).toBe(false);
		expect(isArtifactContentInline(html, [])).toBe(false);
	});

	it('is false for an EDIT — new content not present inline (the X2 fix)', () => {
		// Message already shows the OLD artifact inline; the edit supplies NEW
		// content. The coarse "any fence present" guard skipped this; the
		// content-aware check renders the updated card.
		const oldInline = '```artifact\n<!-- title: Report -->\n' + html + '\n```';
		const edited = '<!DOCTYPE html><html><body><h1>Report v2</h1></body></html>';
		expect(isArtifactContentInline(edited, [oldInline])).toBe(false);
	});

	it('ignores surrounding whitespace differences', () => {
		expect(isArtifactContentInline('  ' + html + '  ', [html])).toBe(true);
	});

	it('dedups a prose copy that differs only in internal whitespace / indentation', () => {
		const saved = '<div>\n<p>Hi</p>\n</div>';
		const prettyInProse = 'see below\n```artifact\n<div>\n    <p>Hi</p>\n</div>\n```';
		expect(isArtifactContentInline(saved, [prettyInProse])).toBe(true);
	});

	it('is false for empty / whitespace-only content', () => {
		expect(isArtifactContentInline('', ['anything'])).toBe(false);
		expect(isArtifactContentInline('   ', ['anything'])).toBe(false);
	});
});

describe('parseArtifactIdFromResult', () => {
	// Fresh ids are randomUUID().slice(0,8) — 8 hex chars (artifact-store.ts:257).
	it('pulls the id out of a real (multi-line) save result', () => {
		expect(parseArtifactIdFromResult(saveResult('3f9a1c07'))).toBe('3f9a1c07');
	});

	it('pulls the id out of an UPDATE result (edit case — #14a)', () => {
		expect(parseArtifactIdFromResult(saveResult('3f9a1c07', 'Report', 'Updated', 3))).toBe('3f9a1c07');
	});

	it('does NOT take an id echoed inside the TITLE — the real id is at line end', () => {
		// Title-injection guard: a title containing "(id: evil, v1)" precedes the
		// real trailing id on the first line; first-match would return "evil".
		expect(parseArtifactIdFromResult(saveResult('3f9a1c07', 'x (id: evil, v9)'))).toBe('3f9a1c07');
	});

	it('is empty for a result with no id (error / store-unavailable strings)', () => {
		expect(parseArtifactIdFromResult('Artifact store not available.')).toBe('');
		expect(parseArtifactIdFromResult(undefined)).toBe('');
		expect(parseArtifactIdFromResult('')).toBe('');
	});

	it('does not mis-parse a stray "id:" without the (…, v<n>). shape', () => {
		expect(parseArtifactIdFromResult('the id: is not set')).toBe('');
	});
});

describe('artifact fence header ↔ render round-trip', () => {
	// Drives the ACTUAL writer (ChatView calls artifactFenceHeader) and reader
	// (MarkdownRenderer calls resolveArtifactRender) — not the low-level helpers
	// in isolation. Reverting the strip in the reader fails these.
	it('writer emits the id; reader extracts it and strips it from the body', () => {
		const header = artifactFenceHeader({ title: 'Report', type: 'html', id: '3f9a1c07', typed: false });
		const fence = header + '<h1>Hi</h1>';
		const { artifactId, src } = resolveArtifactRender(fence);
		expect(artifactId).toBe('3f9a1c07');
		expect(src).not.toContain('lynox-artifact-id'); // marker must NOT leak into render
		expect(src).toContain('<!-- title: Report -->');
		expect(src).toContain('<h1>Hi</h1>');
	});

	it('typed fence keeps the type marker but drops the id marker', () => {
		const header = artifactFenceHeader({ title: 'Data', type: 'csv', id: '3f9a1c07', typed: true });
		const { artifactId, src } = resolveArtifactRender(header + 'a,b\n1,2');
		expect(artifactId).toBe('3f9a1c07');
		expect(src).toContain('<!-- type: csv -->');
		expect(src).not.toContain('lynox-artifact-id');
	});

	it('no id → no marker, reader returns the body unchanged and empty id', () => {
		const header = artifactFenceHeader({ title: 'Report', type: 'html', id: '', typed: false });
		expect(artifactIdMarker('')).toBe('');
		const fence = header + '<h1>Hi</h1>';
		const { artifactId, src } = resolveArtifactRender(fence);
		expect(artifactId).toBe('');
		expect(src).toBe(fence);
	});

	it('does NOT treat an ordinary <!-- id: … --> comment in agent content as a gallery id', () => {
		// The collision the namespaced marker fixes: an agent-authored html fence
		// whose content has a plain HTML comment must render untouched.
		const fence = '<div>\n<!-- id: main-header -->\n<h1>Hi</h1>\n</div>';
		const { artifactId, src } = resolveArtifactRender(fence);
		expect(artifactId).toBe('');
		expect(src).toBe(fence); // comment preserved, nothing stripped
	});
});
