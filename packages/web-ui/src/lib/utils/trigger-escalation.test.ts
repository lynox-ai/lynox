import { describe, it, expect } from 'vitest';
import { escalationNotice } from './trigger-escalation.js';

const AT = '2026-10-09T08:00:00.000Z';

describe('escalationNotice', () => {
	it('says delivered without a warning', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'delivered' }))
			.toEqual({ key: 'triggers.escalation_delivered', warn: false, at: AT });
	});

	it('warns when nobody was reached, and names a missing channel apart from a failed one', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered' }))
			.toEqual({ key: 'triggers.escalation_not_delivered', warn: true, at: AT });
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'no_channel' }))
			.toEqual({ key: 'triggers.escalation_no_channel', warn: true, at: AT });
	});

	it('warns while an escalation has started and no channel has answered', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'unconfirmed' }))
			.toEqual({ key: 'triggers.escalation_unconfirmed', warn: true, at: AT });
	});

	it('says nothing for a trigger that never escalated', () => {
		expect(escalationNotice({})).toBeNull();
		expect(escalationNotice({ last_escalation_at: null, last_escalation_outcome: null })).toBeNull();
	});

	it('says nothing for a value the engine does not write, rather than guessing', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'maybe' })).toBeNull();
		expect(escalationNotice({ last_escalation_at: AT })).toBeNull();
		expect(escalationNotice({ last_escalation_outcome: 'delivered' })).toBeNull();
		// A record without a usable start time is not a record: no date to show beside it.
		expect(escalationNotice({ last_escalation_at: null, last_escalation_outcome: 'delivered' })).toBeNull();
		expect(escalationNotice({ last_escalation_at: '', last_escalation_outcome: 'delivered' })).toBeNull();
	});
});
