/**
 * Source scans for the write sites (`instance-trail.ts`), over the TypeScript AST of
 * the engine's own source (`src/**\/*.ts` without tests), not over text: a comment or a string
 * that mentions a label is no call.
 *
 * 1. Every `withInstanceWrite` call names its site as a string literal in an object literal, every
 *    literal is the site of exactly one call, and every entry of `INSTANCE_WRITE_SITES` has its
 *    call, and `MANDATE_INSIDE_WRITERS` requires a site per writer.
 * 2. The writing handlers make no write past the objects handed to them (a direct file or
 *    database write) other than the ones on a closed list, each with its reason. A store method
 *    on a passed object is no finding: the fixtures in `mandate-inside-writes.test.ts` hand those
 *    in wrapped, and see every such call.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { INSTANCE_WRITE_SITES } from './mandate-tool-lock.js';

const SRC = resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...sourceFiles(p)); continue; }
    if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

interface SiteCall { file: string; line: number; site: string | null; problem?: string }

/** Every reference to `withInstanceWrite` in `sf`: a call with its literal site, or a problem. */
function siteCallsOf(sf: ts.SourceFile): SiteCall[] {
  const file = relative(SRC, sf.fileName);
  const out: SiteCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'withInstanceWrite') {
      const parent = node.parent;
      const renamed = (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
        && parent.propertyName !== undefined && parent.propertyName.text !== parent.name.text;
      const declaration = (ts.isFunctionDeclaration(parent) && parent.name === node)
        || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent);
      // A call under another name would be invisible to the count below.
      if (renamed) out.push({ file, line: lineOf(sf, node), site: null, problem: 'imported or exported under another name' });
      else if (!declaration) {
        if (!ts.isCallExpression(parent) || parent.expression !== node) {
          out.push({ file, line: lineOf(sf, node), site: null, problem: 'referenced other than as a call' });
        } else {
          const spec = parent.arguments[1];
          if (spec === undefined || !ts.isObjectLiteralExpression(spec)) {
            out.push({ file, line: lineOf(sf, node), site: null, problem: 'spec is not an object literal' });
          } else {
            const prop = spec.properties.find(p => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === 'site');
            if (prop === undefined || !ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.initializer)) {
              out.push({ file, line: lineOf(sf, node), site: null, problem: 'site is not a string literal' });
            } else {
              out.push({ file, line: lineOf(sf, node), site: prop.initializer.text });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('INSTANCE_WRITE_SITES against the source', () => {
  const calls = sourceFiles(SRC).flatMap(f => siteCallsOf(parse(f)));

  it('finds the calls at all (positive control)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(INSTANCE_WRITE_SITES.length);
    expect(calls.some(c => c.file === join('tools', 'builtin', 'data-store.ts') && c.site === 'data_store_drop#delete')).toBe(true);
  });

  it('names every site as a string literal in the call', () => {
    expect(calls.filter(c => c.problem !== undefined)).toEqual([]);
  });

  it('has every label as the site of exactly one call, and every call\'s label on the list', () => {
    const count = new Map<string, SiteCall[]>();
    for (const c of calls) if (c.site !== null) count.set(c.site, [...(count.get(c.site) ?? []), c]);
    const twice = [...count].filter(([, cs]) => cs.length > 1).map(([s, cs]) => `${s} at ${cs.map(c => `${c.file}:${String(c.line)}`).join(', ')}`);
    expect(twice, 'a label used by more than one call').toEqual([]);
    const listed = new Set<string>(INSTANCE_WRITE_SITES);
    expect([...count.keys()].filter(s => !listed.has(s)), 'a label not on INSTANCE_WRITE_SITES').toEqual([]);
    expect(INSTANCE_WRITE_SITES.filter(s => !count.has(s)), 'a site without its call').toEqual([]);
    expect(new Set(INSTANCE_WRITE_SITES).size, 'the list names a site twice').toBe(INSTANCE_WRITE_SITES.length);
  });

  it('the scan sees a label written twice (instrument check on a planted source)', () => {
    const planted = ts.createSourceFile(join(SRC, 'planted.ts'), `
      withInstanceWrite(a, { site: 'remember#create', kind: 'create', store: 'knowledge' }, () => 1);
      withInstanceWrite(a, { site: 'remember#create', kind: 'create', store: 'knowledge' }, () => 2);
      const site = 'x'; withInstanceWrite(a, { site, kind: 'create', store: 'knowledge' }, () => 3);
      const f = withInstanceWrite;
      // withInstanceWrite(a, { site: 'memory_store#create' }, () => 4)
    `, ts.ScriptTarget.Latest, true);
    const found = siteCallsOf(planted);
    expect(found.filter(c => c.site === 'remember#create')).toHaveLength(2);
    expect(found.filter(c => c.problem !== undefined).map(c => c.problem)).toEqual(['site is not a string literal', 'referenced other than as a call']);
    const aliased = ts.createSourceFile(join(SRC, 'planted.ts'), `
      import { withInstanceWrite as w } from './instance-trail.js';
      import { withInstanceWrite } from './instance-trail.js';
      export { withInstanceWrite as recorded };
      w(a, { site: 'remember#create', kind: 'create', store: 'knowledge' }, () => 1);
    `, ts.ScriptTarget.Latest, true);
    expect(siteCallsOf(aliased).map(c => c.problem)).toEqual(['imported or exported under another name', 'imported or exported under another name']);
    expect(found.some(c => c.site === 'memory_store#create'), 'a comment is no call').toBe(false);
  });
});

// ── 2 · direct writes in the writing handlers ──────────────────────────────────────────────────

/** The files whose handlers (or the runner a handler calls with its stores) hold write sites. */
const HANDLER_FILES = [
  'tools/builtin/knowledge.ts', 'tools/builtin/memory.ts', 'tools/builtin/subjects-merge.ts', 'core/subject-merge-runner.ts',
  'tools/builtin/data-store.ts', 'tools/builtin/contacts.ts', 'tools/builtin/artifact.ts', 'tools/builtin/media-process.ts',
  'tools/builtin/set-thread-context.ts', 'tools/builtin/task.ts', 'tools/builtin/plan-task.ts', 'tools/builtin/process.ts',
  'tools/builtin/update-workflow.ts', 'tools/builtin/import-workflow.ts', 'tools/builtin/api-setup.ts',
];

const FS_MODULES = new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises']);
const FS_WRITES = new Set([
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'mkdirSync', 'mkdir', 'mkdtempSync', 'mkdtemp', 'rmSync', 'rm',
  'rmdirSync', 'rmdir', 'unlinkSync', 'unlink', 'renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'writeSync',
  'write', 'symlinkSync', 'symlink', 'linkSync', 'link', 'truncateSync', 'truncate', 'ftruncateSync', 'chmodSync', 'chmod',
  'createWriteStream', 'openSync', 'open',
]);
/** An imported function whose name says it changes something. */
const WRITE_NAME = /^(write|append|mkdir|mkdtemp|rm|unlink|rename|copy|insert|upsert|drop|purge|truncate|store|forget|debit|persist|delete|remove|save|prune)/i;
/** Methods that reach a database directly, whoever the receiver is. */
const DB_METHODS = new Set(['prepare', 'exec', 'getDb', 'transaction', 'pragma']);
/** Members of a passed object that write past it (`engine.sweepConnectionErasures` over raw `getDb()`). */
const PAST_PASSED = new Set(['connectionErasureSweep']);

interface DirectWrite { file: string; callee: string; line: number }

const isSqlText = (arg: ts.Expression | undefined): boolean =>
  arg !== undefined && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg));

function directWritesOf(sf: ts.SourceFile): DirectWrite[] {
  const file = relative(SRC, sf.fileName).split('\\').join('/');
  const fsNames = new Set<string>();
  const fsNamespaces = new Set<string>();
  const imported = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.importClause?.isTypeOnly === true) continue;
    const mod = st.moduleSpecifier.text;
    const clause = st.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined && FS_MODULES.has(mod)) fsNamespaces.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb !== undefined && ts.isNamespaceImport(nb) && FS_MODULES.has(mod)) fsNamespaces.add(nb.name.text);
    if (nb !== undefined && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        if (el.isTypeOnly) continue;
        const original = (el.propertyName ?? el.name).text;
        if (FS_MODULES.has(mod)) { if (FS_WRITES.has(original)) fsNames.add(el.name.text); } else imported.add(el.name.text);
      }
    }
  }
  const out: DirectWrite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e)) {
        if (fsNames.has(e.text) || (imported.has(e.text) && WRITE_NAME.test(e.text))) out.push({ file, callee: e.text, line: lineOf(sf, node) });
      } else if (ts.isPropertyAccessExpression(e)) {
        const name = e.name.text;
        const recv = e.expression;
        if (ts.isIdentifier(recv) && fsNamespaces.has(recv.text) && FS_WRITES.has(name)) out.push({ file, callee: `${recv.text}.${name}`, line: lineOf(sf, node) });
        // `exec` is a RegExp's as often as a database's: only a SQL text as its argument counts.
        else if (DB_METHODS.has(name) && (name !== 'exec' || isSqlText(node.arguments[0]))) out.push({ file, callee: `.${name}`, line: lineOf(sf, node) });
        else if (PAST_PASSED.has(name)) out.push({ file, callee: `.${name}`, line: lineOf(sf, node) });
        else if (name === 'publish' && ts.isPropertyAccessExpression(recv) && ts.isIdentifier(recv.expression) && recv.expression.text === 'channels') {
          out.push({ file, callee: `channels.${recv.name.text}.publish`, line: lineOf(sf, node) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The closed list: `<file>|<callee>` → reason. The erasure sweep first: it is the
 * one entry-adjacent write that bypasses the stores it is handed and records as the owner.
 */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  'tools/builtin/api-setup.ts|.connectionErasureSweep': 'advances erasures that only the owner records, over raw getDb(), under the owner; inside api_setup#delete, where a mandate\'s delete records only `closing`',
  'tools/builtin/media-process.ts|writeInPlace': 'the anchored output file, inside media_process#anchored',
  'tools/builtin/media-process.ts|mkdirSync': 'the file area, inside media_process#unanchored',
  'tools/builtin/media-process.ts|copyFileSync': 'into the file area inside media_process#unanchored; the input copy goes to the private tmp dir',
  'tools/builtin/media-process.ts|mkdtempSync': 'the private tmp work dir, removed in finally; not the instance',
  'tools/builtin/media-process.ts|rmSync': 'removes the private tmp work dir',
  'tools/builtin/media-process.ts|writeSync': 'copyFromFd fills the private tmp copy',
  'tools/builtin/media-process.ts|openSync': 'copyFromFd opens the private tmp copy for writing',
  'core/subject-merge-runner.ts|writeFileAtomicSync': 'the merge ledger, inside subjects_merge#change (the wrapper encloses runMerge)',
  'core/subject-merge-runner.ts|unlinkSync': 'pruning expired ledgers, inside subjects_merge#change',
  'tools/builtin/knowledge.ts|appendUntrustedCauseLog': 'telemetry file sink before the wrapper',
  'tools/builtin/memory.ts|appendUntrustedCauseLog': 'telemetry file sink before the wrapper',
  'tools/builtin/knowledge.ts|appendCaptureTelemetry': 'capture telemetry, not an entry',
  'tools/builtin/memory.ts|channels.memoryStore.publish': 'derived graph writes by subscribers holding the engine\'s stores; inside the wrappers',
  'tools/builtin/data-store.ts|channels.dataStoreInsert.publish': 'derived graph writes by subscribers holding the engine\'s stores; inside the wrappers',
  'tools/builtin/plan-task.ts|storePipeline': 'volatile module cache, after the spied insertPlannedPipeline',
  'tools/builtin/process.ts|storePipeline': 'volatile module cache, after the spied insertPlannedPipeline',
  'tools/builtin/import-workflow.ts|storePipeline': 'volatile module cache, after the spied insertPlannedPipeline',
  'tools/builtin/update-workflow.ts|forgetPipeline': 'evicts the volatile module cache',
  'tools/builtin/plan-task.ts|debitInRunHelperCost': 'metering of the planner\'s own helper call, not an entry',
  'tools/builtin/api-setup.ts|debitInRunHelperCost': 'metering of the bootstrap extraction\'s helper call, not an entry',
  'tools/builtin/api-setup.ts|purgeRecordedTokens': 'through the passed apiStore and secretStore: inside api_setup#delete; and after a fetch_token exchange whose profile was deleted meanwhile (fetch_token has its own outward pair, no site)',
};

describe('direct writes in the writing handlers', () => {
  const found = HANDLER_FILES.flatMap(f => directWritesOf(parse(join(SRC, f))));

  it('finds what it looks for (positive control: the file area mkdir and the erasure sweep)', () => {
    expect(found.some(w => w.file === 'tools/builtin/media-process.ts' && w.callee === 'mkdirSync')).toBe(true);
    expect(found.some(w => w.file === 'tools/builtin/api-setup.ts' && w.callee === '.connectionErasureSweep')).toBe(true);
  });

  it('reports no direct write outside the closed list, each listed one with its reason', () => {
    const unlisted = found.filter(w => EXCEPTIONS[`${w.file}|${w.callee}`] === undefined).map(w => `${w.file}:${String(w.line)} ${w.callee}`);
    expect(unlisted, 'a direct write past the passed objects: wrap it and give it a fixture, or list it with a reason').toEqual([]);
  });

  it('lists nothing the source no longer does', () => {
    const seen = new Set(found.map(w => `${w.file}|${w.callee}`));
    expect(Object.keys(EXCEPTIONS).filter(k => !seen.has(k))).toEqual([]);
    expect(Object.keys(EXCEPTIONS)[0]).toBe('tools/builtin/api-setup.ts|.connectionErasureSweep');
  });

  it('the scan sees a direct write by import, namespace and raw db (instrument check on a planted source)', () => {
    const planted = ts.createSourceFile(join(SRC, 'tools/builtin/planted.ts'), `
      import { writeFileSync as w, readFileSync } from 'node:fs';
      import * as fs from 'node:fs';
      import { saveThing, readThing } from './elsewhere.js';
      w('a', 'b'); readFileSync('a'); fs.unlinkSync('a'); fs.statSync('a');
      saveThing(); readThing(); db.prepare('x').run(); agent.toolContext.connectionErasureSweep?.();
      db.exec(\`DELETE FROM t\`); /x/.exec(line);
    `, ts.ScriptTarget.Latest, true);
    expect(directWritesOf(planted).map(w => w.callee)).toEqual(['w', 'fs.unlinkSync', 'saveThing', '.prepare', '.connectionErasureSweep', '.exec']);
  });
});

/**
 * 3. (660a-1b) Inside each block, a step is noted only as `w.run(<literal step>, <call>, <decoder>)`
 *    with a decoder from `instance-trail.ts` by name — no decoder written in place, which could
 *    read `undefined > 0` as a change. And every step a site names as `main` is run in its block:
 *    a main step never run would keep the row from ever saying `wrote=all`.
 */
const DECODERS = new Set(['ifReturned', 'ifTrue', 'ifPositive', 'ifNonNull', 'ifOk', 'ifCounts', 'ifNotDeduped', 'ifCreated', 'ifEmptiedAny']);

interface StepUse { file: string; line: number; site: string | null; step: string | null; decoder: string | null; main: string[]; createdFor?: string | null }

function stepUsesOf(sf: ts.SourceFile): StepUse[] {
  const file = relative(SRC, sf.fileName);
  const out: StepUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'withInstanceWrite') {
      const spec = node.arguments[1];
      const block = node.arguments[2];
      const prop = (name: string) => (spec !== undefined && ts.isObjectLiteralExpression(spec)
        ? spec.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name)
        : undefined);
      const siteProp = prop('site');
      const site = siteProp && ts.isStringLiteral(siteProp.initializer) ? siteProp.initializer.text : null;
      const mainProp = prop('main');
      const main = mainProp && ts.isArrayLiteralExpression(mainProp.initializer)
        ? mainProp.initializer.elements.filter(ts.isStringLiteral).map(e => e.text) : [];
      const param = block !== undefined && (ts.isArrowFunction(block) || ts.isFunctionExpression(block)) ? block.parameters[0] : undefined;
      const w = param !== undefined && ts.isIdentifier(param.name) ? param.name.text : null;
      out.push({ file, line: lineOf(sf, node), site, step: null, decoder: null, main });
      if (w !== null && block !== undefined) {
        const inner = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
            && n.expression.expression.text === w && n.expression.name.text === 'run') {
            const [step, , decoder] = n.arguments;
            out.push({
              file, line: lineOf(sf, n), site,
              step: step !== undefined && ts.isStringLiteral(step) ? step.text : null,
              decoder: decoder !== undefined && ts.isIdentifier(decoder) ? decoder.text : null,
              main,
            });
          }
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)
            && n.expression.expression.text === w && n.expression.name.text === 'created') {
            const [step] = n.arguments;
            out.push({ file, line: lineOf(sf, n), site, step: null, decoder: null, main: [], createdFor: step !== undefined && ts.isStringLiteral(step) ? step.text : null });
          }
          ts.forEachChild(n, inner);
        };
        inner(block);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('the steps of each write site against the source (660a-1b)', () => {
  const isCreated = (u: StepUse): boolean => u.createdFor !== undefined;
  const isBlock = (u: StepUse): boolean => u.step === null && u.decoder === null && !isCreated(u);
  const badSteps = (uses: StepUse[]): string[] => uses.filter(u => !isBlock(u) && !isCreated(u) && (u.step === null || u.decoder === null || !DECODERS.has(u.decoder)))
    .map(u => `${u.file}:${String(u.line)} ${String(u.site)} step=${String(u.step)} decoder=${String(u.decoder)}`);
  const missingMain = (uses: StepUse[]): string[] => {
    const missing: string[] = [];
    for (const b of uses.filter(isBlock)) {
      if (b.main.length === 0) { missing.push(`${String(b.site)} names no main step`); continue; }
      for (const m of b.main) {
        if (!uses.some(r => !isBlock(r) && !isCreated(r) && r.site === b.site && r.step === m)) missing.push(`${String(b.site)} never runs main step ${m}`);
      }
    }
    return missing;
  };
  const uses = sourceFiles(SRC).flatMap(f => stepUsesOf(parse(f)));

  it('finds every block and its steps (positive control)', () => {
    expect(uses.filter(isBlock).map(u => u.site).sort()).toEqual([...INSTANCE_WRITE_SITES].sort());
    expect(uses.filter(u => !isBlock(u)).length).toBeGreaterThanOrEqual(INSTANCE_WRITE_SITES.length);
  });

  it('every step has a literal name and a named decoder from instance-trail', () => {
    expect(badSteps(uses)).toEqual([]);
  });

  it('every site names its main steps, and runs each of them in its block', () => {
    expect(missingMain(uses)).toEqual([]);
  });

  const strayCreated = (uses: StepUse[]): string[] => uses.filter(isCreated)
    .filter(c => c.createdFor === null || !uses.some(r => !isBlock(r) && !isCreated(r) && r.site === c.site && r.step === c.createdFor))
    .map(c => `${String(c.site)} created for ${String(c.createdFor)}`);

  it('every created id names, as a literal, a step its block runs', () => {
    expect(uses.filter(isCreated).length, 'positive control').toBeGreaterThan(0);
    expect(strayCreated(uses)).toEqual([]);
  });

  it('flags a decoder written in place, a computed step name, and a main step never run (planted)', () => {
    const planted = ts.createSourceFile('planted.ts', `
      withInstanceWrite(a, { site: 'x#a', kind: 'create', store: 'tasks', main: ['make'] }, (w) => { w.run('make', () => f(), (v) => v > 0 ? 'changed' : 'unknown'); });
      withInstanceWrite(a, { site: 'x#b', kind: 'create', store: 'tasks', main: ['make'] }, (w) => { w.run(name, () => f(), ifTrue); });
      withInstanceWrite(a, { site: 'x#c', kind: 'create', store: 'tasks', main: ['make', 'other'] }, (w) => { w.run('make', () => f(), ifTrue); });
      withInstanceWrite(a, { site: 'x#d', kind: 'create', store: 'tasks' }, () => f());
      withInstanceWrite(a, { site: 'x#e', kind: 'create', store: 'tasks', main: ['make'] }, (w) => { w.run('make', () => f(), ifTrue); w.created('maek', id); w.created(s, id); });
    `, ts.ScriptTarget.Latest, true);
    const p = stepUsesOf(planted);
    expect(strayCreated(p)).toEqual(['x#e created for maek', 'x#e created for null']);
    expect(badSteps(p).map(s => s.split(' ').slice(1).join(' '))).toEqual(['x#a step=make decoder=null', 'x#b step=null decoder=ifTrue']);
    expect(missingMain(p)).toEqual(['x#b never runs main step make', 'x#c never runs main step other', 'x#d names no main step']);
  });
});
