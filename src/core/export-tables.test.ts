import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { DataStore } from './data-store.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { MailStateDb } from '../integrations/mail/state.js';
import { InboxStateDb } from '../integrations/inbox/state.js';
import { DATA_DIR_INVENTORY } from './data-dir-inventory.js';
import { inventoryExportWelds } from './data-dir-inventory-welds.js';
import { DATASTORE_EXPORT, EXPORT_TABLES, GRANT_RECORD_PATHS, KEYED_COLUMNS, type ExportedStore } from './export-tables.js';
import { withoutFingerprints, type ApiProfile } from './api-store.js';

/** Each store, created and migrated the way the engine creates it. */
function migratedStores(): { dir: string; tables: (file: string) => Map<string, string[]> } {
  const dir = mkdtempSync(join(tmpdir(), 'export-tables-'));
  const key = 'k'.repeat(64);
  new EngineDb(join(dir, 'engine.db'), key).close();
  new RunHistory(join(dir, 'history.db'), key).close();
  new DataStore(join(dir, 'datastore.db')).close();
  new AgentMemoryDb(join(dir, 'agent-memory.db')).close();
  const mail = new MailStateDb({ path: join(dir, 'mail-state.db') });
  new InboxStateDb(mail.getConnection());
  mail.close();
  return {
    dir,
    tables: (file) => {
      const db = new Database(join(dir, file), { readonly: true });
      try {
        const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
          .map(r => r.name);
        return new Map(names.map(n => [n, (db.prepare('SELECT name FROM pragma_table_info(?)').all(n) as Array<{ name: string }>).map(c => c.name)]));
      } finally {
        db.close();
      }
    },
  };
}

