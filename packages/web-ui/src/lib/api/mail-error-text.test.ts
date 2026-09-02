import { describe, expect, it } from 'vitest';
import { friendlyMailError } from './mail-error-text.js';

// Asserted by return value. The predecessor of this file searched the component
// source for the string "465" and was satisfied by a checkbox label 500 lines
// below the advice it claimed to guard — the advice could be emptied entirely
// and the test stayed green.

describe('friendlyMailError — which leg failed changes the advice', () => {
	it('tells an SMTP failure apart from an IMAP one', () => {
		const imap = friendlyMailError('connection_failed', 'raw', { stage: 'imap' });
		const smtp = friendlyMailError('connection_failed', 'raw', { stage: 'smtp' });
		expect(imap).not.toBe(smtp);
		expect(imap).toMatch(/IMAP/);
		expect(smtp).toMatch(/SMTP/);
	});

	it('does not blame the credentials for an SMTP failure — IMAP already accepted them', () => {
		const msg = friendlyMailError('auth_failed', undefined, { stage: 'smtp' });
		expect(msg).toMatch(/accepted your login for reading/);
		expect(msg).toMatch(/separate SMTP password/);
	});

	it('says wait, not regenerate, when the server is throttling', () => {
		// The failure mode this exists for: a 454 "too many login attempts" used to
		// arrive as auth_failed, the user was told to regenerate the app-password,
		// retried, and extended their own lockout.
		const msg = friendlyMailError('rate_limited', undefined, { stage: 'smtp' });
		expect(msg).toMatch(/too many attempts/i);
		expect(msg).toMatch(/will not help/);
		expect(msg).not.toMatch(/re-generate|regenerate/i);
	});
});

describe('friendlyMailError — the 465 advice only reaches people on 465', () => {
	const BLOCKED = /465 is blocked/;

	it('offers the port advice when the form is on 465', () => {
		expect(friendlyMailError('connection_failed', undefined, { stage: 'smtp', smtpPort: 465 })).toMatch(BLOCKED);
		expect(friendlyMailError('timeout', undefined, { stage: 'smtp', smtpPort: 465 })).toMatch(BLOCKED);
	});

	it('withholds it from someone already on 587', () => {
		// Since 587 became the default this is the common case: a typo in the
		// hostname, answered by "switch to the port you are already using".
		const msg = friendlyMailError('connection_failed', undefined, { stage: 'smtp', smtpPort: 587 });
		expect(msg).not.toMatch(BLOCKED);
		expect(msg).toMatch(/Check the hostname and port/);
	});

	it('withholds it on a named preset, where the port is not the user’s to set', () => {
		expect(friendlyMailError('timeout', undefined, { stage: 'smtp' })).not.toMatch(BLOCKED);
	});

	it('never offers it on the IMAP leg, whatever the SMTP port is', () => {
		expect(friendlyMailError('timeout', undefined, { stage: 'imap', smtpPort: 465 })).not.toMatch(BLOCKED);
	});

	it('still names both ports when it does speak, so the advice is actionable', () => {
		const msg = friendlyMailError('timeout', undefined, { stage: 'smtp', smtpPort: 465 });
		expect(msg).toContain('465');
		expect(msg).toContain('587');
	});
});

describe('friendlyMailError — advice a managed tenant cannot act on', () => {
	it('does not tell anyone to disable certificate checking', () => {
		// An earlier draft named LYNOX_MAIL_INSECURE_TLS here. A managed tenant
		// sets no env vars, so it reads as an instruction to lynox ops — to turn
		// verification off for IMAP *and* SMTP across the whole instance, to fix
		// one server. Both legs give the same, role-neutral advice instead.
		for (const stage of ['imap', 'smtp'] as const) {
			const msg = friendlyMailError('tls_failed', undefined, { stage });
			expect(msg).not.toMatch(/LYNOX_MAIL_INSECURE_TLS/);
			expect(msg).toMatch(/contact your admin/);
		}
	});
});

describe('friendlyMailError — the IMAP branch is untouched', () => {
	it('keeps its own wording for every code it handled before', () => {
		expect(friendlyMailError('auth_failed', undefined)).toMatch(/app-password/);
		expect(friendlyMailError('connection_failed', undefined)).toMatch(/IMAP port is open/);
		expect(friendlyMailError('timeout', undefined)).toMatch(/took too long/);
		expect(friendlyMailError('not_found', undefined)).toMatch(/No matching mail server/);
		expect(friendlyMailError('rate_limited', undefined)).toMatch(/Too many test attempts/);
		expect(friendlyMailError('tls_failed', undefined)).toMatch(/certificate/);
	});

	it('falls back to the raw error rather than inventing one', () => {
		expect(friendlyMailError('something_new', 'server said no')).toBe('server said no');
		expect(friendlyMailError(undefined, undefined)).toBe('Unknown error');
		expect(friendlyMailError('something_new', 'server said no', { stage: 'smtp' })).toContain('server said no');
	});
});
