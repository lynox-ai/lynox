import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where the chat store learns that the open chat is contained (it read data through a store
 * connection), and where it forgets it again. Source-level, like `private-toggle-i18n.test.ts`:
 * the root vitest has no svelte plugin, and these are assignments inside rune-backed state.
 */
const src = readFileSync(fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)), 'utf8');

describe('the open chat\'s `contained` flag in the chat store', () => {
	it('is cleared on a new chat and on opening another thread, beside private mode', () => {
		expect(src.split('\tskipExtraction = false;\n\tthreadContained = false;\n').length - 1).toBe(2);
	});

	it('is read from the thread when it is opened', () => {
		expect(src).toContain('threadContained = threadData.thread.contained === true;');
	});

	it('is set when the server refuses to switch private mode off because the chat is contained', () => {
		expect(src).toContain("if ('contained' in failure && failure.contained) threadContained = true;");
	});

	it('is re-read from the open thread after a run, which may have contained it', () => {
		// The end of a run sent from this page.
		expect(src).toMatch(/\/\/ Refresh thread list so sidebar reflects updated ordering\n\tvoid loadThreads\(\);\n\tvoid refreshThreadContained\(\{ afterRun: true, answer: turn\.assistantMsg \}\);/);
		// A re-attach that found no live run, the offline probe and a mount end in reconcileThread.
		expect(src).toMatch(/export async function reconcileThread\(\): Promise<void> \{\n\tconst tid = sessionId;\n\tif \(!tid\) return;\n(\t\/\/[^\n]*\n)*\tvoid refreshThreadContained\(\);/);
		// A re-attach to a live run (reload, tab switch, take-over) reads it in its finally, outside
		// the condition that reconciles only a run that ended with `done`.
		const finallyStart = src.indexOf('\t} finally {\n\t\ttry { await reader.cancel(); } catch { /* already closed */ }');
		const reconcileGate = src.indexOf('if (completedNormally && streamEpoch === myEpoch && gen === _resumeGeneration) {', finallyStart);
		// At the finally's own depth (two tabs, a newline before), not nested in a branch above.
		const call = src.indexOf('\n\t\tvoid refreshThreadContained({ afterRun: true, answer: assistantIdx >= 0 ? messages[assistantIdx] ?? null : null });\n', finallyStart);
		expect(finallyStart).toBeGreaterThan(-1);
		expect(call).toBeGreaterThan(finallyStart);
		expect(call).toBeLessThan(reconcileGate);
	});

	it('a reply for a chat the user has since left does not land on the one now open', () => {
		expect(src).toContain('if (!res?.ok || sessionId !== sid) return;');
		// Again after the body arrived, right at the assignment.
		expect(src).toContain("if (sessionId !== sid || data?.thread?.contained !== true || threadContained) return;\n\tthreadContained = true;");
	});
});
