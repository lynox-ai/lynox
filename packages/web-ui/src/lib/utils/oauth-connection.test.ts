import { describe, expect, it } from 'vitest';
import { connectionLine } from './oauth-connection.js';

describe('connectionLine', () => {
	it('shows nothing for a profile that was never connected', () => {
		expect(connectionLine(undefined)).toBeNull();
		expect(connectionLine({})).toBeNull();
	});

	it('names a helper by the address of their access, with the account', () => {
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid', account: { label: 'shop.myshopify.com' } }))
			.toEqual({ by: { kind: 'helper', address: 'helper@example.invalid' }, account: 'shop.myshopify.com' });
	});

	it('says the account is unknown when none was recorded', () => {
		expect(connectionLine({ connected_by: 'mandate:helper@example.invalid' })?.account).toBeNull();
	});

	it('reads the owner, and a grant from before it was recorded, as you', () => {
		expect(connectionLine({ connected_by: 'owner' })?.by).toEqual({ kind: 'you' });
		expect(connectionLine({ account: { label: 'a@example.invalid' } })?.by).toEqual({ kind: 'you' });
	});

	it('never reads a consent that was not the owner\'s as yours', () => {
		expect(connectionLine({ connected_by: 'cp-admin' })?.by).toEqual({ kind: 'other', tag: 'cp-admin' });
		expect(connectionLine({ connected_by: 'mandate:' })?.by).toEqual({ kind: 'other', tag: 'mandate:' });
	});
});
