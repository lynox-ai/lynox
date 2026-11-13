import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Every place that asks whether an access has ended (`principalHasEnded`) is named here, and each
 * name carries the tests that show it at work: live → let through, ended → stopped or refused.
 *
 * Why a list: each place is tested on its own, but nothing counted them. A new place that asks
 * without a test, or a place whose question is dropped in a refactor, failed nothing. The list
 * turns both into a failure: a call the list does not name fails the first test, and a named call
 * that is gone fails it too.
 *
 * What it does not see: a place that decides on an access without this predicate (for example by
 * asking the mandate store directly). It counts the predicate's callers, not every liveness check.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREDICATE = 'principalHasEnded';
const DEFINED_IN = 'src/core/request-principal.ts';

/**
 * A test, by file and by (part of) its title. `ended` fails when the call answers "not ended" for
 * an ended access; `live` fails when it answers "ended" for a live one. Each pair was found that way:
 * the call replaced by `false`, then by `true`, and these tests among the ones that failed.
 */
type Witness = readonly [file: string, title: string];

/**
 * Key: `<file> · <where> · <first argument>`. `<where>` is the nearest named function or method;
 * inside an HTTP route it is the route's method and path, because one method registers them all.
 */
const SITES: Readonly<Record<string, { ended: Witness; live: Witness }>> = {
  'src/core/approval-executor.ts · execute · principal': {
    ended: ['src/core/approval-executor.test.ts', 'a mail a mandate filed is not sent once that mandate has ended'],
    live: ['src/core/approval-executor.test.ts', 'control: the same mail of a live mandate is sent'],
  },
  'src/core/plan-takeover.ts · holds · member': {
    ended: ['src/core/plan-takeover.test.ts', 'a member whose end is proven is covered whatever its mark’s age'],
    live: ['src/core/plan-takeover.test.ts', 'a live member that changed the workflow after the pause stays, and the plan runs as that member'],
  },
  'src/core/plan-takeover.ts · planOf · principal': {
    ended: ['src/core/plan-takeover.test.ts', 'one person under two grants is two members, each with its own roles: the ended one and the live one that stays'],
    live: ['src/core/plan-takeover.test.ts', 'a renewed member that changed the workflow after the pause is not covered: the plan runs as that member'],
  },
  'src/core/plan-takeover.ts · named · p': {
    ended: ['src/core/plan-takeover.test.ts', 'every mandate whose mark it covers is named, also one that cannot be told live'],
    live: ['src/core/plan-takeover.test.ts', 'the member that stays is named, as live'],
  },
  'src/core/run-buffer.ts · closeEndedTails · holder.principal': {
    ended: ['src/core/run-buffer.test.ts', 'closes the tail of an ended grant, and leaves the run, the owner\'s tail and a tail with no holder'],
    live: ['src/core/run-buffer.test.ts', 'closes the tail of an ended grant, and leaves the run, the owner\'s tail and a tail with no holder'],
  },
  'src/core/run-executor.ts · abortEnded · run.starter': {
    ended: ['src/core/run-executor.test.ts', 'aborts a run whose starter\'s grant has ended, and only that'],
    live: ['src/core/run-executor.test.ts', 'aborts a run whose starter\'s grant has ended, and only that'],
  },
  'src/core/worker-loop.ts · #planHasEnded · m': {
    ended: ['src/core/worker-loop.test.ts', 'a stamped schedule the mandate set up, fired by the schedule after the grant ended, does not run'],
    live: ['src/core/plan-pause-worker.test.ts', 'a live plan still runs'],
  },
  'src/core/worker-loop.ts · #stopIfStarterEnded · starter': {
    ended: ['src/core/worker-loop.test.ts', 'a run whose starter\'s grant is ended by the time its turn starts, is stopped before the provider (§3.13 B8)'],
    live: ['src/core/worker-loop.test.ts', 'a run whose starter\'s grant is still live, runs (§3.13 B8)'],
  },
  'src/core/worker-loop.ts · stopEndedStarters · active.starter': {
    ended: ['src/core/worker-loop-stop.test.ts', 'is stopped once the grant has ended, and recorded as stopped'],
    live: ['src/core/worker-loop-stop.test.ts', 'leaves a run the schedule fired, which is the owner\'s'],
  },
  'src/orchestrator/run-source.ts · sourceRefusal · p': {
    ended: ['src/orchestrator/workflow-author-liveness.test.ts', 'does not run a mandate\'s workflow once its grant ended'],
    live: ['src/orchestrator/workflow-author-liveness.test.ts', 'runs it while the grant lives'],
  },
  'src/server/http-api.ts · #stampListShown · m': {
    ended: ['src/server/http-api.test.ts', 'GET /api/triggers says on which side a member whose access ended sits'],
    live: ['src/server/http-api.test.ts', 'GET /api/triggers tells the owner what the stamp of a confirmed plan lists, and a helper nothing'],
  },
  'src/server/http-api.ts · #stampListShown · wf': {
    ended: ['src/server/http-api.test.ts', 'GET /api/triggers says on which side a member whose access ended sits'],
    live: ['src/server/http-api.test.ts', 'GET /api/triggers says on which side a member whose access ended sits'],
  },
  'src/server/http-api.ts · POST /api/sessions/:id/run · askStamp.principal': {
    ended: ['src/server/http-api.test.ts', 'does not start a mandate\'s chat run whose grant ended while the request was on its way'],
    live: ['src/server/http-api.test.ts', 'starts no run for a mandate session, and the owner\'s run under the owner (§3.13 E1)'],
  },
  'src/server/http-api.ts · GET /api/workflows/library · runAs': {
    ended: ['src/server/http-api.test.ts', 'lists whom each workflow runs as for the owner, and whether that person\'s access ended'],
    live: ['src/server/http-api.test.ts', 'reads the paused plans once per list and only when a listed workflow has ended, and a failed read counts none instead of failing the list'],
  },
  'src/server/http-api.ts · POST /api/workflows/:id/run · runAs': {
    ended: ['src/server/http-api.test.ts', 'refuses once that mandate\'s access ended, naming the person, and starts nothing'],
    live: ['src/server/http-api.test.ts', 'runs a live mandate\'s workflow as that mandate when the owner presses Run'],
  },
  'src/server/http-api.ts · POST /api/approvals/:id/decide · principalOfPrompt({ created_by: entry.createdBy, mandate_id: entry.mandateId })': {
    ended: ['src/server/http-api.test.ts', 'discards instead of approving a mail whose mandate has ended'],
    live: ['src/server/http-api.test.ts', 'control: approves a mail of a live mandate'],
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
 * The calls of the predicate in one source text, and every other use of its name. Another use (an
 * alias, the function handed on as a value) would ask without a call this scan can name, so it is
 * reported, not skipped.
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
    if (ts.isIdentifier(node) && node.text === PREDICATE) {
      const parent = node.parent;
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (ts.isCallExpression(parent) && parent.expression === node) {
        const first = parent.arguments[0]?.getText(sf).replace(/\s+/g, ' ') ?? '';
        sites.push({ key: `${file} · ${here ?? '(top level)'} · ${first}`, line });
      } else if (ts.isImportSpecifier(parent) && parent.propertyName === undefined) {
        // `import { principalHasEnded }`: the name itself, used below as calls.
      } else if (ts.isFunctionDeclaration(parent) && parent.name === node && file === DEFINED_IN) {
        // The definition.
      } else {
        otherUses.push(`${file}:${line}`);
      }
    }
    ts.forEachChild(node, (child) => visit(child, here));
  };
  visit(sf, undefined);
  return { sites, otherUses };
}

