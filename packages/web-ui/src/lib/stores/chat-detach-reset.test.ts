import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard: thread-scoped chat state must be cleared on BOTH detach paths.
 *
 * The bug this exists for (2026-08-02 dogfood): `compactionOffer` is set by a
 * one-shot `compaction_offer` SSE event and was cleared ONLY by
 * `context_compacted` and a manual `compactNow()`. Neither `newChat()` nor the
 * `resumeThread()` detach block reset it, and its render condition in ChatView is
 * a bare `compactionOffer !== null` — so once ANY thread crossed the prepare
 * threshold, the "summarize & compact" bar rendered on every new chat and every
 * thread switch until the page was reloaded. `retryStatus` had the identical
 * shape (bare `{#if retryStatus}`, cleared only at `_executeRun` entry).
 *
 * Why this is a source-level guard rather than a behavioural one: `chat.svelte.ts`
 * is a Svelte 5 rune module and the root vitest config carries no svelte plugin,
 * so importing it throws `$state is not defined`. Every existing web-ui test
 * targets an extracted plain-.ts module for that reason. Extracting a 24-field
 * reset sequence to make it importable is a larger change than the defect earns.
 *
 * Why CLASSIFICATION and not symmetry: the original bug kept the two paths
 * perfectly symmetric — `compactionOffer` was missing from BOTH. A
 * "newChat clears == resumeThread clears" assertion passes on the buggy code.
 * What catches it is forcing every module-level `$state` to be declared
 * thread-scoped or not, so adding one cannot silently default to "leaks".
 */

const SRC = readFileSync(
	fileURLToPath(new URL('./chat.svelte.ts', import.meta.url)),
	'utf-8',
);

/** Cleared when detaching from a thread — on BOTH `newChat` and `resumeThread`. */
const THREAD_SCOPED = [
	'messages', 'sessionId', 'deferredFollowUps', 'isStreaming', 'streamingActivity',
	'streamingToolName', 'streamingToolPhase', 'pendingPermission', 'pendingTabsPrompt',
	'pendingSecretPrompt', 'pendingMailConnect', 'pendingChangeset', 'changesetLoading',
	'skipExtraction', 'chatError', 'runInterrupted', 'messageQueue', 'runStartedAt',
	'runPromptCount', 'contextBudget', 'compactionOffer', 'retryStatus',
] as const;

/**
 * Cleared by `newChat` only — but for two different reasons, and an earlier
 * version of this comment got one of them wrong:
 *
 *  - `sessionModel` / `sessionTier` — `resumeThread` ASSIGNS these from the
 *    resumed thread's session data further down, so clearing them in the detach
 *    block would be overwritten noise. Note the assignment sits on the SUCCESS
 *    path, after two awaits: if `POST /sessions` fails, the previous thread's
 *    tier keeps rendering beside the new transcript. Pre-existing, minor, and
 *    the reason "immediately overwritten" is not quite true.
 *  - `pendingModel` — `resumeThread` never touches it at all. It is the
 *    composer's next-new-chat pick, which no resume path reads (`ensureSession`
 *    sends only `{threadId}`), so leaving it is harmless rather than corrected.
 */
const NEW_CHAT_ONLY = ['sessionModel', 'sessionTier', 'pendingModel'] as const;

/**
 * Deliberately survives a detach. Each entry carries the reason it cannot leak
 * a stale value into another thread's UI — verified at the consumer, not assumed:
 *  - `currentToolStartedAt`, `lastEventAt` — rendered only inside
 *    `{:else if isStreaming && …}` (StreamingActivityBar); `isStreaming` is
 *    thread-scoped, so the gate closes on detach.
 *  - `chatErrorDetail` — rendered only inside `{#if chatError}`; `chatError` is
 *    thread-scoped.
 *  - `contextWindow` — re-assigned from the server response on RESUME; on
 *    `newChat` it survives until the first send assigns it via `ensureSession`.
 *    No in-repo consequence (ChatView derives it and never renders it), but it
 *    IS a barrel export, so a host app that renders it shows the previous
 *    thread's window in that gap. Recorded rather than smoothed over — the
 *    earlier claim of "both paths" was wrong.
 *  - `completedTextBlockGen`, `secretPromptGeneration`, `mailConnectGeneration` —
 *    monotonic generation counters; consumers compare deltas, never absolute values.
 *  - `authError`, `isOffline`, `managedTier` — genuinely app-global.
 *  - `isCompacting` — in-flight latch for a single `compactNow()` call, cleared
 *    in its own `finally`.
 */
