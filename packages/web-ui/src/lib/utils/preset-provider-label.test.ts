import { describe, it, expect } from 'vitest';
import { presetProviderLabel } from './preset-provider-label.js';

describe('presetProviderLabel', () => {
	it('keeps bexio in lower case, as bexio writes its name', () => {
		expect(presetProviderLabel('bexio')).toBe('bexio');
	});

	it('capitalises any other provider', () => {
		expect(presetProviderLabel('shopify')).toBe('Shopify');
	});
});
