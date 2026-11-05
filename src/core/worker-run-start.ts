import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * How the worker run this code runs in was started, decided once where the worker frames the run
 * (`#runInSlot` in worker-loop.ts) and held for everything it does: its session's turns and the
 * workflows its tools start. Read by `run_workflow` for the record of how a mandate's workflow
 * that the owner's run starts was started: a run of the owner's schedule is not one the
 * owner started by hand, and the instance log must not say it was.
 *
 * - `schedule`: the trigger came due on its own.
 * - `hand`: started through "Run now" on the trigger (`isStartedByHand`).
 * - `event`: started by a provider's verified event (an inbound webhook).
 * - `answered`: picked up again after its question was answered. How the run that asked was
 *   started is not known here: the pickup runs outside the hand scope, and nothing stored says
 *   whether the owner pressed "Run now" (the question's `hand_run` covers only a mandate's test
 *   run). A reader says nothing about the start rather than guess.
 *
 * Its own store rather than a field of the worker's task context, so a reader outside the worker
 * does not have to import the worker loop (the same reason as `plan-run-context.ts`). Entering it
 * passes no check and withholds nothing: it only changes the words of a record.
 */
export type WorkerRunStart = 'schedule' | 'hand' | 'event' | 'answered';

const workerRunStartStorage = new AsyncLocalStorage<WorkerRunStart>();

export function runAsWorkerRun<T>(start: WorkerRunStart, fn: () => T): T {
  return workerRunStartStorage.run(start, fn);
}

/** How the worker run this code runs in was started; undefined outside a worker run (a chat, the library's Run). */
export function currentWorkerRunStart(): WorkerRunStart | undefined {
  return workerRunStartStorage.getStore();
}
