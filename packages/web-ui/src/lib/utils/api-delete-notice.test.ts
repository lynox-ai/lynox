import { describe, it, expect } from 'vitest';
import { apiDeleteNotice } from './api-delete-notice.js';

const tf = (key: string, vars: Record<string, string>) => `${key}: ${vars['names']}`;

describe('apiDeleteNotice', () => {
	it('says each name the purge left, under the sentence for its list', () => {
		const body = {
			ok: true,
			purge: {
				removed: ['A_ACCESS_TOKEN'],
				kept: ['A_CLIENT_ID', 'A_CLIENT_SECRET'],
				notRemovable: ['A_REFRESH_TOKEN'],
				notVisible: ['A_SCOPED'],
				heldByUnreadable: ['A_WRITTEN'],
				heldBySlotPartner: ['X_Y_ACCESS_TOKEN'],
			},
		};
		expect(apiDeleteNotice(body, tf)).toEqual([
			'apis.delete_left_not_removable: A_REFRESH_TOKEN',
			'apis.delete_left_unreadable: A_WRITTEN',
			'apis.delete_left_slot_partner: X_Y_ACCESS_TOKEN',
			'apis.delete_left_not_visible: A_SCOPED',
			'apis.delete_left_kept: A_CLIENT_ID, A_CLIENT_SECRET',
		]);
	});

	it('says nothing when only removed names, or no purge, came back', () => {
		expect(apiDeleteNotice({ ok: true, purge: { removed: ['A'], kept: [], notRemovable: [], notVisible: [], heldByUnreadable: [], heldBySlotPartner: [] } }, tf)).toEqual([]);
		expect(apiDeleteNotice({ ok: true }, tf)).toEqual([]);
		expect(apiDeleteNotice(null, tf)).toEqual([]);
	});

	it('skips what is not a list of names', () => {
		expect(apiDeleteNotice({ ok: true, purge: { kept: 'A', heldBySlotPartner: [1, '', 'B'] } }, tf)).toEqual(['apis.delete_left_slot_partner: B']);
	});
});
