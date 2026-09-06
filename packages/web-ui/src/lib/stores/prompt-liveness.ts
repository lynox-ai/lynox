/**
 * Three decisions about what the client knows about a prompt's true state.
 *
 * They live here rather than inline in `chat.svelte.ts` for the reason
 * `chat-usage.ts` and `follow-ups.ts` do: the SSE handler is not exported, so
 * logic inside it is reachable by no test. All three below came out of one prod
 * thread (2026-09-06) where a question sat unanswered for hours behind a green
 * check mark, and all three are the same shape of defect — the UI stating a
 * fact it has not established.
 */

/**
 * Whether a `turn_end` may settle tool calls still marked `running`.
 *
 * The settle exists to clear UI ghosts: a dropped `tool_result` used to leave a
 * spinner turning forever under a finished answer (reported 2026-05-15). That
 * reasoning holds for every stop reason but one.
 *
 * `turn_end` is emitted the moment the model stream reports a stop reason
 * (`core/src/core/stream.ts`), and `stop_reason: 'tool_use'` means the turn is
 * NOT over — the agent dispatches the tools afterwards (`core/src/core/agent.ts`).
 * On that reason the results provably have not arrived yet, so settling paints
 * a ✓ on work still in flight. Worst on `ask_user`, which is not slow but parked
 * on a human: the check mark reads as "answered" over a question nobody has
 * been shown.
 */
export function turnEndSettlesTools(stopReason: string | undefined): boolean {
	return stopReason !== 'tool_use';
}

/**
 * When a restored prompt was CREATED, in epoch ms.
 *
 * The countdown renders `timeoutMs - (now - receivedAt)`, so restoring a prompt
 * with `receivedAt = Date.now()` restarts its clock: a prompt three hours into
 * a 24h TTL rendered as 23:59:49, and did so again after every reload. The UI
 * was promising time the prompt did not have.
 *
 * `createdAt` comes from SQLite's `datetime()` — `'2026-09-06 10:58:40'`, UTC
 * but carrying no zone suffix, which `Date.parse` reads as LOCAL time. Parsing
 * it naively shifts the countdown by the viewer's offset (an hour or two of
 * imaginary or missing time in Zurich, ten in Auckland) — subtler than the bug
 * it replaces, and harder to catch.
 *
 * Falls back to `now` when the field is absent or unparseable — an older engine
 * that does not send it, or a malformed row. A restarted clock is wrong; a NaN
 * one renders nothing at all, which is worse.
 */
export function promptCreatedAtMs(raw: unknown, now: number): number {
	if (typeof raw !== 'string' || raw === '') return now;
	const parsed = Date.parse(zoneQualify(raw));
	return Number.isFinite(parsed) ? parsed : now;
}

/**
 * Turn a SQLite `datetime()` string into one `Date.parse` reads as UTC.
 *
 * Split out from {@link promptCreatedAtMs} so it can be tested as a STRING
 * transform. Asserting the parsed number instead would make the test agree with
 * a broken implementation on any machine already in UTC — and CI sets no `TZ`,
 * so GitHub runners are exactly that. The test would have been green against
 * nothing there while passing locally in Zurich for the wrong reason.
 *
 * A value that already carries a zone (`…Z`, `…+02:00`) is returned untouched:
 * qualifying it twice would be a parse error, and the engine is free to switch
 * to real ISO output without breaking this.
 */
export function zoneQualify(raw: string): string {
	const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
	return /[Zz]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
}

/** What the lost-prompt recheck should do when its timer fires. */
export type RecheckVerdict = 'ask' | 'wait' | 'stop';

/**
 * Whether to ask the server for a prompt this tab may never have heard about.
 *
 * The `prompt` SSE event is the only run event that never enters the RunBuffer
 * (`EmittedStreamEvent` has no `prompt` member), so the `?since=` replay that
 * recovers every `tool_call` and `turn_end` cannot recover the question itself.
 * The server writes it straight to the socket and says so: "best-effort (client
 * may not be connected)". Lose it once and the question is invisible while
 * SQLite holds it `pending` for 24h.
 *
 * - `stop` — a newer run owns the stream, or this one ended. Do not re-arm;
 *   the run that replaced us schedules its own.
 * - `wait` — the prompt is already on screen. Nothing to recover, but the run
 *   is alive and a LATER tool in the same run may park again, so keep the timer.
 * - `ask` — a run is in flight with no prompt visible. This is either a normal
 *   busy tool or a question that was lost; the two are indistinguishable from
 *   here, which is exactly why it has to be asked rather than assumed.
 */
export function lostPromptRecheckVerdict(state: {
	epochAtSchedule: number;
	currentEpoch: number;
	isStreaming: boolean;
	hasPendingPrompt: boolean;
}): RecheckVerdict {
	if (state.epochAtSchedule !== state.currentEpoch) return 'stop';
	if (!state.isStreaming) return 'stop';
	return state.hasPendingPrompt ? 'wait' : 'ask';
}