describe('the export decides every store and every table', () => {
  it('every inventory entry carries an export decision, and an entry without one does not compile', () => {
    // The compile half lives in data-dir-inventory-welds.ts (src, so tsc reads it); importing
    // it here is what makes deleting that file a failure.
    expect(typeof inventoryExportWelds).toBe('function');
    for (const e of DATA_DIR_INVENTORY) expect(['include', 'name', 'never']).toContain(e.export.by);
  });

  it('the SQLite stores the inventory includes are exactly the ones with a table list, plus the datastore rule', () => {
    const included = DATA_DIR_INVENTORY.filter(e => e.kind === 'sqlite' && e.export.by === 'include').map(e => e.name).sort();
    expect(included).toEqual([...Object.keys(EXPORT_TABLES), 'datastore.db'].sort());
  });

  it('each store\'s tables after its migrations are exactly the tables its list decides', () => {
    const { dir, tables } = migratedStores();
    try {
      for (const store of Object.keys(EXPORT_TABLES) as ExportedStore[]) {
        const list = EXPORT_TABLES[store];
        const decided = [...Object.keys(list.include), ...Object.keys(list.name)];
        // A table in both halves is two decisions, and only one of them can be meant.
        expect(Object.keys(list.include).filter(t => t in list.name), store).toEqual([]);
        expect([...tables(store).keys()].sort(), store).toEqual(decided.sort());
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every column a decision names exists in its table', () => {
    const { dir, tables } = migratedStores();
    try {
      for (const store of Object.keys(EXPORT_TABLES) as ExportedStore[]) {
        const actual = tables(store);
        for (const [table, d] of Object.entries(EXPORT_TABLES[store].include)) {
          const cols = actual.get(table) ?? [];
          for (const c of [...(d.strip ?? []), ...(d.encrypted ?? []), ...Object.keys(d.stripJson ?? {})]) {
            expect(cols, `${store}.${table}.${c}`).toContain(c);
          }
          // A column both stripped and decrypted is a contradiction the export would resolve silently.
          expect((d.strip ?? []).filter(c => (d.encrypted ?? []).includes(c)), `${store}.${table}`).toEqual([]);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the datastore carries its registry by rule, and its migrated file holds nothing else', () => {
    const { dir, tables } = migratedStores();
    try {
      const store = new DataStore(join(dir, 'datastore.db'));
      store.createCollection({ name: 'leads', scope: { type: 'global', id: 'global' }, columns: [{ name: 'email', type: 'string' }] });
      store.close();
      const names = [...tables('datastore.db').keys()].sort();
      expect(names).toEqual([DATASTORE_EXPORT.registry, `${DATASTORE_EXPORT.tablePrefix}leads`]);
      const db = new Database(join(dir, 'datastore.db'), { readonly: true });
      const registered = (db.prepare(`SELECT name FROM ${DATASTORE_EXPORT.registry}`).all() as Array<{ name: string }>).map(r => r.name);
      db.close();
      expect(registered).toEqual(['leads']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Where a keyed digest is computed. A file that STORES one must have its column in
 * `KEYED_COLUMNS` (an API profile's grant field in `GRANT_RECORD_PATHS`); a file that only
 * computes one to compare or to sign a plan is named with the reason. A new file that calls
 * either function fails the scan until someone decides which it is.
 */
const KEYED_CALLERS: Readonly<Record<string, string>> = {
  'src/core/approval-store.ts': 'stores: approval_entries.checksum, dedup_key, family_key',
  'src/core/bulk-ledger.ts': 'stores: bulk_runs.rule_hash, judge_rule_hash, approval_checksum; computes only: the list-start and resume checksums',
  'src/core/workflow-grant.ts': 'stores: workflow_grants.checksum and the reviewedGrant stamp in workflows.definition_json',
  'src/core/engine.ts': 'stores: the grant fingerprints, handed to ApiStore.setFingerprinter, in the API profile (connections.config_json and apis/*.json)',
  'src/server/http-api.ts': 'stores: the store binding in the API profile, as above',
  'src/core/person-erasure.ts': 'computes only: the plan digest a confirmation must repeat',
  'src/tools/builtin/http.ts': 'computes only: the store binding, compared against the stored one',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('keyed digests never leave the instance', () => {
  it('every stored keyed column is stripped from the export', () => {
    for (const k of KEYED_COLUMNS) {
      const d = EXPORT_TABLES[k.store].include[k.table];
      expect(d, `${k.store}.${k.table}`).toBeDefined();
      if (k.jsonPath === undefined) expect(d?.strip ?? [], `${k.table}.${k.column}`).toContain(k.column);
      else expect(d?.stripJson?.[k.column] ?? [], `${k.table}.${k.column} ${k.jsonPath}`).toContain(k.jsonPath);
    }
  });

  it('the grant paths stripped are the fields the engine itself never hands out, plus the store binding', () => {
    const grant = { fingerprints: ['a'], fingerprint_check: 'b', foreign: ['c'], store_binding: 'd', status: 'active' };
    const kept = withoutFingerprints({ id: 'p', name: 'p', oauth_grant: grant } as unknown as ApiProfile).oauth_grant ?? {};
    const removed = Object.keys(grant).filter(k => !(k in kept));
    expect([...removed, 'store_binding'].map(k => `$.oauth_grant.${k}`).sort()).toEqual([...GRANT_RECORD_PATHS].sort());
  });

  it('the files that compute a keyed digest are exactly the ones accounted for', () => {
    const root = join(__dirname, '..', '..');
    // A call, not a definition or signature: those name a typed parameter (`keyedHash(parts: …`).
    const call = /\b(?:keyedHash|storeBindingDigest)\??\.?\((?!\s*\w+\??\s*:)/;
    const callers = sourceFiles(join(root, 'src'))
      .filter(f => readFileSync(f, 'utf8').split('\n').some(line => call.test(line) && !/^\s*(?:\*|\/\/)/.test(line)))
      .map(f => relative(root, f))
      .filter(f => f !== 'src/core/engine-db.ts')
      .sort();
    expect(callers).toEqual(Object.keys(KEYED_CALLERS).sort());
  });
});

/**
 * Where a column is encrypted (`EngineDb.enc`, `RunHistory._enc`), and the columns the map
 * names for it. A file that starts encrypting fails the scan until its column is in the map;
 * a column the map misses would otherwise reach the archive as raw `enc:` text.
 */
const ENC_WRITERS: Readonly<Record<string, readonly string[]>> = {
  'src/core/approval-store.ts': ['approval_entries.payload_json', 'approval_entries.result_json'],
  'src/core/bulk-ledger.ts': ['bulk_runs.list_source', 'bulk_runs.judge_rule', 'bulk_targets.target_key', 'bulk_targets.before', 'bulk_targets.after_planned', 'bulk_targets.after_actual', 'bulk_targets.result'],
  'src/core/inbound-events.ts': ['inbound_events.values_json'],
  'src/core/knowledge-store.ts': ['knowledge_entries.text', 'entry_sources.text', 'memory_blocks.content'],
  'src/core/memory-graph-store.ts': ['memories.text'],
  'src/core/run-history.ts': ['runs.task_text', 'runs.response_text', 'runs.error_text', 'run_tool_calls.input_json', 'run_tool_calls.output_json', 'wire_snapshots.user_message'],
  'src/core/subject-store.ts': ['people.email', 'people.phone', 'organizations.vat_id'],
}

describe('every encrypted column is in the map', () => {
  it('the files that encrypt a column are exactly the ones accounted for', () => {
    const root = join(__dirname, '..', '..');
    const call = /\.(?:_)?enc\(/;
    const writers = sourceFiles(join(root, 'src'))
      .filter(f => readFileSync(f, 'utf8').split('\n').some(line => call.test(line) && !/^\s*(?:\*|\/\/)/.test(line)))
      .map(f => relative(root, f))
      .sort();
    expect(writers).toEqual(Object.keys(ENC_WRITERS).sort());
  });

  it('every column ENC_WRITERS names is encrypted in the map', () => {
    const mapped = new Set<string>();
    for (const store of Object.keys(EXPORT_TABLES) as ExportedStore[]) {
      for (const [t, d] of Object.entries(EXPORT_TABLES[store].include)) for (const c of d.encrypted ?? []) mapped.add(`${t}.${c}`);
    }
    const named = Object.values(ENC_WRITERS).flat();
    expect([...named].sort()).toEqual([...mapped].sort());
  });
});
