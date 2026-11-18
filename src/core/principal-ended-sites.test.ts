import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Every call of `principalHasEnded`, and of the functions that only pass its answer on (the GATES
 * below), is named here, and each name carries the tests that show it at work: live → let through,
 * ended → stopped or refused.
 *
 * A call the list does not name fails the first test, and so does a named call that is gone. A
 * new call is added here with its two tests.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE = 'principalHasEnded';

/**
 * The predicate, and each function whose answer is the predicate's answer passed on, by the file
 * that defines it. A caller of one of these asks the same question one step removed, so it is a
 * place of its own.
 */
const GATES: Readonly<Record<string, string>> = {
  [PREDICATE]: 'src/core/request-principal.ts',
  '#planHasEnded': 'src/core/worker-loop.ts',
  '#stopIfStarterEnded': 'src/core/worker-loop.ts',
  sourceRefusal: 'src/orchestrator/run-source.ts',
  stopForEndedAuthor: 'src/orchestrator/runner.ts',
};

/**
 * A test, by file and by (part of) its title. `ended` fails when the call answers "not ended" for
 * an ended access; `live` fails when it answers "ended" for a live one. Each pair was found that way:
 * the call replaced by `false`, then by `true`, and these tests among the ones that failed.
 */
type Witness = readonly [file: string, title: string];

/**
 * Key: `<file> · <where> · <callee> · <first argument>`. `<where>` is the nearest named function or method;
 * inside an HTTP route it is the route's method and path, because one method registers them all.
 */
