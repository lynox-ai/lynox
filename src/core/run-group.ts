import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The run group: one opaque id shared by every metered report a single customer run causes —
 * its own report, its spawned children at any depth, its workflow steps, its in-run helper
 * calls, and the work it starts without awaiting (title, compaction, knowledge extraction,
 * an uploaded document's chunks). Managed hosting caps spend per group; a report without one
 * counts as its own group.
 *
 * Carried in AsyncLocalStorage rather than as a parameter, because the reports sit at the end
 * of many call paths and a parameter forgotten on any hop silently opens a second cap. Here it
 * is set where a run starts and read once, at the two report leaves in `metered-request.ts`.
 *
 * Context is inherited when an async resource is CREATED. That is what makes un-awaited work
 * started inside a run report in its group, and it is also the one way this goes wrong: a
 * long-lived thing first started inside a run — an interval, a polling loop, a queue that
 * starts its next job from the previous job's callback, a listener on a long-lived emitter —
 * keeps that run's group for good, and later spend from it lands on that run's cap. Anything
 * long-lived that can be started from inside a run and can reach a report must start (or run
 * each job) under {@link runOutsideGroup}. The classifier queue in
 * `integrations/inbox/classifier/queue.ts` is the example.
 */

interface RunGroupScope {
  /** Null while a run is open but has not chosen its id yet (see {@link settleRunGroup}). */
  group: string | null;
}

const scope = new AsyncLocalStorage<RunGroupScope>();

/** The form a group id must have. Managed hosting does not take any other form as a group. */
export const RUN_GROUP_ID_FORMAT = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Run `fn` as group `group`. Work started inside it, awaited or not, reports in this group. */
export function openRunGroup<T>(group: string, fn: () => T): T {
  return scope.run({ group }, fn);
}

/**
 * Run `fn` as a new group whose id is chosen later, inside `fn`, by {@link settleRunGroup}.
 * For a chat run: its id exists only once its history row is written, and nothing before that
 * point reports spend.
 */
export function openPendingRunGroup<T>(fn: () => T): T {
  return scope.run({ group: null }, fn);
}

/**
 * Choose the id of the group opened by {@link openPendingRunGroup}. A scope that already has
 * an id keeps it — an internal run (compaction) settles into the group of the run that
 * started it. Returns the group in effect, or null outside any group.
 */
export function settleRunGroup(group: string): string | null {
  const current = scope.getStore();
  if (current === undefined) return null;
  if (current.group === null) current.group = group;
  return current.group;
}

/** The group of the run this code belongs to, or null. */
export function currentRunGroup(): string | null {
  return scope.getStore()?.group ?? null;
}

/** Run `fn` outside any group: what it starts, and reports, belongs to no run. */
export function runOutsideGroup<T>(fn: () => T): T {
  return scope.exit(fn);
}
