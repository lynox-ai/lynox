import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { MigrationExporter } from './migration-export.js';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  DATA_DIR_INVENTORY,
  BACKUP_SQLITE_DBS, BACKUP_COPY_DIRS, BACKUP_COPY_FILES,
  MIGRATE_SQLITE_DBS, MIGRATE_DIRS, GENERIC_PORTABLE_DIRS,
} from './data-dir-inventory.js';

/**
 * Backup coverage and migration coverage were two hand-maintained lists that nothing held
 * together, and they drifted — measured on a live instance 2026-08-20: the merge ledger in
 * NEITHER, `artifacts/` in migration only, `apis/`/`workspace/` in neither. This is the
 * mechanism that replaces the prose "remember to add it to both".
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every string literal the source uses as a name directly under the data dir. */
function scanDataDirNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const DIRISH = /lynoxdir|datadir|dataDir|LYNOX_DIR|DATA_DIR/i;

  const visitFile = (file: string): void => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText();
        if (callee === 'join' || callee === 'path.join' || callee === 'resolve' || callee === 'path.resolve') {
          const [base, second] = node.arguments;
          if (base && second && DIRISH.test(base.getText())
              && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second))) {
            const name = second.text;
            // `join(dir, '..')` walks OUT of the data dir — not an entry in it.
            if (name !== '..' && name !== '.') {
              const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              found.set(name, [...(found.get(name) ?? []), `${file.slice(SRC.length + 1)}:${line}`]);
            }
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  };

  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) visitFile(p);
    }
  };
  walkDir(SRC);
  return found;
}

describe('data-dir coverage', () => {
  const declared = new Set(DATA_DIR_INVENTORY.map(e => e.name));

  it('declares every data-dir name the source constructs', () => {
    const scanned = scanDataDirNames();
    // Guards the guard: a collector that silently stopped seeing `join(lynoxDir, …)` calls
    // would make every assertion below pass vacuously. There are ~29 such names today.
    expect(scanned.size, 'the data-dir scanner found almost nothing — it is broken, not the tree')
      .toBeGreaterThan(15);

    const undeclared = [...scanned.entries()]
      .filter(([name]) => !declared.has(name))
      .map(([name, locs]) => `${name} (${locs[0]})`);

    expect(undeclared, [
      'A new store appeared under the data dir and data-dir-inventory.ts does not mention it.',
      'Decide whether it travels: add it with backup/migrate flags, and a `why` for anything',
      'either path does not carry. That decision is the whole point — the merge ledger was',
      'missed by BOTH lists for months because nothing forced anyone to make it.',
    ].join(' ')).toEqual([]);
  });

  it('gives a reason for everything it does not carry', () => {
    const silent = DATA_DIR_INVENTORY
      .filter(e => (!e.backup || !e.migrate) && (e.why === undefined || e.why.trim().length < 20))
      .map(e => e.name);
    expect(silent, 'an omission has to be a decision someone can read back, not an oversight').toEqual([]);
  });

  it('derives the backup lists from the inventory, with nothing dropped', () => {
    const inBackup = new Set([...BACKUP_SQLITE_DBS, ...BACKUP_COPY_DIRS, ...BACKUP_COPY_FILES]);
    expect([...inBackup].sort()).toEqual(DATA_DIR_INVENTORY.filter(e => e.backup).map(e => e.name).sort());
    // The backup destination must never be inside its own source set.
    expect(inBackup.has('backups')).toBe(false);
    // Nor the key an encrypted backup is derived from.
    expect(inBackup.has('vault.key')).toBe(false);
  });

  it('every database the exporter ships is one the importer accepts', () => {
    const importer = readFileSync(join(SRC, 'core', 'migration-import.ts'), 'utf-8');
    expect(importer, 'the importer re-states its whitelist instead of deriving it — they will drift')
      .toContain('new Set<string>(MIGRATE_SQLITE_DBS)');
    expect(MIGRATE_SQLITE_DBS.length).toBeGreaterThan(0);
  });

  it('every directory declared portable is actually carried by a real export', () => {
    // BEHAVIOURAL, not a grep. The first version of this test searched the exporter source
    // for the directory's name and would have passed on a comment mentioning it — the
    // string-counting-guard shape. This runs a real export over a temp data dir seeded with
    // one file per portable directory and asserts a chunk comes back for each. A
    // declaration with no transport behind it is the failure this whole file exists to stop.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-coverage-'));
    try {
      for (const name of MIGRATE_DIRS) {
        mkdirSync(join(dir, name), { recursive: true });
      }
      // Names each collector will accept: memory wants scope/namespace, sweeps wants a
      // ledger name, the rest take any plain file.
      writeFileSync(join(dir, 'memory', 'global-probe.txt'), 'x', 'utf-8');
      mkdirSync(join(dir, 'memory', 'global'), { recursive: true });
      writeFileSync(join(dir, 'memory', 'global', 'knowledge.txt'), 'probe', 'utf-8');
      writeFileSync(join(dir, 'sweeps', 'merge-2026-08-20T10-00-00-000Z-cov123.json'),
        JSON.stringify({ version: 1, phase: 'merge', entry: {}, dataStore: [], threadAnchors: [], applied: true }), 'utf-8');
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, 'artifacts', 'index.json'), JSON.stringify([{ id: 'abcdef01', title: 't' }]), 'utf-8');
      writeFileSync(join(dir, 'artifacts', 'abcdef01.html'), '<p>probe</p>', 'utf-8');
      for (const name of GENERIC_PORTABLE_DIRS) {
        writeFileSync(join(dir, name, 'probe.bin'), Buffer.from([0x00, 0xff, 0x10]));
      }

      const exporter = new MigrationExporter({ lynoxDir: dir, vaultKey: 'coverage-probe-key-0000000000' });
      const preview = exporter.preview();
      expect(preview, 'exporter could not even preview the probe tree').toBeDefined();

      const { manifest } = exporter.export(Buffer.alloc(32, 7));
      const carried = new Set(manifest.chunks.map(c => c.type === 'portable_dir' ? c.name.split(':')[0]! : c.type));

      const notCarried = MIGRATE_DIRS.filter(name => !carried.has(name));
      expect(notCarried, [
        'A directory is declared portable but a real export did not carry it.',
        'Either write the collector or set migrate:false with a `why` — do not leave the',
        'inventory claiming a transport that does not exist.',
      ].join(' ')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
