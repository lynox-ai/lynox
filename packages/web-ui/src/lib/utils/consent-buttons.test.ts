import { describe, it, expect } from 'vitest';
import { CONSENT_KEYS, type ConsentAction } from '../contract/prompt.js';
import { consentButtons, isToolConsent, type ToolConsentKind } from './consent-buttons.js';

const TOOL_KINDS: readonly ToolConsentKind[] = ['send', 'google', 'merge', 'apply', 'retire', 'plan'];
const ACTIONS: readonly ConsentAction[] = ['upload', 'create', 'move', 'share', 'overwrite', 'append', 'format', 'update', 'delete'];

describe('a tool confirmation\'s buttons', () => {
	it('send exactly the kind\'s keys, in their order', () => {
		for (const kind of TOOL_KINDS) {
			expect(consentButtons(kind).map((b) => b.key), kind).toEqual([...CONSENT_KEYS[kind]]);
		}
		for (const action of ACTIONS) expect(consentButtons('google', action).map((b) => b.key)).toEqual(['confirm', 'cancel']);
	});

	it('name a Google write by its action, and fall back to a plain confirm', () => {
		for (const action of ACTIONS) expect(consentButtons('google', action)[0]!.label).toBe(`chat.consent.action.${action}`);
		expect(consentButtons('google')[0]!.label).toBe('chat.consent.confirm');
	});

	it('are red only where something is deleted or retired, and cancelling is the quiet one', () => {
		for (const action of ACTIONS) expect(consentButtons('google', action)[0]!.tone, action).toBe(action === 'delete' ? 'danger' : 'primary');
		expect(consentButtons('retire')[0]!.tone).toBe('danger');
		for (const kind of ['send', 'merge', 'apply', 'plan'] as const) expect(consentButtons(kind)[0]!.tone, kind).toBe('primary');
		for (const kind of TOOL_KINDS) expect(consentButtons(kind).at(-1), kind).toMatchObject({ key: 'cancel', tone: 'secondary' });
		expect(consentButtons('plan')[1]).toMatchObject({ key: 'adjust', tone: 'secondary' });
	});

	it('draw only the tools\' kinds; the guard and the deep consent keep their own cards', () => {
		for (const kind of TOOL_KINDS) expect(isToolConsent(kind), kind).toBe(true);
		expect(isToolConsent('guard')).toBe(false);
		expect(isToolConsent('deep')).toBe(false);
		expect(isToolConsent(undefined)).toBe(false);
	});
});