const SITES: Readonly<Record<string, { ended: Witness; live: Witness }>> = {
  'src/core/approval-executor.ts · execute · principalHasEnded · principal': {
    ended: ['src/core/approval-executor.test.ts', 'a mail a mandate filed is not sent once that mandate has ended'],
    live: ['src/core/approval-executor.test.ts', 'control: the same mail of a live mandate is sent'],
  },
  'src/core/plan-takeover.ts · holds · principalHasEnded · member': {
    ended: ['src/core/plan-takeover.test.ts', 'a member whose end is proven is covered whatever its mark’s age'],
    live: ['src/core/plan-takeover.test.ts', 'a live member that changed the workflow after the pause stays, and the plan runs as that member'],
  },
  'src/core/plan-takeover.ts · planOf · principalHasEnded · principal': {
    ended: ['src/core/plan-takeover.test.ts', 'one person under two grants is two members, each with its own roles: the ended one and the live one that stays'],
    live: ['src/core/plan-takeover.test.ts', 'a renewed member that changed the workflow after the pause is not covered: the plan runs as that member'],
  },
  'src/core/plan-takeover.ts · named · principalHasEnded · p': {
    ended: ['src/core/plan-takeover.test.ts', 'every mandate whose mark it covers is named, also one that cannot be told live'],
    live: ['src/core/plan-takeover.test.ts', 'the member that stays is named, as live'],
  },
  'src/core/run-buffer.ts · closeEndedTails · principalHasEnded · holder.principal': {
    ended: ['src/core/run-buffer.test.ts', 'closes the tail of an ended grant, and leaves the run, the owner\'s tail and a tail with no holder'],
    live: ['src/core/run-buffer.test.ts', 'closes the tail of an ended grant, and leaves the run, the owner\'s tail and a tail with no holder'],
  },
  'src/core/run-executor.ts · abortEnded · principalHasEnded · run.starter': {
    ended: ['src/core/run-executor.test.ts', 'aborts a run whose starter\'s grant has ended, and only that'],
    live: ['src/core/run-executor.test.ts', 'aborts a run whose starter\'s grant has ended, and only that'],
  },
  'src/core/worker-loop.ts · #planHasEnded · principalHasEnded · m': {
    ended: ['src/core/worker-loop.test.ts', 'a stamped schedule the mandate set up, fired by the schedule after the grant ended, does not run'],
    live: ['src/core/plan-pause-worker.test.ts', 'a live plan still runs'],
  },
  'src/core/worker-loop.ts · #stopIfStarterEnded · principalHasEnded · starter': {
    ended: ['src/core/worker-loop.test.ts', 'a run whose starter\'s grant is ended by the time its turn starts, is stopped before the provider (§3.13 B8)'],
    live: ['src/core/worker-loop.test.ts', 'a run whose starter\'s grant is still live, runs (§3.13 B8)'],
  },
  'src/core/worker-loop.ts · stopEndedStarters · principalHasEnded · active.starter': {
    ended: ['src/core/worker-loop-stop.test.ts', 'is stopped once the grant has ended, and recorded as stopped'],
    live: ['src/core/worker-loop-stop.test.ts', 'leaves a run the schedule fired, which is the owner\'s'],
  },
  'src/orchestrator/run-source.ts · sourceRefusal · principalHasEnded · p': {
    ended: ['src/orchestrator/workflow-author-liveness.test.ts', 'does not run a mandate\'s workflow once its grant ended'],
    live: ['src/orchestrator/workflow-author-liveness.test.ts', 'runs it while the grant lives'],
  },
  'src/server/http-api.ts · #stampListShown · principalHasEnded · m': {
    ended: ['src/server/http-api.test.ts', 'GET /api/triggers says on which side a member whose access ended sits'],
    live: ['src/server/http-api.test.ts', 'GET /api/triggers tells the owner what the stamp of a confirmed plan lists, and a helper nothing'],
  },
  'src/server/http-api.ts · #stampListShown · principalHasEnded · wf': {
    ended: ['src/server/http-api.test.ts', 'GET /api/triggers says on which side a member whose access ended sits'],
    live: ['src/server/http-api.test.ts', 'GET /api/triggers says on which side a member whose access ended sits'],
  },
  'src/server/http-api.ts · POST /api/sessions/:id/run · principalHasEnded · askStamp.principal': {
    ended: ['src/server/http-api.test.ts', 'does not start a mandate\'s chat run whose grant ended while the request was on its way'],
    live: ['src/server/http-api.test.ts', 'does not start a mandate\'s chat run whose grant ended while the request was on its way'],
  },
  'src/server/http-api.ts · GET /api/workflows/library · principalHasEnded · runAs': {
    ended: ['src/server/http-api.test.ts', 'lists whom each workflow runs as for the owner, and whether that person\'s access ended'],
    live: ['src/server/http-api.test.ts', 'reads the paused plans once per list and only when a listed workflow has ended, and a failed read counts none instead of failing the list'],
  },
  'src/server/http-api.ts · POST /api/workflows/:id/run · principalHasEnded · runAs': {
    ended: ['src/server/http-api.test.ts', 'refuses once that mandate\'s access ended, naming the person, and starts nothing'],
    live: ['src/server/http-api.test.ts', 'runs a live mandate\'s workflow as that mandate when the owner presses Run'],
  },
  'src/server/http-api.ts · POST /api/approvals/:id/decide · principalHasEnded · principalOfPrompt({ created_by: entry.createdBy, mandate_id: entry.mandateId })': {
    ended: ['src/server/http-api.test.ts', 'discards instead of approving a mail whose mandate has ended'],
    live: ['src/server/http-api.test.ts', 'control: approves a mail of a live mandate'],
  },
  'src/core/worker-loop.ts · #stopIfStarterEnded · #planHasEnded · entry': {
    ended: ['src/core/worker-loop.test.ts', 'access that ends between the dispatch and the turn stops the run before the provider'],
    live: ['src/core/worker-loop.test.ts', 'runs a mandate-changed agent trigger once the owner has stamped it again'],
  },
  'src/core/worker-loop.ts · stopEndedStarters · #planHasEnded · active': {
    ended: ['src/core/worker-loop.test.ts', 'the sweep stops a scheduled run of the plan when the access ends; who may stop it stays the starter'],
    live: ['src/core/worker-loop.test.ts', 'control: the sweep leaves a scheduled run of the owner\'s plan alone, and it is the owner\'s'],
  },
  'src/core/worker-loop.ts · #runFramed · #planHasEnded · entry': {
    ended: ['src/core/worker-loop.test.ts', '255-e: after the grant the plan was set up under ended, the pickup of its answer makes no run and no retry'],
    live: ['src/core/worker-loop.test.ts', 'runs a mandate-changed agent trigger once the owner has stamped it again'],
  },
  'src/core/worker-loop.ts · dispatch · #stopIfStarterEnded · entry': {
    ended: ['src/core/worker-loop.test.ts', 'a mandate\'s test run of a run_workflow proposal whose grant ended before it started runs no step (§3.13 B8)'],
    live: ['src/core/worker-loop.test.ts', 'the same plan, stamped by the owner and fired by the schedule, runs its steps for the mandate with the lock\'s tools'],
  },
  'src/core/worker-loop.ts · executeStandard · #stopIfStarterEnded · active': {
    ended: ['src/core/worker-loop.test.ts', 'a run whose starter\'s grant is ended by the time its turn starts, is stopped before the provider (§3.13 B8)'],
    live: ['src/core/worker-loop.test.ts', 'a run whose starter\'s grant is still live, runs (§3.13 B8)'],
  },
  'src/core/worker-loop.ts · planEnded · #planHasEnded · entry': {
    ended: ['src/core/workflow-ended-mid-run-worker.test.ts', 'is recorded as the stop for that end: the plan pauses and keeps its schedule'],
    live: ['src/core/workflow-ended-mid-run-worker.test.ts', 'control: the same error while every member is live is a failure, not that stop'],
  },
  'src/core/worker-loop.ts · executeWatch · #stopIfStarterEnded · stopEntry': {
    ended: ['src/core/worker-loop.test.ts', 'a watch whose starter\'s grant ended before its analysis is stopped before the provider (§3.13 B8)'],
    live: ['src/core/worker-loop.test.ts', 'SECURITY: the watch analysis run suppresses ALL tools (untrusted page content cannot reach a tool)'],
  },
  'src/orchestrator/runner.ts · runManifest · sourceRefusal · options.source': {
    ended: ['src/orchestrator/workflow-author-liveness.test.ts', 'the owner\'s chat does not run it once that mandate\'s grant ended, and no step reaches the provider'],
    live: ['src/orchestrator/workflow-author-liveness.test.ts', 'the owner\'s chat runs a workflow a live mandate made'],
  },
  'src/orchestrator/runner.ts · stopForEndedAuthor · sourceRefusal · saved': {
    ended: ['src/orchestrator/workflow-author-liveness.test.ts', 'the owner\'s chat: B\'s grant ends during step one, step two never reaches the provider'],
    live: ['src/orchestrator/workflow-author-liveness.test.ts', 'a live author\'s run goes ahead (control)'],
  },
  'src/orchestrator/runner.ts · executeStep · stopForEndedAuthor · options': {
    ended: ['src/orchestrator/workflow-author-liveness.test.ts', 'the library\'s run (runSavedWorkflow): the same end'],
    live: ['src/orchestrator/workflow-author-liveness.test.ts', 'runs it while the grant lives'],
  },
};

