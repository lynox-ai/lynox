/**
 * Keeps the runs of a deleted chat blank after the delete.
 *
 * Deleting a chat blanks the content its runs hold at that moment (`blankRunHistoryRows`). A run
 * still going can write afterwards: its final answer, a tool call, a spawned run, a workflow step,
 * a security event, a question. Those writers live on more than one connection to history.db and
 * there are many of them, so the guard sits in the file itself: triggers that blank any content
 * written for a run of a deleted chat, whoever writes it. A writer added later is covered without
 * knowing about this, as long as its table is in {@link FALLBACK_CONTENT_COLUMNS}.
 *
 * `deleted_chat_runs` holds the ids of those runs and workflows: the delete adds what it reached,
 * and the triggers add every run or workflow that starts later under one of them or under a deleted
 * chat. It holds ids only, nothing a user wrote.
 *
 * The triggers are rebuilt from {@link FALLBACK_CONTENT_COLUMNS} on every open rather than written
 * as a migration, so a column added to that map is covered from the next start on.
 */
import { DELETED_CHAT_RUNS, FALLBACK_CONTENT_COLUMNS, FALLBACK_MARKER } from './connection-erasure.js';

const IN_SCOPE = (expr: string): string => `${expr} IN (SELECT id FROM ${DELETED_CHAT_RUNS})`;
const IN_DELETED_CHAT = (expr: string): string => `${expr} IN (SELECT id FROM deleted_threads)`;

/**
 * How a row of each content table belongs to a run or workflow of a deleted chat, given the row as
 * `NEW`. Every table of {@link FALLBACK_CONTENT_COLUMNS} needs an entry; a test holds the two sets
 * equal, so a new content table without one fails there.
 */
export const GUARDED_ROWS: Readonly<Record<string, string>> = {
  advisor_suggestions: IN_SCOPE('NEW.run_id'),
  pending_prompts: `(${IN_SCOPE('NEW.session_id')} OR ${IN_DELETED_CHAT('NEW.session_id')})`,
  pipeline_runs: IN_SCOPE('NEW.id'),
  pipeline_step_results: IN_SCOPE('NEW.pipeline_run_id'),
  pre_approval_events: `(${IN_SCOPE('NEW.run_id')} OR EXISTS (SELECT 1 FROM pre_approval_sets WHERE id = NEW.set_id AND ${IN_SCOPE('run_id')}))`,
  pre_approval_sets: IN_SCOPE('NEW.run_id'),
  processes: IN_SCOPE('NEW.source_run_id'),
  run_tool_calls: IN_SCOPE('NEW.run_id'),
  runs: IN_SCOPE('NEW.id'),
  security_events: IN_SCOPE('NEW.run_id'),
  wire_snapshots: IN_SCOPE('NEW.run_id'),
};

/**
 * A run or workflow that starts under a guarded one, or under a deleted chat, joins the scope
 * before its content is checked. A step run carries its workflow's id as session and spawn parent.
 */
const JOINS: Readonly<Record<string, { readonly when: string; readonly columns: readonly string[] }>> = {
  runs: {
    when: `${IN_DELETED_CHAT('NEW.session_id')} OR ${IN_SCOPE('NEW.session_id')} OR ${IN_SCOPE('NEW.spawn_parent_id')} OR ${IN_SCOPE('NEW.batch_parent_id')}`,
    columns: ['session_id', 'spawn_parent_id', 'batch_parent_id'],
  },
  pipeline_runs: {
    when: `${IN_DELETED_CHAT('NEW.origin_thread_id')} OR ${IN_SCOPE('NEW.parent_run_id')}`,
    columns: ['origin_thread_id', 'parent_run_id'],
  },
};

const quote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Drops every trigger of the guard. Run before a pending migration: a trigger left from the last
 * start names columns and tables a migration may drop or rename, and SQLite refuses that while a
 * trigger still names them. The guard is created again after them ({@link deletedChatGuardDdl}), in the same transaction.
 */
export function dropDeletedChatGuardDdl(): string {
  return Object.keys(FALLBACK_CONTENT_COLUMNS)
    .map((table) => `DROP TRIGGER IF EXISTS deleted_chat_insert_${table}; DROP TRIGGER IF EXISTS deleted_chat_update_${table};`)
    .join('\n');
}

/**
 * The DDL of the guard: its table, then the two triggers of each content table in `tables` (the
 * tables the file holds; a content table it lacks gets none). Expects the triggers dropped first.
 */
export function deletedChatGuardDdl(tables: ReadonlySet<string>): string {
  const marker = quote(FALLBACK_MARKER);
  const parts = [`CREATE TABLE IF NOT EXISTS ${DELETED_CHAT_RUNS} (id TEXT PRIMARY KEY);`];
  for (const [table, columns] of Object.entries(FALLBACK_CONTENT_COLUMNS)) {
    if (!tables.has(table)) continue;
    const belongs = GUARDED_ROWS[table];
    if (belongs === undefined) throw new Error(`deleted-chat guard: no rule for content table ${table}`);
    const key = table === 'pipeline_runs' || table === 'runs' ? 'id' : 'rowid';
    const held = (c: string): string => `(NEW."${c}" IS NOT NULL AND NEW."${c}" NOT IN ('', '{}', ${marker}))`;
    const anyHeld = columns.map(held).join(' OR ');
    const set = columns.map((c) => `"${c}" = CASE WHEN "${c}" IS NULL OR "${c}" IN ('', '{}') THEN "${c}" ELSE ${marker} END`).join(', ');
    // A question asked under a deleted chat could only be answered there, and its text is blanked
    // now: it is closed, also one a schedule parked, so nobody answers a question they cannot read.
    const close = table === 'pending_prompts'
      ? ` UPDATE pending_prompts SET status = 'expired', closed_reason = 'thread_deleted' WHERE rowid = NEW.rowid AND status = 'pending';`
      : '';
    const blank = `UPDATE "${table}" SET ${set} WHERE ${key} = NEW.${key};`;
    const join = JOINS[table];
    // A parent set after the insert joins the row too: the update trigger also listens on it.
    const joinStep = join === undefined ? '' : ` INSERT OR IGNORE INTO ${DELETED_CHAT_RUNS} (id) SELECT NEW.id WHERE ${join.when};`;
    const member = join === undefined ? belongs : `(${join.when} OR ${belongs})`;
    const watched = [...columns, ...(join?.columns ?? [])];
    parts.push(
      `CREATE TRIGGER deleted_chat_insert_${table} AFTER INSERT ON "${table}" WHEN ${member}
       BEGIN${joinStep} ${blank}${close} END;`,
      `CREATE TRIGGER deleted_chat_update_${table} AFTER UPDATE OF ${watched.map((c) => `"${c}"`).join(', ')} ON "${table}"
       WHEN ${member} AND (${anyHeld})
       BEGIN${joinStep} ${blank} END;`,
    );
  }
  return parts.join('\n');
}
