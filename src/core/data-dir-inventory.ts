/**
 * What the engine keeps under the data dir, and whether each entry travels.
 *
 * WHY THIS FILE EXISTS. Backup coverage and migration coverage used to be two
 * hand-maintained lists in two files, and nothing held them together. Measured on a live
 * instance on 2026-08-20: the merge ledger was in NEITHER (so a restore silently ended
 * every past merge's reversibility, while the tool told users it was reversible),
 * `artifacts/` was in migration but not backup, and `apis/`, `files/` and `workspace/`
 * were in neither — one of them holding a customer contract document. None of that was
 * a bug anyone wrote; it is what two parallel lists do.
 *
 * So the lists are now DERIVED from this table. Adding a store here is the only way to
 * change either one, and `data-dir-coverage.test.ts` fails if the engine constructs a
 * data-dir path this table does not declare.
 *
 * WHAT THAT GATE IS WORTH, measured rather than claimed. A review pass built eight ways to
 * write a new store; the first version of the scanner caught ONE of them, and
 * `agent-memory.db` could be deleted from this table with every test still green. It now
 * catches SIX — literal, const, template, concat, a variable aliased from the data dir, and
 * `${dir}/${CONST}` (the shape already in the tree). Two still evade it: a helper that
 * takes the name as a parameter, and a spread argument. Both need dataflow analysis.
 *
 * It also asserts the REVERSE — every row here must be findable in the source unless it
 * carries `sourceInvisible` — so a recall drop shows up as a failing test instead of a
 * table that quietly stops covering things.
 *
 * AND IT CANNOT SEE RUNTIME AT ALL. A directory that arrives some other way is invisible
 * to any code scan, and both leftovers found on a live instance on 2026-08-20 were exactly
 * that: an `ads-optimizer.db` from a feature that never merged, holding one real customer
 * profile, and a hand-placed directory holding a customer contract. `src/scripts/data-dir-sweep.ts`
 * is the runtime half — point it at a data dir and it reports what nobody declared.
 */

/** How the entry is copied — SQLite needs `VACUUM INTO`, the rest is a plain copy. */
export type DataDirKind = 'sqlite' | 'dir' | 'file';

export interface DataDirEntry {
  readonly name: string;
  readonly kind: DataDirKind;
  /** Included in a backup (and therefore restored by `restoreBackup`). */
  readonly backup: boolean;
  /** Included in a migration export (and accepted by the importer). */
  readonly migrate: boolean;
  /**
   * Required whenever the entry is not carried by BOTH paths. An omission has to be a
   * decision someone can read back, not an oversight — which is how all four of the
   * 2026-08-20 gaps got there.
   */
  readonly why?: string;
  /**
   * Set only when the coverage scan genuinely cannot see this entry, with the reason in
   * `why`. It exists to keep the scan's RECALL visible: without it a name the scanner stops
   * finding just quietly drops out, and the table goes on looking complete. A review pass
   * showed that mattered — `agent-memory.db` was declared and unscanned, so deleting its row
   * left every test green.
   */
  readonly sourceInvisible?: boolean;
}

