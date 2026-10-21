/**
 * What a run is told when a request of it would carry a token of a connection someone else made
 * with their own login (`memberConnectionRefusal`), collected for the run's end. The refusal is a
 * tool result, and a model that reads it may well finish its turn and report success; a scheduled
 * run would then end ✓ and the owner never learn why nothing reached the provider. So the line
 * that says it is noted where it is produced, and the worker ends the run with it.
 *
 * Outside a collecting run a note goes nowhere: a chat turn reads the refusal itself, and a saved
 * workflow's report picks the line up by its prefix (`collectWriteNotes`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ApiProfile } from './api-store.js';
import type { MandateEnds } from './mandate-ends.js';
import { memberConnectionRefusal, sharedRefreshRefusal } from './profile-secret-view.js';
import type { RequestPrincipal } from './request-principal.js';

/** Start of the line a member connection's refusal is written as. */
export const MEMBER_CONNECTION_PREFIX = 'Connection not used:';

const collecting = new AsyncLocalStorage<Set<string>>();

/** Run `fn` with a collector for the member-connection lines its requests produce. */
export function runCollectingMemberNotes<T>(fn: () => Promise<T>): { notes: ReadonlySet<string>; done: Promise<T> } {
  const notes = new Set<string>();
  return { notes, done: collecting.run(notes, fn) };
}

/** The lines noted so far in the run in progress; none outside one. */
export function currentMemberNotes(): readonly string[] {
  return [...(collecting.getStore() ?? [])];
}

/**
 * How a run ends once it noted member-connection lines: they go under its result, and a run that
 * would end as a success instead halts — it did not reach the provider, and what is missing is
 * the owner's to give, so a retry would only meet the same refusal. Unchanged without notes.
 */
export function withMemberNotes<S extends string>(result: string, status: S, notes: readonly string[]): { result: string; status: S | 'halted' } {
  if (notes.length === 0) return { result, status };
  return { result: `${result}\n${notes.map((l) => `• ${l}`).join('\n')}`, status: status === 'success' ? 'halted' : status };
}

/** Whether the last run already halted on these same lines, so the owner was told once already. */
export function memberNotesRepeat(last: { last_run_status?: string | null | undefined; last_run_result?: string | null | undefined }, notes: readonly string[]): boolean {
  return notes.length > 0 && last.last_run_status === 'halted' && notes.every((l) => last.last_run_result?.includes(l) === true);
}

/** Whether a run in progress collects the lines itself, so a report that also picks them up
 *  from tool results (`collectWriteNotes`) leaves them to it instead of listing them twice. */
export function collectingMemberNotes(): boolean {
  return collecting.getStore() !== undefined;
}

/**
 * Run `fn` outside the collector of the run in progress. For a step that is no request of the
 * run: the renewal before a request, whose refusal leaves the request going out on the stored
 * token, and which one run starts for every run waiting on the same profile.
 */
export function outsideMemberNotes<T>(fn: () => T): T {
  return collecting.exit(fn);
}

/** Record `line` for the run in progress; nothing outside one. */
export function noteMemberConnection(line: string): void {
  collecting.getStore()?.add(line);
}

/**
 * The refusal of a request through `profile` that would carry a token of someone else's own
 * login, noted for the run, or null when the request may go on. Called where a token is about to
 * be sent, never where one is only looked at: a check that a slot holds something is no request.
 */
export function refuseMemberConnection(
  profile: ApiProfile,
  reader: RequestPrincipal,
  ends: Pick<MandateEnds, 'isLive'> | null,
  mode: 'read' | 'write' = 'read',
): string | null {
  const text = memberConnectionRefusal(profile, reader, ends, mode);
  if (text === null) return null;
  const line = `${MEMBER_CONNECTION_PREFIX} ${text}`;
  noteMemberConnection(line);
  return line;
}

/**
 * The refusal of a token exchange through `via`, whose refresh slot belongs to `holder`, a
 * member's own-login connection: for every reader, the member included (`sharedRefreshRefusal`).
 * A reader the holder's own refusal covers is told that one.
 */
export function refuseSharedRefresh(
  holder: ApiProfile,
  via: ApiProfile,
  reader: RequestPrincipal,
  ends: Pick<MandateEnds, 'isLive'> | null,
): string {
  const theirs = refuseMemberConnection(holder, reader, ends, 'write');
  if (theirs !== null) return theirs;
  const line = `${MEMBER_CONNECTION_PREFIX} ${sharedRefreshRefusal(holder, via)}`;
  noteMemberConnection(line);
  return line;
}
