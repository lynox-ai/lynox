import { describe, it, expect } from 'vitest';
import { recordRowSummary } from './footprint.js';

describe('recordRowSummary', () => {
	it('joins the first user columns as key: value, dropping system columns', () => {
		const row = { _id: 1, _created_at: 'x', _updated_at: 'y', amount: 8900, status: 'offen', invoice_date: '2026-05-03' };
		expect(recordRowSummary(row)).toBe('amount: 8900 · status: offen · invoice_date: 2026-05-03');
	});

	it('skips the subject column(s) that link the viewed subject — no redundant self-id', () => {
		const row = { amount: 8900, status: 'offen', client: 'e414867e-uuid', invoice_date: '2026-05-03' };
		expect(recordRowSummary(row, ['client'])).toBe('amount: 8900 · status: offen · invoice_date: 2026-05-03');
	});

	it('skipping a column makes room for a later one within the 4-cap', () => {
		const row = { a: 1, b: 2, client: 'uuid', c: 3, d: 4 };
		expect(recordRowSummary(row, ['client'])).toBe('a: 1 · b: 2 · c: 3 · d: 4');
	});

	it('caps at 4 columns and truncates long values', () => {
		expect(recordRowSummary({ a: 1, b: 2, c: 3, d: 4, e: 5 })).toBe('a: 1 · b: 2 · c: 3 · d: 4');
		expect(recordRowSummary({ note: 'x'.repeat(60) })).toBe('note: ' + 'x'.repeat(39) + '…');
	});

	it('renders null/undefined as an em dash', () => {
		expect(recordRowSummary({ amount: null, status: undefined })).toBe('amount: — · status: —');
	});
});
