import { describe, it, expect } from 'vitest';
import { keyToInboxAction, shouldIgnoreShortcut } from './inbox-shortcuts.js';

function ev(init: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): KeyboardEvent {
	return {
		key: init.key,
		ctrlKey: init.ctrlKey ?? false,
		metaKey: init.metaKey ?? false,
		altKey: init.altKey ?? false,
		shiftKey: init.shiftKey ?? false,
	} as unknown as KeyboardEvent;
}

describe('keyToInboxAction — wired keys', () => {
	it.each([
		['j', 'next'],
		['J', 'next'],
		['ArrowDown', 'next'],
		['k', 'prev'],
		['K', 'prev'],
		['ArrowUp', 'prev'],
		['a', 'archive'],
		['A', 'archive'],
		['s', 'snooze'],
		['S', 'snooze'],
		['z', 'undo'],
		['Z', 'undo'],
		['r', 'reply'],
		['R', 'reply'],
		['Escape', 'close'],
		['?', 'toggle_help'],
	])('maps %s to %s', (key, expected) => {
		expect(keyToInboxAction(ev({ key }))?.kind).toBe(expected);
	});
});

describe('keyToInboxAction — guards', () => {
	it('returns null for unknown keys', () => {
		expect(keyToInboxAction(ev({ key: 'q' }))).toBeNull();
		expect(keyToInboxAction(ev({ key: 'Enter' }))).toBeNull();
		expect(keyToInboxAction(ev({ key: ' ' }))).toBeNull();
	});

	it('ignores Ctrl/Meta/Alt-modified keys so browser hotkeys keep working', () => {
		expect(keyToInboxAction(ev({ key: 'a', ctrlKey: true }))).toBeNull();
		expect(keyToInboxAction(ev({ key: 'z', metaKey: true }))).toBeNull();
		expect(keyToInboxAction(ev({ key: 'j', altKey: true }))).toBeNull();
	});

	it('ignores combos that pair Shift with another modifier', () => {
		expect(keyToInboxAction(ev({ key: 'a', ctrlKey: true, shiftKey: true }))).toBeNull();
		expect(keyToInboxAction(ev({ key: 'Escape', metaKey: true }))).toBeNull();
	});

	it('does not treat Shift alone as a modifier (capital letters still match)', () => {
		expect(keyToInboxAction(ev({ key: 'A', shiftKey: true }))?.kind).toBe('archive');
	});
});

describe('shouldIgnoreShortcut', () => {
	it('returns false for null and primitive non-Element targets', () => {
		expect(shouldIgnoreShortcut(null)).toBe(false);
		expect(shouldIgnoreShortcut({} as EventTarget)).toBe(false);
	});

	it('returns true for INPUT, TEXTAREA, SELECT tagName', () => {
		expect(shouldIgnoreShortcut({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
		expect(shouldIgnoreShortcut({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
		expect(shouldIgnoreShortcut({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
	});

	it('returns false for BUTTON and DIV tagName', () => {
		expect(shouldIgnoreShortcut({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
		expect(shouldIgnoreShortcut({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
	});

	it('returns true for contenteditable=true hosts', () => {
		expect(shouldIgnoreShortcut({
			tagName: 'DIV',
			isContentEditable: true,
		} as unknown as EventTarget)).toBe(true);
	});
});
