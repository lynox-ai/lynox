import { describe, it, expect } from 'vitest';
import { authChipLabel } from './api-auth-label.js';

describe('the chip that names how an API profile signs in', () => {
	it('names a built-in provider by its display name, not its preset id', () => {
		expect(authChipLabel({ type: 'oauth2', oauth: { preset_id: 'shopify' } })).toEqual({ key: 'apis.auth_signin_via', values: { provider: 'Shopify' } });
		expect(authChipLabel({ type: 'oauth2', oauth: { preset_id: 'bexio' } })).toEqual({ key: 'apis.auth_signin_via', values: { provider: 'bexio' } });
	});

	it('an oauth2 profile without a provider signs in with the provider, unnamed', () => {
		expect(authChipLabel({ type: 'oauth2' })).toEqual({ key: 'apis.auth_signin_provider' });
		expect(authChipLabel({ type: 'oauth2', oauth: {} })).toEqual({ key: 'apis.auth_signin_provider' });
		expect(authChipLabel({ type: 'oauth2', oauth: { preset_id: '' } })).toEqual({ key: 'apis.auth_signin_provider' });
	});

	it('a token in a header or the query is an API key; basic is a user name and a password', () => {
		for (const type of ['bearer', 'header', 'query']) expect(authChipLabel({ type })).toEqual({ key: 'apis.auth_api_key' });
		expect(authChipLabel({ type: 'basic' })).toEqual({ key: 'apis.auth_basic' });
	});

	it('no sign-in, no auth, or a type the page does not know: no chip, never the raw word', () => {
		expect(authChipLabel({ type: 'none' })).toBeNull();
		expect(authChipLabel(undefined)).toBeNull();
		expect(authChipLabel({ type: 'digest' })).toBeNull();
		// A preset on a profile that is not oauth2 does not make it a provider sign-in.
		expect(authChipLabel({ type: 'bearer', oauth: { preset_id: 'shopify' } })).toEqual({ key: 'apis.auth_api_key' });
	});
});
