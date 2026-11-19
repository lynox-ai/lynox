import { describe, it, expect } from 'vitest';
import { keptParamValues, paramAllowed } from './workflow-param-allowed.js';

const contract = {
	paramConstraints: {
		region: { enum: ['ch', 'de', 7, Infinity, null, { x: 1 }] },
		count: { min: 1, max: 10 },
		odd: { min: '1', max: Number.NaN },
	},
};

describe('what the run form shows a parameter may take', () => {
	it('gives the owner the allowed values as text and the finite bounds', () => {
		expect(paramAllowed(contract, 'region', true)).toEqual({ values: ['ch', 'de', '7'] });
		expect(paramAllowed(contract, 'count', true)).toEqual({ min: 1, max: 10 });
	});

	it('offers each value once, though the contract lists it twice', () => {
		expect(paramAllowed({ paramConstraints: { r: { enum: ['7', 7, 'ch', 'ch'] } } }, 'r', true)).toEqual({ values: ['7', 'ch'] });
	});

	it('gives anyone who is not the owner nothing, though the contract holds it', () => {
		expect(paramAllowed(contract, 'region', false)).toBeNull();
		expect(paramAllowed(contract, 'count', false)).toBeNull();
	});

	it('gives nothing for a parameter the contract does not constrain, a bound that is no finite number, or no contract', () => {
		expect(paramAllowed(contract, 'other', true)).toBeNull();
		expect(paramAllowed(contract, 'odd', true)).toBeNull();
		expect(paramAllowed(undefined, 'region', true)).toBeNull();
		expect(paramAllowed({ paramConstraints: null }, 'region', true)).toBeNull();
		// Only the contract's own keys: an inherited name reads nothing.
		expect(paramAllowed(contract, 'constructor', true)).toBeNull();
		expect(paramAllowed(contract, '__proto__', true)).toBeNull();
		const inherited = { paramConstraints: Object.create({ region: { enum: ['x'] } }) as object };
		expect(paramAllowed(inherited, 'region', true)).toBeNull();
	});
});

describe('the values a form keeps when it opens again', () => {
	const params = [{ name: 'region' }, { name: 'note' }];
	const contract = { paramConstraints: { region: { enum: ['ch', 'de'] } } };

	it('keeps a value the contract still allows, and free text as typed', () => {
		expect(keptParamValues(params, { region: 'de', note: 'hi' }, contract, true)).toEqual({ region: 'de', note: 'hi' });
	});

	it('drops a value the fresh contract no longer allows, so the form asks again', () => {
		expect(keptParamValues(params, { region: 'at', note: 'hi' }, contract, true)).toEqual({ region: '', note: 'hi' });
	});

	it('starts a parameter that is new with nothing', () => {
		expect(keptParamValues(params, { region: 'ch' }, contract, true)).toEqual({ region: 'ch', note: '' });
	});
});
