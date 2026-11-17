import { describe, expect, it } from 'vitest';
import { isRaisedOpen } from './inbox-raised.js';

describe('isRaisedOpen', () => {
	const raised = { classifierVersion: 'sensitive-follow-up' };
	it('is true for a raised item that is open', () => {
		expect(isRaisedOpen(raised)).toBe(true);
	});
	it('is false once the owner acted on it, snoozed it, or it was never raised', () => {
		expect(isRaisedOpen({ ...raised, userAction: 'archived' })).toBe(false);
		expect(isRaisedOpen({ ...raised, snoozeUntil: new Date(Date.now() + 60_000).toISOString() })).toBe(false);
		expect(isRaisedOpen({ classifierVersion: 'sensitive-follow-up:seen' })).toBe(false);
		expect(isRaisedOpen({ classifierVersion: 'sensitive-prefilter' })).toBe(false);
	});
	it('is true again after a snooze ran out', () => {
		expect(isRaisedOpen({ ...raised, snoozeUntil: new Date(Date.now() - 60_000).toISOString() })).toBe(true);
	});
});
