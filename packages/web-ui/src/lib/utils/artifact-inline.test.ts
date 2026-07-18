import { describe, it, expect } from 'vitest';
import {
	isArtifactContentInline,
	parseArtifactIdFromResult,
	artifactIdMarker,
	extractArtifactId,
	stripArtifactIdMarker,
} from './artifact-inline.js';

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
	// The exact shape artifact_save returns (src/tools/builtin/artifact.ts):
	//   `Saved artifact "Title" (id: <id>, v1).`
	it('pulls the id out of a real save result', () => {
		expect(parseArtifactIdFromResult('Saved artifact "Report" (id: art_9fk2, v1).')).toBe('art_9fk2');
	});

	it('pulls the id out of an UPDATE result (edit case — #14a)', () => {
		expect(parseArtifactIdFromResult('Updated artifact "Report" (id: art_9fk2, v3).')).toBe('art_9fk2');
	});

	it('is empty for a result with no id (error / store-unavailable strings)', () => {
		expect(parseArtifactIdFromResult('Artifact store not available.')).toBe('');
		expect(parseArtifactIdFromResult(undefined)).toBe('');
		expect(parseArtifactIdFromResult('')).toBe('');
	});

	it('does not mis-parse a stray "id:" without the (…, v<n>) shape', () => {
		expect(parseArtifactIdFromResult('the id: is not set')).toBe('');
	});
});

describe('artifact id marker round-trip', () => {
	it('marker written by the writer is read back by the reader', () => {
		const marker = artifactIdMarker('art_9fk2');
		expect(marker).toBe('<!-- id: art_9fk2 -->\n');
		const fence = `<!-- title: Report -->\n${marker}<h1>Hi</h1>`;
		expect(extractArtifactId(fence)).toBe('art_9fk2');
	});

	it('emits no marker (and reads back empty) when there is no id', () => {
		expect(artifactIdMarker('')).toBe('');
		expect(extractArtifactId('<!-- title: Report -->\n<h1>Hi</h1>')).toBe('');
	});

	it('strips the marker so it cannot leak into rendered prose / a data preview', () => {
		const body = `<!-- id: art_9fk2 -->\nname,value\na,1`;
		expect(stripArtifactIdMarker(body)).toBe('name,value\na,1');
		// extractArtifactId still sees it BEFORE the strip
		expect(extractArtifactId(body)).toBe('art_9fk2');
	});

	it('strip is a no-op when no marker is present', () => {
		expect(stripArtifactIdMarker('name,value\na,1')).toBe('name,value\na,1');
	});
});