const isTest = (e: ts.Expression): boolean => ts.isIdentifier(e) && (e.text === 'it' || e.text === 'test');
const literal = (e: ts.Expression | undefined): string | undefined =>
  e && (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) ? e.text : undefined;

/**
 * The titles of the tests in a test file, as the strings they are: the first argument of each
 * `it(…)` / `test(…)`, and for `it.each([[…], …])(title, …)` the title with each row's first cell in
 * place of its `%s`.
 */
function testTitles(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const titles: string[] = [];
  const visit = (node: ts.Node): void => {
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
    return path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

function scanTree(): { sites: Site[]; otherUses: string[]; files: number } {
  const sites: Site[] = [];
  const otherUses: string[] = [];
  let files = 0;
  for (const path of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(path, 'utf8');
    files++;
    if (!text.includes(PREDICATE)) continue;
    const found = scan(relative(ROOT, path), text);
    sites.push(...found.sites);
    otherUses.push(...found.otherUses);
  }
  return { sites, otherUses, files };
}

describe('every place that asks whether an access has ended', () => {
  it('is named in the list, and every name in the list is still a place', () => {
    const { sites, otherUses } = scanTree();
    const keys = sites.map((s) => s.key);
    const unnamed = sites.filter((s) => !(s.key in SITES)).map((s) => `${s.key} (line ${s.line})`);
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
  it('reads the source tree, and finds the predicate where it is defined', () => {
    const { files } = scanTree();
    const definition = readFileSync(join(ROOT, DEFINED_IN), 'utf8');
    expect(files).toBeGreaterThan(100);
    expect(definition).toContain(`export function ${PREDICATE}(`);
  });

  it('names a call by its function, by its route inside a route handler, and by its first argument', () => {
    const text = [
      `import { ${PREDICATE} } from './request-principal.js';`,
      `function gate(p) { return ${PREDICATE}(p, live); }`,
      'class Api {',
      '  register() {',
      `    this.routes.push(parseDynamicRoute('user', 'POST', '/api/x/:id/run', async (req) => { if (${PREDICATE}(req.who, live)) return; }));`,
      `    this.addStatic('user', 'GET /api/y', async (req) => ${PREDICATE}(req.viewer, live));`,
      `    const inner = () => ${PREDICATE}(\n      other,\n      live);`,
      '  }',
      '}',
      `${PREDICATE}(top, live);`,
    ].join('\n');
    expect(scan('src/x.ts', text)).toEqual({
      sites: [
        { key: 'src/x.ts · gate · p', line: 2 },
        { key: 'src/x.ts · POST /api/x/:id/run · req.who', line: 5 },
        { key: 'src/x.ts · GET /api/y · req.viewer', line: 6 },
        { key: 'src/x.ts · inner · other', line: 7 },
        { key: 'src/x.ts · (top level) · top', line: 12 },
      ],
      otherUses: [],
    });
  });

  it('reads a test title as the string it is, also from an it.each table', () => {
    expect(testTitles('src/core/principal-ended-sites.test.ts')).toContain('reads a test title as the string it is, also from an it.each table');
    expect(testTitles('src/core/worker-loop.test.ts')).toEqual(expect.arrayContaining([
      'a run whose starter\'s grant is ended by the time its turn starts, is stopped before the provider (§3.13 B8)',
      'a run whose starter\'s grant is still live, runs (§3.13 B8)',
    ]));
    expect(testTitles('src/core/worker-loop.test.ts')).not.toContain('a run whose starter\'s grant is %s (§3.13 B8)');
  });

  it('reports the predicate used other than by a call: an alias, a value handed on', () => {
    const text = [
      `import { ${PREDICATE} as ended } from './request-principal.js';`,
      `const f = ${PREDICATE};`,
      `members.some(${PREDICATE});`,
    ].join('\n');
    expect(scan('src/y.ts', text).otherUses).toEqual(['src/y.ts:1', 'src/y.ts:2', 'src/y.ts:3']);
  });
});
