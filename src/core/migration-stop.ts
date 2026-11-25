/**
 * Why a migration export stopped, as a code the Web UI turns into a sentence in its own language.
 *
 * The route's English sentence stays on the stop (`message`) for the log and the API; the UI shows
 * the sentence for `code`, filled from `params`, and follows `retry`. The fine cause (which of the
 * ways a connection can fail) goes to the log, not into the code.
 *
 * No imports: the Web UI's tests read this table too.
 */

/**
 * What the user can do after a stop with this code:
 * - `none`: trying the same again changes nothing; only going back to the inputs helps.
 * - `check`: the restore may have run; check the target before anything else.
 * - `later`: the target may hold its session; try again once it has expired.
 * - `state`: from the state of the target's session when the stop came (`later` while it may hold
 *   one, `now` once it does not, `check` once the restore request went out).
 */
export type MigrationRetryRule = 'none' | 'check' | 'later' | 'state';

/** Every code a migration export can stop with, and the retry each one gives. */
export const MIGRATION_STOP_RETRY = {
  // The start request is turned down (HTTP 400/403, no event stream).
  start_missing_input: 'none',
  start_not_https: 'none',
  start_invalid_url: 'none',
  start_not_public: 'none',
  start_managed: 'none',
  // Preparing the data on this instance.
  vault_key_missing: 'none',
  data_too_large: 'none',
  folder_too_large: 'none',
  export_failed: 'state',
  // Setting up the connection.
  handshake_unreachable: 'state',
  handshake_blocked: 'none',
  handshake_not_lynox: 'none',
  target_session_active: 'later',
  handshake_refused: 'none',
  handshake_unavailable: 'state',
  handshake_unverified: 'none',
  handshake_incomplete: 'state',
  // Before the data is sent.
  manifest_unreachable: 'state',
  manifest_refused: 'none',
  manifest_unavailable: 'state',
  // The parts of the data.
  chunk_unreachable: 'later',
  chunk_refused: 'later',
  // The deadline of the whole transfer.
  transfer_out_of_time: 'later',
  restore_out_of_time: 'check',
  // The restore.
  restore_unreadable: 'check',
  restore_blocked: 'later',
  restore_failed: 'check',
  restore_refused: 'later',
  restore_failed_on_target: 'check',
  // Anything else.
  unknown: 'state',
} as const satisfies Record<string, MigrationRetryRule>;

export type MigrationStopCode = keyof typeof MIGRATION_STOP_RETRY;

/** The codes of a start request that is turned down. */
export const MIGRATION_START_CODES = ['start_missing_input', 'start_not_https', 'start_invalid_url', 'start_not_public', 'start_managed'] as const satisfies readonly MigrationStopCode[];

/**
 * The values a sentence is filled from. Numbers stay numbers (bytes, milliseconds, counts), so the
 * UI writes them in its own language. `targetText` is the target's own words, `detail` this
 * instance's error text, both cleaned; each is absent when nothing readable is left.
 */
export type MigrationStopParams = Readonly<Record<string, string | number | boolean>>;

/**
 * A stop with its code; `message` is the English sentence for the log and the API. `why` is the
 * fine cause within the code's group (how a request failed), for the log only.
 */
export class MigrationStop extends Error {
  constructor(readonly code: MigrationStopCode, message: string, readonly params: MigrationStopParams = {}, readonly why?: string) {
    super(message);
    this.name = 'MigrationStop';
  }
}
