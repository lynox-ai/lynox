import { describe, it, expect } from 'vitest';
import { authChipLabel } from './api-auth-label.js';

describe('the chip that names how an API profile signs in', () => {
	it('names the built-in provider the engine reports, by the name it reports', () => {
		expect(authChipLabel({ type: 'oauth2' }, 'Shopify')).toEqual({ key: 'apis.auth_signin_via', values: { provider: 'Shopify' } });
		expect(authChipLabel({ type: 'oauth2' }, 'bexio')).toEqual({ key: 'apis.auth_signin_via', values: { provider: 'bexio' } });
	});

	it('an oauth2 profile the engine names no provider for signs in with the provider, unnamed', () => {
		expect(authChipLabel({ type: 'oauth2' }, null)).toEqual({ key: 'apis.auth_signin_provider' });
		expect(authChipLabel({ type: 'oauth2' }, undefined)).toEqual({ key: 'apis.auth_signin_provider' });
		expect(authChipLabel({ type: 'oauth2' }, '')).toEqual({ key: 'apis.auth_signin_provider' });
	});

	it('a token in a header or the query is an API key; basic is a user name and a password', () => {
		for (const type of ['bearer', 'header', 'query']) expect(authChipLabel({ type }, null)).toEqual({ key: 'apis.auth_api_key' });
		expect(authChipLabel({ type: 'basic' }, null)).toEqual({ key: 'apis.auth_basic' });
	});

	it('no sign-in, no auth, or a type the page does not know: no chip, never the raw word', () => {
		expect(authChipLabel({ type: 'none' }, null)).toBeNull();
		expect(authChipLabel(undefined, null)).toBeNull();
		expect(authChipLabel({ type: 'digest' }, null)).toBeNull();
		// A provider name on a profile that is not oauth2 does not make it a provider sign-in.
		expect(authChipLabel({ type: 'bearer' }, 'Shopify')).toEqual({ key: 'apis.auth_api_key' });
	});
});
