import { describe, it, expect } from 'vitest';
import { bulkRuleLinesBelow } from './bulk-runs.js';

// The box under a judged run's rule counts the screen lines that lie below its edge, so the button
// under it can say how many are still to read. A rule can hide its real instruction under empty
// lines or inside one long wrapped line; each screen line it still hides counts.
const line = (top: number, bottom: number): { top: number; bottom: number } => ({ top, bottom });

describe('bulkRuleLinesBelow', () => {
	it('counts every line whose bottom lies below the edge, one cut at the edge included', () => {
		expect(bulkRuleLinesBelow([line(0, 20), line(20, 40), line(40, 60), line(60, 80), line(80, 100)], 90, 20)).toBe(1);
		expect(bulkRuleLinesBelow([line(0, 20), line(20, 40), line(40, 60), line(60, 80)], 90, 20)).toBe(0);
		// Sub-pixel rounding at the edge does not count as a hidden line.
		expect(bulkRuleLinesBelow([line(0, 20), line(70.4, 90.4)], 90, 20)).toBe(0);
	});
	it('counts a long wrapped line with every screen line it still hides, rounded up', () => {
		// One rule line wrapped over 12 screen lines; the box shows 4 of them.
		expect(bulkRuleLinesBelow([line(0, 240)], 80, 20)).toBe(8);
		// Cut through its fifth screen line: that one counts whole.
		expect(bulkRuleLinesBelow([line(0, 240)], 90, 20)).toBe(8);
	});
	it('adds up a long cut line and the short lines below it', () => {
		expect(bulkRuleLinesBelow([line(0, 120), line(120, 140), line(140, 160), line(160, 180)], 80, 20)).toBe(2 + 3);
	});
	it('is zero once the end is in view', () => {
		expect(bulkRuleLinesBelow([line(-400, -380), line(-20, 0), line(0, 20)], 192, 20)).toBe(0);
		expect(bulkRuleLinesBelow([], 192, 20)).toBe(0);
	});
});
