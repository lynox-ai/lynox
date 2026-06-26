import { describe, it, expect } from 'vitest';
import { isArtifactContentInline } from './artifact-inline.js';

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