export const DATA_DIR_INVENTORY: readonly DataDirEntry[] = [
  // ── The stores that ARE the user's data ────────────────────────────────────
  { name: 'engine.db', kind: 'sqlite', backup: true, migrate: true },
  { name: 'history.db', kind: 'sqlite', backup: true, migrate: true },
  { name: 'datastore.db', kind: 'sqlite', backup: true, migrate: true },
  { name: 'agent-memory.db', kind: 'sqlite', backup: true, migrate: true },
  {
    name: 'mail-state.db', kind: 'sqlite', backup: true, migrate: false,
    why: 'HELD BACK deliberately, and this row is the record of why. Carrying it is WANTED — a migrating customer otherwise loses their correspondence and its processing state — but `mail_accounts` holds live IMAP/SMTP hosts and `collectSecrets` ships the WHOLE vault, so the destination would boot with working credentials and begin polling a mailbox the source may still be polling. The wanted shape is "migrate, but land the accounts PAUSED", and there is no paused state to land them in: the table has no such column. Shipping the unpaused half would be shipping the thing that was rejected, so this waits for a disabled/paused flag on `mail_accounts` plus an import step that sets it.',
  },
  { name: 'memory', kind: 'dir', backup: true, migrate: true },
  { name: 'artifacts', kind: 'dir', backup: true, migrate: true },
  { name: 'apis', kind: 'dir', backup: true, migrate: true },
  { name: 'workspace', kind: 'dir', backup: true, migrate: true },
  { name: 'sweeps', kind: 'dir', backup: true, migrate: true },
  { name: 'config.json', kind: 'file', backup: true, migrate: true },

  // ── Carried by backup, deliberately NOT by migration ───────────────────────
  {
    name: 'vault.db', kind: 'sqlite', backup: true, migrate: false,
    why: 'secrets travel as their own encrypted chunk, re-wrapped under the DESTINATION vault key — copying the source database would move ciphertext the destination cannot open',
  },
  {
    name: 'push-subscriptions.db', kind: 'sqlite', backup: true, migrate: false,
    why: 'a push subscription names a browser endpoint bound to THIS deployment\'s VAPID identity; migrated, every one of them is dead on arrival',
  },
  {
    name: 'vapid-keys.json', kind: 'file', backup: true, migrate: false,
    why: 'the push identity itself — same reason as the subscriptions it signs for',
  },
  {
    name: 'sessions', kind: 'dir', backup: true, migrate: false, sourceInvisible: true,
    why: 'listed by backup since before this table existed, and NO source file constructs it today (grep + the scan below both come back empty) — kept because a backup of a directory that may exist on an older instance costs nothing, and removing it is a separate decision from writing this table',
  },

  // ── Carried by neither, each for a stated reason ───────────────────────────
  {
    name: 'backups', kind: 'dir', backup: false, migrate: false,
    why: 'the backup destination — including it would make every backup contain its predecessors',
  },
  {
    name: 'vault.key', kind: 'file', backup: false, migrate: false,
    why: 'the key an encrypted backup is derived FROM (`deriveBackupKey`); shipping it alongside the ciphertext would defeat the encryption entirely',
  },
  {
    name: 'secrets.json', kind: 'file', backup: false, migrate: false,
    why: 'plaintext import/export staging for the vault, not a store — it is written on demand and is not expected to persist',
  },
  {
    name: 'http-secret', kind: 'file', backup: false, migrate: false,
    why: 'this deployment\'s API bearer; a restore or a migration must not silently re-point existing clients at a new instance holding the old secret',
  },
  {
    name: '.cache-salt', kind: 'file', backup: false, migrate: false,
    why: 'per-tenant partition for a shared provider cache key — regenerated on demand, and MIGRATING it would be a defect: two instances sharing a salt collide in exactly the partition it exists to separate',
  },
  {
    name: '.last_version', kind: 'file', backup: false, migrate: false,
    why: 'derived upgrade bookkeeping, rewritten on every boot',
  },
  {
    // Found by the scan, not by anyone remembering it — which is the point of the scan.
    name: '.tos-accepted-1', kind: 'file', backup: false, migrate: false,
    why: 'records that THIS installation\'s operator accepted the terms; an acceptance is personal to the person who gave it and must not ride a restore or a migration into an installation whose operator never saw the dialog',
  },
  {
    name: 'plugins', kind: 'dir', backup: false, migrate: false,
    why: 'third-party code, installed rather than authored here; a restore should re-install it, not resurrect whatever binary was on disk',
  },
  {
    name: 'pricing.json', kind: 'file', backup: false, migrate: false,
    why: 'a cached provider catalogue — restoring a stale copy would bill against prices that no longer exist',
  },
  {
    name: 'batch-index.json', kind: 'file', backup: false, migrate: false,
    why: 'in-flight provider batch handles; they do not survive a move to another host',
  },
  {
    name: 'wire-sink', kind: 'dir', backup: false, migrate: false,
    why: 'operator debug capture, off by default and gated off entirely on provisioned containers',
  },
  {
    name: 'wire-sink-on', kind: 'file', backup: false, migrate: false,
    why: 'the arming marker for the debug capture above — an arming state must never be restored implicitly',
  },
  {
    name: 'wire-sink-raw', kind: 'dir', backup: false, migrate: false,
    why: 'raw variant of the debug capture',
  },
  {
    name: 'wire-sink-raw-on', kind: 'file', backup: false, migrate: false,
    why: 'arming marker for the raw debug capture',
  },
];

const by = (pred: (e: DataDirEntry) => boolean, kind: DataDirKind): readonly string[] =>
  DATA_DIR_INVENTORY.filter(e => e.kind === kind && pred(e)).map(e => e.name);

/** Backup: the three lists `BackupManager` copies, derived so they cannot drift apart. */
export const BACKUP_SQLITE_DBS = by(e => e.backup, 'sqlite');
export const BACKUP_COPY_DIRS = by(e => e.backup, 'dir');
export const BACKUP_COPY_FILES = by(e => e.backup, 'file');

/** Migration: the databases the exporter ships and the importer accepts. */
export const MIGRATE_SQLITE_DBS = by(e => e.migrate, 'sqlite');
/** Migration: directories carried by their own collectors (memory, artifacts, sweeps, …). */
export const MIGRATE_DIRS = by(e => e.migrate, 'dir');

/**
 * Portable directories carried by the GENERIC collector rather than a bespoke one.
 * `memory/`, `artifacts/` and `sweeps/` each have their own (they carry structure the
 * importer must understand); these two are opaque file trees.
 */
export const GENERIC_PORTABLE_DIRS: readonly string[] = ['apis', 'workspace'];

/** Total bytes a single portable directory may contribute to a bundle. */
export const MAX_PORTABLE_DIR_BYTES = 64 * 1024 * 1024;

/** Maximum entries a single portable directory may contribute — bounds inodes, not just bytes. */
export const MAX_PORTABLE_DIR_ENTRIES = 20_000;

/**
 * The one predicate both sides use for an entry key inside a portable directory, so export
 * and import cannot drift into shipping what cannot be restored — and so the importer has a
 * single traversal guard.
 *
 * Relative POSIX path: no absolute form, no `..` segment, no backslash (a separator on a
 * platform the IMPORTER might run on even when the exporter's was not), no control
 * characters, bounded depth and length.
 */
export function isPortableDirEntryName(rel: string): boolean {
  if (rel.length === 0 || rel.length > 512) return false;
  if (rel.startsWith('/') || rel.includes('\\')) return false;
  for (let i = 0; i < rel.length; i++) {
    const code = rel.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  const parts = rel.split('/');
  if (parts.length > 16) return false;
  return parts.every(p => p.length > 0 && p !== '.' && p !== '..');
}