interface Site { key: string; line: number }

/**
 * The route a handler belongs to: the handler is an argument of a registration call whose string
 * arguments name the method and the path (`parseDynamicRoute('user', 'POST', '/api/x', handler)`,
 * `addStatic('user', 'GET /api/x', handler)`).
 */
function routeOf(node: ts.Node): string | undefined {
  const call = node.parent;
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || !call || !ts.isCallExpression(call) || !call.arguments.includes(node as ts.Expression)) return undefined;
  const parts = call.arguments.filter(ts.isStringLiteral).map((a) => a.text).filter((t) => /^(GET|POST|PUT|PATCH|DELETE|HEAD)\b|^\//.test(t));
  return parts.some((t) => t.includes('/')) ? parts.join(' ') : undefined;
}

/**
 * The calls of the gates in one source text, and every other use of their names. Another use (an
 * alias, the function handed on as a value, a call through a literal name like `x['name']`) would ask without a call
 * this scan can name, so it is reported, not skipped.
 */
function scan(file: string, text: string): { sites: Site[]; otherUses: string[] } {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: Site[] = [];
  const otherUses: string[] = [];
  const visit = (node: ts.Node, where: string | undefined): void => {
    let here = where;
    const route = routeOf(node);
    if (route !== undefined) here = route;
    else if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node)) && node.name) here = node.name.getText(sf);
    else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) here = node.name.getText(sf);
    const line = (): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const site = (name: string, call: ts.CallExpression): void => {
      const first = call.arguments[0]?.getText(sf).replace(/\s+/g, ' ') ?? '';
      sites.push({ key: `${file} · ${here ?? '(top level)'} · ${name} · ${first}`, line: line() });
    };
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && Object.hasOwn(GATES, node.text)) {
      const name = node.text;
      const parent = node.parent;
      const declared = (ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name === node && file === GATES[name];
      if (declared) {
        // The definition.
      } else if (ts.isIdentifier(node) && ts.isCallExpression(parent) && parent.expression === node) {
        site(name, parent);
      } else if (ts.isPrivateIdentifier(node) && ts.isPropertyAccessExpression(parent) && parent.name === node
        && parent.expression.kind === ts.SyntaxKind.ThisKeyword && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        site(name, parent.parent);
      } else if (ts.isImportSpecifier(parent) && parent.propertyName === undefined) {
        // `import { principalHasEnded }`: the name itself, used below as calls.
      } else {
        otherUses.push(`${file}:${line()}`);
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && Object.hasOwn(GATES, node.text) && ts.isElementAccessExpression(node.parent)) {
      otherUses.push(`${file}:${line()}`);
    }
    ts.forEachChild(node, (child) => visit(child, here));
  };
  visit(sf, undefined);
  return { sites, otherUses };
}

