// === Inbox keyboard shortcuts ===
//
// Pure mapper from a KeyboardEvent to a high-level action plus a guard
// that suppresses shortcuts while the user is typing in a form control.
// Kept framework-free so InboxView can call into it from a window
// keydown handler without dragging Svelte runes into the test surface.

export type InboxShortcutAction =
	| { kind: 'next' }
	| { kind: 'prev' }
	| { kind: 'archive' }
	| { kind: 'snooze' }
	| { kind: 'undo' }
	| { kind: 'reply' }
	| { kind: 'close' }
	| { kind: 'toggle_help' }
	| { kind: 'toggle_triage' };

/**
 * Translate a key event into an inbox action, or null when the event
 * is not a known shortcut. Reads `event.key` (layout-aware on Linux/
 * macOS/Windows) so `?` keeps working on German keyboards where the
 * physical key is Shift+ß. Modifier-bearing combos (Ctrl/Meta/Alt) are
 * ignored so the shortcut layer does not steal browser hotkeys.
 */
export function keyToInboxAction(event: KeyboardEvent): InboxShortcutAction | null {
	if (event.ctrlKey || event.metaKey || event.altKey) return null;
	switch (event.key) {
		case 'j':
		case 'J':
		case 'ArrowDown':
			return { kind: 'next' };
		case 'k':
		case 'K':
		case 'ArrowUp':
			return { kind: 'prev' };
		case 'a':
		case 'A':
			return { kind: 'archive' };
		case 's':
		case 'S':
			return { kind: 'snooze' };
		case 'z':
		case 'Z':
			return { kind: 'undo' };
		case 'r':
		case 'R':
			return { kind: 'reply' };
		case 't':
		case 'T':
			return { kind: 'toggle_triage' };
		case 'Escape':
			return { kind: 'close' };
		case '?':
			return { kind: 'toggle_help' };
		default:
			return null;
	}
}

/**
 * True when the event originated from a form control where keystrokes
 * should reach the field instead of triggering shortcuts. Also returns
 * true for contenteditable hosts (rare in this UI but used by some
 * rich-text editors). Duck-typed so the unit test can pass plain
 * objects without standing up a DOM.
 */
export function shouldIgnoreShortcut(target: EventTarget | null): boolean {
	if (target === null || typeof target !== 'object') return false;
	const t = target as { tagName?: unknown; isContentEditable?: unknown };
	if (typeof t.tagName === 'string') {
		const tag = t.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	}
	if (t.isContentEditable === true) return true;
	return false;
}
