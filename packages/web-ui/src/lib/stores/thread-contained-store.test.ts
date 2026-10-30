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
		expect(src.split('\tskipExtraction = false;\n\tthreadContained = false;\n\tthreadContainedUnknown = null;\n').length - 1).toBe(2);
	});

	it('is read from the thread when it is opened', () => {
		expect(src).toContain('threadContained = threadData.thread.contained === true;\n\t\t\t\tthreadContainedUnknown = threadContained ? readContainedUnknown(threadData.thread.contained_unknown) : null;');
	});

	it('is set when the server refuses to switch private mode off because the chat is contained', () => {
		expect(src).toContain("if ('contained' in failure && failure.contained) {\n\t\t\tthreadContained = true;\n\t\t\tthreadContainedUnknown = failure.unknown ?? null;");
	});

	it('is re-read at the one place every run end reaches', () => {
		// `runEnded` is the one reader; nothing else asks the thread whether it is contained now.
		expect(src.match(/refreshThreadContained\(/g)).toHaveLength(2); // the definition and runEnded's call
		expect(src).toContain('function runEnded(answer: ChatMessage | null): void {\n\tvoid refreshThreadContained({ afterRun: true, answer });\n}');
		// `endStreaming` is the only way to clear `isStreaming` and reaches it; the two resets of a
		// new or reopened chat are not run ends and stay as they are.
		expect(src).toContain('function endStreaming(answer: ChatMessage | null = null): void {\n\tisStreaming = false;\n\trunEnded(answer);\n}');
		const fnOf = (at: number): string => {
			const m = [...src.slice(0, at).matchAll(/\n(?:export )?(?:async )?function (\w+)/g)].at(-1);
			return m?.[1] ?? '';
		};
		const clears = [...src.matchAll(/isStreaming = false;/g)].map((m) => fnOf(m.index!));
		expect(clears.sort()).toEqual(['endStreaming', 'newChat', 'resumeThread']);
		// Where no stream was open, the run's end is said directly: a re-attach that found the run
		// finished (404), a re-attach that lost ownership, and a reconcile.
		expect(src).toContain('if (!res.ok || !res.body) { runEnded(null); return; }');
		expect(src).toMatch(/export async function reconcileThread\(\): Promise<void> \{\n\tconst tid = sessionId;\n\tif \(!tid\) return;\n(\t\/\/[^\n]*\n)*\trunEnded\(null\);/);
		expect(src).toContain('\t\t\tendStreaming(answer);\n\t\t\tstreamingActivity = \'idle\';\n\t\t\tstreamingToolName = null;\n\t\t\tstreamingToolPhase = null;\n\t\t} else {\n\t\t\trunEnded(answer);\n\t\t}');
	});

	it('a reply for a chat the user has since left does not land on the one now open', () => {
		expect(src).toContain('if (!res?.ok || sessionId !== sid) return;');
		// Again after the body arrived, right at the assignment.
		expect(src).toContain("if (sessionId !== sid || !data?.thread) return;");
	});
});
