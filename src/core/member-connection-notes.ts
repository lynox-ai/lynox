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
import type { NoticeLanguage } from './notice-language.js';
import { memberRefusalCase, memberRefusalOwnerNote, memberRefusalText, sharedRefreshOwnerNote, sharedRefreshRefusal, type OwnerNote } from './profile-secret-view.js';
import type { RequestPrincipal } from './request-principal.js';

/** Start of the line a member connection's refusal is written as. */
export const MEMBER_CONNECTION_PREFIX = 'Connection not used:';

/**
 * A run's collector. `notes`: the lines as recorded under its result (English, the owner's
 * wording where there is one, UX-065); `said`: each line in German, for a push in the owner's
 * language. `plan`: the trigger's title, which the owner's line names.
 */
interface Collector {
  readonly notes: Set<string>;
  readonly said: Map<string, string>;
  readonly plan: string | undefined;
}

const collecting = new AsyncLocalStorage<Collector>();

/** Run `fn` with a collector for the member-connection lines its requests produce. */
export function runCollectingMemberNotes<T>(fn: () => Promise<T>, plan?: string): { notes: ReadonlySet<string>; said: ReadonlyMap<string, string>; done: Promise<T> } {
  const collector: Collector = { notes: new Set(), said: new Map(), plan };
  return { notes: collector.notes, said: collector.said, done: collecting.run(collector, fn) };
}

/** The lines noted so far in the run in progress, as recorded; none outside one. */
export function currentMemberNotes(): readonly string[] {
  return [...(collecting.getStore()?.notes ?? [])];
}

/** The same lines in `language`, for the push: the German of a line is its owner's wording. */
export function currentMemberNotesIn(language: NoticeLanguage): readonly string[] {
  const store = collecting.getStore();
  if (store === undefined) return [];
  return [...store.notes].map((l) => (language === 'de' ? store.said.get(l) ?? l : l));
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

/**
 * Record `line` for the run in progress; nothing outside one. `owner`: the owner's wording of it,
 * given the run's plan, recorded in its place (the model keeps `line`); without one, or where it
 * gives none, the line itself is recorded, in both languages.
 */
export function noteMemberConnection(line: string, owner?: (plan: string | undefined) => OwnerNote | null): void {
  const store = collecting.getStore();
  if (store === undefined) return;
  const note = owner?.(store.plan) ?? null;
  const recorded = note?.en ?? line;
  store.notes.add(recorded);
  if (!store.said.has(recorded)) store.said.set(recorded, note?.de ?? line);
}

/** Pass the lines of an inner collector on to the run in progress, each with its German. */
export function relayMemberNotes(inner: { notes: ReadonlySet<string>; said: ReadonlyMap<string, string> }): void {
  for (const line of inner.notes) noteMemberConnection(line, () => ({ en: line, de: inner.said.get(line) ?? line }));
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
  const refusal = memberRefusalCase(profile, reader, ends, mode);
  if (refusal === null) return null;
  const line = `${MEMBER_CONNECTION_PREFIX} ${memberRefusalText(refusal)}`;
  noteMemberConnection(line, (plan) => memberRefusalOwnerNote(refusal, plan));
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
  noteMemberConnection(line, (plan) => sharedRefreshOwnerNote(holder, via, plan));
  return line;
}