const isTest = (e: ts.Expression): boolean => ts.isIdentifier(e) && (e.text === 'it' || e.text === 'test');
const isBlock = (e: ts.Expression): boolean => ts.isIdentifier(e) && (e.text === 'it' || e.text === 'test' || e.text === 'describe');

/** `describe.skip(…)`, `it.todo(…)`, `describe.skipIf(c)(…)`, `describe.runIf(c)(…)`: what is inside may not run. */
function mayNotRun(call: ts.CallExpression): boolean {
  // The modifiers between `describe`/`it`/`test` and the call, also through `.each(…)` and `.skipIf(c)`.
  let e: ts.Expression = call.expression;
  const modifiers: string[] = [];
  for (;;) {
    if (ts.isCallExpression(e)) e = e.expression;
    else if (ts.isPropertyAccessExpression(e)) { modifiers.push(e.name.text); e = e.expression; } else break;
  }
  if (!isBlock(e)) return false;
  if (modifiers.some((m) => ['skip', 'todo', 'skipIf', 'runIf'].includes(m))) return true;
  // `it('t', { skip: true }, fn)`: the options form.
  const options = call.arguments[1];
  return options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some((p) =>
    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ['skip', 'todo'].includes(p.name.text) && p.initializer.kind !== ts.SyntaxKind.FalseKeyword);
}
const literal = (e: ts.Expression | undefined): string | undefined =>
  e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

/**
 * The titles of the tests in a test file, as the strings they are: the first argument of each
 * `it(…)` / `test(…)`, and for `it.each([[…], …])(title, …)` the title with each row's first cell in
 * place of its `%s`. Nothing under a skip, a todo or a run condition counts.
 */
function testTitles(file: string): string[] {
  return titlesOf(readFileSync(join(ROOT, file), 'utf8'));
}

function titlesOf(text: string): string[] {
  const sf = ts.createSourceFile('titles.test.ts', text, ts.ScriptTarget.Latest, true);
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && mayNotRun(node)) return;
    if (ts.isCallExpression(node)) {
      const title = literal(node.arguments[0]);
      if (title !== undefined && isTest(node.expression)) titles.push(title);
      const each = node.expression;
      if (title !== undefined && ts.isCallExpression(each) && ts.isPropertyAccessExpression(each.expression)
        && isTest(each.expression.expression) && each.expression.name.text === 'each') {
        let table = each.arguments[0];
        while (table && (ts.isAsExpression(table) || ts.isParenthesizedExpression(table))) table = table.expression;
        if (table && ts.isArrayLiteralExpression(table)) {
          for (const row of table.elements) {
            const cell = ts.isArrayLiteralExpression(row) ? literal(row.elements[0]) : literal(row);
            if (cell !== undefined) titles.push(title.replace('%s', cell));
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return titles;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|cts|tsx)$/.test(path) && !/\.test\.\w+$/.test(path) && !/\.d\.\w+$/.test(path) ? [path] : [];
  });
}

function scanTree(): { sites: Site[]; otherUses: string[]; files: number } {
  const sites: Site[] = [];
  const otherUses: string[] = [];
  let files = 0;
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(path, 'utf8');
    files++;
    if (!Object.keys(GATES).some((name) => text.includes(name))) continue;
    const found = scan(relative(ROOT, path), text);
    sites.push(...found.sites);
    otherUses.push(...found.otherUses);
  }
  return { sites, otherUses, files };
}