const NOT_THREAD_SCOPED = [
	'currentToolStartedAt', 'lastEventAt', 'chatErrorDetail', 'contextWindow',
	'completedTextBlockGen', 'secretPromptGeneration', 'mailConnectGeneration',
	'authError', 'isOffline', 'managedTier', 'isCompacting',
] as const;

/** Every module-level `let x = $state(...)` in the store. */
function declaredState(): string[] {
	return [...SRC.matchAll(/^let (\w+)\s*=\s*\$state/gm)].map((m) => m[1] as string);
}

/**
 * Body of `newChat()`. Anchored on the closing `persistChatNow();\n}` rather than
 * brace-matching — and it THROWS when the anchor is gone, so a rename turns this
 * guard red instead of quietly making it vacuous.
 */
function newChatBody(): string {
	const start = SRC.indexOf('export function newChat() {');
	if (start < 0) throw new Error('anchor lost: `export function newChat() {`');
	const end = SRC.indexOf('persistChatNow();\n}', start);
	if (end < 0) throw new Error('anchor lost: end of newChat()');
	return SRC.slice(start, end);
}

/** The detach block inside `resumeThread()` — up to its `persistChatNow();`. */
function resumeDetachBlock(): string {
	const anchor = SRC.indexOf('messageQueue = loadPersistedQueue(threadId)');
	if (anchor < 0) throw new Error('anchor lost: resumeThread queue restore');
	const start = SRC.lastIndexOf('export async function resumeThread', anchor);
	if (start < 0) throw new Error('anchor lost: `export async function resumeThread`');
	const end = SRC.indexOf('persistChatNow();', anchor);
	if (end < 0) throw new Error('anchor lost: end of resumeThread detach block');
	return SRC.slice(start, end);
}

/**
 * True iff `block` RE-SEATS `name` unconditionally, at the function's top level.
 *
 * "Re-seats", not "clears" — the distinction matters and a first version of this
 * guard got it wrong. `newChat` clears (`messages = []`), while `resumeThread`
 * re-assigns to the incoming thread's data (`messages = localMessages`,
 * `sessionId = threadId`, `messageQueue = loadPersistedQueue(threadId)`). Both
 * satisfy the invariant, which is that the field cannot carry over from the
 * thread being left. A matcher that demanded a null-shaped value rejected the
 * correct code.
 *
 * Two constraints, both earned by mutants that survived `^\s*NAME\s*=`:
 *
 *  1. **Exactly one tab.** `\s*` matched any depth, so
 *     `if (sessionId !== threadId) { compactionOffer = null; }` passed — the bug
 *     reintroduced behind a condition, guard silent. Statements in both detach
 *     blocks sit at one tab; anything nested sits deeper.
 *  2. **Not a self-assignment.** `compactionOffer = compactionOffer;` passed and
 *     re-seats nothing.
 *
 * This proves an unconditional top-level re-seat exists. It does NOT prove the
 * function is condition-free elsewhere — a source-level guard cannot, and the
 * docstring should not imply otherwise.
 */
function clears(block: string, name: string): boolean {
	const m = new RegExp(`^\\t${name} = (.+?);`, 'm').exec(block);
	return m !== null && m[1]?.trim() !== name;
}

describe('chat store — thread-detach reset', () => {
	it('classifies every module-level $state', () => {
		const classified = new Set<string>([
			...THREAD_SCOPED, ...NEW_CHAT_ONLY, ...NOT_THREAD_SCOPED,
		]);
		const declared = declaredState();
		expect(declared.length).toBeGreaterThan(30); // the parse actually found them

		// A NEW field must be classified deliberately. This is the assertion that
		// would have caught `compactionOffer`: it defaulted to "leaks" because
		// nothing forced the question.
		expect(declared.filter((n) => !classified.has(n))).toEqual([]);

		// And nothing classified may have been deleted from the store.
		expect([...classified].filter((n) => !declared.includes(n))).toEqual([]);
	});

	it('clears every thread-scoped field in newChat()', () => {
		const body = newChatBody();
		expect(THREAD_SCOPED.filter((n) => !clears(body, n))).toEqual([]);
		expect(NEW_CHAT_ONLY.filter((n) => !clears(body, n))).toEqual([]);
	});

	it('clears every thread-scoped field in the resumeThread detach block', () => {
		const body = resumeDetachBlock();
		expect(THREAD_SCOPED.filter((n) => !clears(body, n))).toEqual([]);
	});

	it('does not clear app-global state on either path', () => {
		const paths = { newChat: newChatBody(), resumeThread: resumeDetachBlock() };
		for (const [where, body] of Object.entries(paths)) {
			const wrongly = NOT_THREAD_SCOPED.filter((n) => clears(body, n));
			expect(wrongly, `${where} clears app-global state`).toEqual([]);
		}
	});
});
