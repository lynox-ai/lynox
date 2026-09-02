import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
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

/**
 * Every name the source uses directly under the data dir.
 *
 * Recall is the whole question here, so it is MEASURED rather than assumed — see the
 * "declares every name" test, which asserts in BOTH directions: nothing scanned may be
 * undeclared, and nothing declared may be unscanned unless the row says why. A review pass
 * defeated the first version with seven shapes, one of them already in the tree
 * (`engine-init.ts` builds the agent-memory path from a template literal and a const), and
 * `agent-memory.db` could then be deleted from the table with every test still green.
 */
const DIRISH = /lynoxdir|datadir|LYNOX_DIR|DATA_DIR/i;

function scanDataDirNames(): Map<string, string[]> {
  const found = new Map<string, string[]>();

  const visitFile = (file: string, label: string): void => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);

    // `const X = 'literal'`, so `join(dir, AGENT_MEMORY_DB_NAME)` resolves — and any
    // variable initialised FROM a dirish expression, so `const root = getLynoxDir()`
    // makes `join(root, 'x')` visible even though `root` is not named like a dir.
    const consts = new Map<string, string>();
    const dirAliases = new Set<string>();
    const collectConsts = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer)) {
          consts.set(node.name.text, node.initializer.text);
        } else if (DIRISH.test(node.initializer.getText())
                   && !/\b(join|resolve)\s*\(/.test(node.initializer.getText())) {
          // DIRECT alias only. `const root = getLynoxDir()` is the data dir;
          // `const artifactsDir = join(lynoxDir, 'artifacts')` is a directory INSIDE it, and
          // treating that as an alias reports every file under it as a root-level store.
          dirAliases.add(node.name.text);
        }
      }
      ts.forEachChild(node, collectConsts);
    };
    collectConsts(sf);
    const isDirish = (node: ts.Node): boolean => {
      const text = node.getText();
      return DIRISH.test(text) || dirAliases.has(text);
    };

    const literalOf = (node: ts.Node | undefined): string | null => {
      if (!node) return null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
      if (ts.isIdentifier(node)) return consts.get(node.text) ?? null;
      if (ts.isTemplateExpression(node)) {
        // `${PREFIX}store` — resolvable when every substitution is a known const.
        let out = node.head.text;
        for (const span of node.templateSpans) {
          const part = literalOf(span.expression);
          if (part === null) return null;
          out += part + span.literal.text;
        }
        return out;
      }
      return null;
    };

    const record = (name: string, node: ts.Node): void => {
      if (name === '' || name === '.' || name === '..') return;   // walks OUT of the dir
      const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      // Only the FIRST segment is an entry in the data dir; the rest are inside it.
      const head = name.replace(/^[/\\]+/, '').split(/[/\\]/)[0]!;
      if (head === '' || head === '.' || head === '..') return;
      // An entry in the data dir is a FILENAME. Without this the template branch also
      // matches prose that merely mentions LYNOX_DATA_DIR — a CLI help string did exactly
      // that and arrived as an "undeclared store".
      if (!/^[A-Za-z0-9._-]+$/.test(head)) return;
      found.set(head, [...(found.get(head) ?? []), `${label}:${line}`]);
    };

    const walk = (node: ts.Node): void => {
      // join(<dirish>, '<name>') / join(<dirish>, CONST)
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText();
        if (/(^|\.)(join|resolve)$/.test(callee)) {
          const [base, second] = node.arguments;
          if (base && second && isDirish(base)) {
            const lit = literalOf(second);
            if (lit !== null) record(lit, node);
          }
        }
      }
      // `${dirish}/name` and `${dirish}/${CONST}`
      if (ts.isTemplateExpression(node) && (DIRISH.test(node.getText()) || node.templateSpans.some(sp => isDirish(sp.expression)))) {
        const spans = node.templateSpans;
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i]!;
          if (!isDirish(span.expression)) continue;
          const tail = span.literal.text;                       // e.g. "/" or "/memory"
          const rest = tail.replace(/^[/\\]+/, '');
          if (rest.length > 0) { record(rest, node); continue; }
          const next = spans[i + 1];
          if (next) { const lit = literalOf(next.expression); if (lit !== null) record(lit, node); }
        }
      }
      // dirish + '/name'
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
          && isDirish(node.left)) {
        const lit = literalOf(node.right);
        if (lit !== null) record(lit, node);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  };

  const walkDir = (dir: string, label: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walkDir(p, `${label}/${entry}`);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) visitFile(p, `${label}/${entry}`);
    }
  };
  walkDir(SRC, 'src');
  const repoScripts = join(SRC, '..', 'scripts');
  if (existsSync(repoScripts)) walkDir(repoScripts, 'scripts');
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

  it('finds every declared entry in the source — recall is measured, not assumed', () => {
    // The reverse direction, and the one a review pass showed was missing. Forward-only,
    // the table looks complete while the scanner quietly stops seeing things: seven path
    // shapes evaded the first version, one of them (`${lynoxDir}/${CONST}` in
    // engine-init.ts) already in the tree — so `agent-memory.db` could be deleted from the
    // inventory with every test still green.
    //
    // A row the scan cannot see must say so explicitly, which turns a silent recall drop
    // into an edit someone has to justify.
    const scanned = scanDataDirNames();
    const declaredButUnseen = DATA_DIR_INVENTORY
      .filter(e => !e.sourceInvisible && !scanned.has(e.name))
      .map(e => e.name);

    // The opt-out has to be honest too: marking a row invisible that the scanner CAN see
    // would silently disable its half of the check, and "mark everything invisible" would
    // hollow the whole test out.
    const falselyInvisible = DATA_DIR_INVENTORY
      .filter(e => e.sourceInvisible && scanned.has(e.name))
      .map(e => e.name);
    expect(falselyInvisible, 'sourceInvisible is set on an entry the scan does find — drop the flag').toEqual([]);

    expect(declaredButUnseen, [
      'The inventory declares an entry the data-dir scan cannot find.',
      'Either the scanner lost a path shape it used to see — fix it, that is the recall this',
      'file exists to protect — or the entry genuinely is not constructed in the source, in',
      'which case set sourceInvisible:true and say why.',
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