describe('every call that asks whether an access has ended', () => {
  it('is named in the list, and every name in the list is still a place', () => {
    const { sites, otherUses } = scanTree();
    const keys = sites.map((s) => s.key);
    const unnamed = sites.filter((s) => !Object.hasOwn(SITES, s.key)).map((s) => `${s.key} (line ${s.line})`);
    const gone = Object.keys(SITES).filter((k) => !keys.includes(k));
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect({ unnamed, gone, twice, otherUses }).toEqual({ unnamed: [], gone: [], twice: [], otherUses: [] });
  });

  it.each(Object.entries(SITES))('%s names a test for an ended access and one for a live access, and both exist', (_key, { ended, live }) => {
    for (const [file, title] of [ended, live]) {
      expect(testTitles(file).some((t) => t.includes(title)), `${file} has no test titled "${title}"`).toBe(true);
    }
  });
});

describe('the scan the list is held against', () => {
  it('reads the source tree, and finds each gate where it is defined', () => {
    const { files } = scanTree();
    expect(files).toBeGreaterThan(100);
    for (const [name, file] of Object.entries(GATES)) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, `${file} defines no ${name}`).toMatch(name.startsWith('#') ? `  ${name}(` : `export function ${name}(`);
    }
  });

  it('names a call by its function, by its route inside a route handler, by its gate and by its first argument', () => {
    const text = [
      `import { ${PREDICATE} } from './request-principal.js';`,
      `function gate(p) { return ${PREDICATE}(p, live); }`,
      'class Api {',
      '  register() {',
      `    this.routes.push(parseDynamicRoute('user', 'POST', '/api/x/:id/run', async (req) => { if (${PREDICATE}(req.who, live)) return; }));`,
      `    this.addStatic('user', 'GET /api/y', async (req) => ${PREDICATE}(req.viewer, live));`,
      `    const inner = () => ${PREDICATE}(\n      other,\n      live);`,
      '    this.#planHasEnded(entry);',
      '    return sourceRefusal(source, 0);',
      '  }',
      '}',
      `${PREDICATE}(top, live);`,
    ].join('\n');
    expect(scan('src/x.ts', text)).toEqual({
      sites: [
        { key: `src/x.ts · gate · ${PREDICATE} · p`, line: 2 },
        { key: `src/x.ts · POST /api/x/:id/run · ${PREDICATE} · req.who`, line: 5 },
        { key: `src/x.ts · GET /api/y · ${PREDICATE} · req.viewer`, line: 6 },
        { key: `src/x.ts · inner · ${PREDICATE} · other`, line: 7 },
        { key: 'src/x.ts · register · #planHasEnded · entry', line: 10 },
        { key: 'src/x.ts · register · sourceRefusal · source', line: 11 },
        { key: `src/x.ts · (top level) · ${PREDICATE} · top`, line: 14 },
      ],
      otherUses: [],
    });
  });

  it('reads a test title as the string it is, also from an it.each table, and not under a skip', () => {
    expect(testTitles('src/core/principal-ended-sites.test.ts')).toContain('reads a test title as the string it is, also from an it.each table, and not under a skip');
    expect(testTitles('src/core/worker-loop.test.ts')).toEqual(expect.arrayContaining([
      'a run whose starter\'s grant is ended by the time its turn starts, is stopped before the provider (§3.13 B8)',
      'a run whose starter\'s grant is still live, runs (§3.13 B8)',
    ]));
    expect(testTitles('src/core/worker-loop.test.ts')).not.toContain('a run whose starter\'s grant is %s (§3.13 B8)');
    expect(titlesOf([
      "it('runs', () => {});",
      "describe.skip('off', () => { it('skipped in a block', () => {}); });",
      "describe.skipIf(ci)('maybe', () => { it('skipped by a condition', () => {}); });",
      "it.skip('skipped itself', () => {});",
      "it.todo('not written');",
      "describe.skip.each([['a']])('row %s', () => { it('skipped in a table block', () => {}); });",
      "it('skipped by its options', { skip: true }, () => {});",
      "it('runs with options', { timeout: 5 }, () => {});",
    ].join('\n'))).toEqual(['runs', 'runs with options']);
  });

  it('reports a gate used other than by a call: an alias, a value handed on, a computed name, a call not on this', () => {
    const text = [
      `import { ${PREDICATE} as ended } from './request-principal.js';`,
      `const f = ${PREDICATE};`,
      `members.some(${PREDICATE});`,
      `rp['${PREDICATE}'](p, live);`,
      'other.#planHasEnded(entry);',
      'const g = this.#stopIfStarterEnded;',
    ].join('\n');
    expect(scan('src/y.ts', text).otherUses).toEqual(['src/y.ts:1', 'src/y.ts:2', 'src/y.ts:3', 'src/y.ts:4', 'src/y.ts:5', 'src/y.ts:6']);
  });
});
