import { describe, expect, it } from 'vitest';
import { connectionLine } from './oauth-connection.js';

describe('connectionLine', () => {
	it('shows nothing for a profile that was never connected', () => {
		expect(connectionLine(undefined)).toBeNull();
		expect(connectionLine({})).toBeNull();
	});

	it('names a helper by the address of their access, with the account', () => {
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid', account: { label: 'shop.myshopify.com' } }))
			.toEqual({ by: { kind: 'helper', address: 'helper@example.invalid' }, account: 'shop.myshopify.com', withheld: false });
	});

	it('says the account is unknown when none was recorded', () => {
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid' })?.account).toBeNull();
	});

	it('treats an empty label as no account', () => {
		expect(connectionLine({ connected_by: 'owner', account: { label: '' } })?.account).toBeNull();
	});

	it('reads a connection as yours only when the engine says this reader made it', () => {
		expect(connectionLine({ connected_by: 'owner', connected_by_reader: true })?.by).toEqual({ kind: 'you' });
		expect(connectionLine({ account: { label: 'a@example.invalid' }, connected_by_reader: true })?.by).toEqual({ kind: 'you' });
		// A helper's own connection is theirs too, not their address.
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid', connected_by_reader: true })?.by).toEqual({ kind: 'you' });
	});

	it('reads the owner\'s connection without an account as the owner\'s for anyone else', () => {
		// Nothing was withheld, because there was no account: the tag alone used to read as "you".
		expect(connectionLine({ connected_by: 'owner', connected_by_reader: false })?.by).toEqual({ kind: 'owner' });
		expect(connectionLine({ connected_by: 'owner' })?.by).toEqual({ kind: 'owner' });
		// Only the engine's `true` is the answer; anything else on the wire is not.
		expect(connectionLine({ connected_by: 'owner', connected_by_reader: 'true' })?.by).toEqual({ kind: 'owner' });
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid', connected_by_reader: 1 })?.by).toEqual({ kind: 'helper', address: 'helper@example.invalid' });
	});

	it('says an account the engine left out was withheld, not unknown', () => {
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid', account_withheld: true }))
			.toEqual({ by: { kind: 'helper', address: 'helper@example.invalid' }, account: null, withheld: true });
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid' })?.withheld).toBe(false);
		// Only the engine's `true` is the marker; anything else on the wire is not.
		expect(connectionLine({ connected_by: 'owner', account_withheld: false, account: { label: 'a@example.invalid' }, connected_by_reader: true }))
			.toEqual({ by: { kind: 'you' }, account: 'a@example.invalid', withheld: false });
	});

	it('reads the owner\'s connection as the owner\'s, not yours, when the account was withheld from you', () => {
		expect(connectionLine({ connected_by: 'owner', account_withheld: true })?.by).toEqual({ kind: 'owner' });
		// A grant from before connected_by was recorded is still a connection, and still the owner's.
		expect(connectionLine({ account_withheld: true })).toEqual({ by: { kind: 'owner' }, account: null, withheld: true });
	});

	it('never shows a label beside the withheld marker', () => {
		expect(connectionLine({ connected_by: 'owner', account: { label: 'a@example.invalid' }, account_withheld: true })?.account).toBeNull();
	});

	it('never reads a consent that was not the owner\'s as yours', () => {
		expect(connectionLine({ connected_by: 'cp-admin' })?.by).toEqual({ kind: 'other', tag: 'cp-admin' });
		expect(connectionLine({ connected_by: 'mandate:' })?.by).toEqual({ kind: 'other', tag: 'mandate:' });
	});
});
