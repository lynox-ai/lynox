/**
 * The refusals of an engine that started without engine.db, for the stores whose writes the next
 * boot with engine.db would not read the same way.
 *
 * API profiles keep their own heads in `api-store.ts` (`engineLessText`); this module holds the
 * two sentences every such refusal ends with, and the heads for memory and tasks.
 *
 * Memory: without engine.db the engine registers the old `memory_*` tools, which write the memory
 * files and the knowledge layer. The next boot with engine.db registers the durable tools, which
 * read neither the files nor (with the subject graph and graph reads on) the layer's own rows, so
 * a fact written now may be missing and a removed one may come back.
 *
 * Tasks: without engine.db a task is written to history.db only. A tenant with the subject graph on
 * reads its tasks from engine.db, and the copy that would put the change there runs once per
 * engine.db, so a task added now may be missing and one completed now may show as open.
 */

/** True for every reader: it lasts until a restart, and the log says why. */
export const ENGINE_LESS_LASTS = "This does not end on its own: it lasts until someone restarts the engine and the engine can open all its files again; the log the engine writes at start says why it could not.";

/**
 * For the model only: without it, models measured on these refusals offered to do it after the
 * restart, which nothing in lynox would carry out. An HTTP answer is read by a person or a
 * program, not by the model, so it gets no such advice; the JSON error body is also capped at 600
 * characters, which the sentences with it would exceed.
 */
export const ENGINE_LESS_TO_MODEL = "Do not retry and do not offer to do it later on your own: nothing will remind you after the restart. Tell the user it did not happen; after the restart they can ask again. Do not ask whether to try again later either; if they want that, they ask after the restart.";

/** `model`: a tool result the model reads. `client`: an HTTP answer. */
export type EngineLessReader = 'model' | 'client';

/** `head` followed by the sentences every reader gets, and for the model the advice. */
export function engineLessSentence(head: string, reader: EngineLessReader): string {
  const told = `${head} ${ENGINE_LESS_LASTS}`;
  return reader === 'model' ? `${told} ${ENGINE_LESS_TO_MODEL}` : told;
}

const MEMORY_HEAD = "This engine is running without engine.db, which it could not open when it was started, so lynox does not add to, change or remove from its memory now: a change made now may be missing once the engine opens engine.db again, and a removed entry may come back. Nothing was changed, and nothing is changed later on its own; once someone has restarted the engine, it has to be done again.";

const TASK_HEAD = "This engine is running without engine.db, which it could not open when it was started, so lynox does not add, change, complete or remove tasks now: a change made now may be missing once the engine opens engine.db again, and a completed task may show as open. Nothing was changed, and nothing is changed later on its own; once someone has restarted the engine, it has to be done again.";

export type EngineLessStore = 'memory' | 'task';

/** The refusal of a change to `store` for `reader`. */
export function engineLessStoreText(store: EngineLessStore, reader: EngineLessReader): string {
  return engineLessSentence(store === 'memory' ? MEMORY_HEAD : TASK_HEAD, reader);
}

/**
 * Thrown by a store that refuses a change on an engine without engine.db, carrying both readers'
 * sentences: a tool answers with its message (the model's), an HTTP route with `client` and the
 * code `engine_less`.
 */
export class EngineLessRefused extends Error {
  readonly client: string;
  constructor(store: EngineLessStore) {
    super(engineLessStoreText(store, 'model'));
    this.name = 'EngineLessRefused';
    this.client = engineLessStoreText(store, 'client');
  }
}
