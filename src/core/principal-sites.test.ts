/**
 * Census of the places in `src/` that build an agent or a session, or start a session's run
 * (register 735), and the places that start a workflow run, whose principal its step agents
 * are built for. The public `Agent`, `Session` and `SessionStore` still read a missing principal
 * as the owner: whoever calls the library directly is the owner, the line `runManifest` keeps.
 * Inside the engine nothing may lean on that default. Every place names whom it runs for,
 * the owner included, so a new entrypoint that forgets it fails here instead of running a
 * mandate's work as the owner.
 *
 * Each place is listed below with the function it sits in. The census fails both ways: a place
 * not in the list, a listed place that is gone, and a listed place that no longer names its
 * principal. A place "names" it when its options are an object literal with a `principal`
 * property that no later spread can overwrite, or an identifier declared earlier in the same
 * function with such a literal; a step spawner names it when one of its arguments is
 * `principal` or `….principal`.
 *
 * It is a net, not a fence, and it sees forms only. Unseen: an agent or session built under an
 * imported alias or through a reference to the method, a session's run on a receiver whose name
 * does not end in "session" (or `this.run` in `session.ts`), a principal whose VALUE is undefined
 * at run time (the public API's optional one, handed on), a step spawner's principal handed in
 * at the wrong position, and a literal declared in one block for an identifier shadowed in another.
 */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..');

type Kind = 'new Agent' | 'new Session' | 'createSession' | 'getOrCreate' | 'run' | 'runManifest' | 'retryManifest' | 'spawnPipeline' | 'spawnInline' | 'spawnViaAgent';
const BY_NAME = /^(runManifest|retryManifest|spawnPipeline|spawnInline|spawnViaAgent)$/;
/** How a place states whom it runs for. */
type Names =
  | 'principal'
  /** A run of the session's own housekeeping, without tools, under the session's principal. */
  | 'internal'
  /** Hands on the options its own caller gave; that caller is the public API. */
  | 'passes through';

interface Site { file: string; kind: Kind; fn: string; names: Names | 'nothing' }

/** Every place this engine builds an agent or a session or starts a run, and how it names its principal. */
const SITES: readonly Site[] = [
  { file: 'core/engine.ts', kind: 'new Session', fn: 'createSession', names: 'passes through' },
  { file: 'core/session.ts', kind: 'new Agent', fn: '_createAgent', names: 'principal' },
  { file: 'core/session.ts', kind: 'run', fn: 'compact', names: 'internal' },
  { file: 'core/session-store.ts', kind: 'createSession', fn: 'generateThreadSummary', names: 'principal' },
  { file: 'core/session-store.ts', kind: 'run', fn: 'generateThreadSummary', names: 'internal' },
  { file: 'core/session-store.ts', kind: 'createSession', fn: 'getOrCreate', names: 'passes through' },
  { file: 'core/session-store.ts', kind: 'createSession', fn: 'getOrCreate', names: 'passes through' },
  { file: 'core/worker-loop.ts', kind: 'createSession', fn: 'executeStandard', names: 'principal' },
  { file: 'core/worker-loop.ts', kind: 'run', fn: 'executeStandard', names: 'principal' },
  { file: 'core/worker-loop.ts', kind: 'createSession', fn: 'executeWatch', names: 'principal' },
  { file: 'core/worker-loop.ts', kind: 'run', fn: 'executeWatch', names: 'principal' },
  { file: 'orchestrator/runtime-adapter.ts', kind: 'new Agent', fn: 'spawnViaAgent', names: 'principal' },
  { file: 'orchestrator/runtime-adapter.ts', kind: 'new Agent', fn: 'spawnInline', names: 'principal' },
  { file: 'orchestrator/runner.ts', kind: 'runManifest', fn: 'retryManifest', names: 'passes through' },
  { file: 'orchestrator/runner.ts', kind: 'spawnPipeline', fn: 'executeStep', names: 'principal' },
  { file: 'orchestrator/runner.ts', kind: 'spawnInline', fn: 'executeStep', names: 'principal' },
  { file: 'orchestrator/runner.ts', kind: 'spawnViaAgent', fn: 'executeStep', names: 'principal' },
  { file: 'orchestrator/runtime-adapter.ts', kind: 'runManifest', fn: 'spawnPipeline', names: 'principal' },
  { file: 'tools/builtin/pipeline.ts', kind: 'runManifest', fn: 'executeInlineSteps', names: 'principal' },
  { file: 'tools/builtin/pipeline.ts', kind: 'runManifest', fn: 'executePipelineById', names: 'principal' },
  { file: 'tools/builtin/pipeline.ts', kind: 'retryManifest', fn: 'executePipelineById', names: 'principal' },
  { file: 'tools/builtin/pipeline.ts', kind: 'runManifest', fn: 'runSavedWorkflow', names: 'principal' },
  { file: 'server/http-api.ts', kind: 'getOrCreate', fn: 'POST /api/sessions', names: 'principal' },
  { file: 'server/http-api.ts', kind: 'run', fn: 'POST /api/sessions/:id/run', names: 'principal' },
  { file: 'tools/builtin/spawn.ts', kind: 'new Agent', fn: 'executeThinker', names: 'principal' },
];

function kindOf(node: ts.Node, file: string): Kind | null {
  // By the bare name only: `new https.Agent(…)` is a connection pool.
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /^(Agent|Session)$/.test(node.expression.text)) return `new ${node.expression.text}` as Kind;
  if (!ts.isCallExpression(node)) return null;
  if (ts.isIdentifier(node.expression) && BY_NAME.test(node.expression.text)) return node.expression.text as Kind;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  const method = node.expression.name.text;
  const receiver = node.expression.expression;
  if (method === 'createSession') return 'createSession';
  // `SessionStore.getOrCreate(id, engine, opts)`; the rate limiter's takes one argument.
  if (method === 'getOrCreate' && node.arguments.length >= 2) return 'getOrCreate';
  if (method !== 'run') return null;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return file === 'core/session.ts' ? 'run' : null;
  // A session held under a name: `session`, `summarySession`, `this.session`. A prepared
  // statement's `.run(…)` is not one, whatever its SQL says.
  const name = ts.isIdentifier(receiver) ? receiver.text : ts.isPropertyAccessExpression(receiver) ? receiver.name.text : '';
  return /session$/i.test(name) ? 'run' : null;
}

/** The name of the function, method or arrow binding a node sits in. */
function enclosingFn(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isGetAccessor(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent)) return n.parent.name.getText();
    // A route handler: `addStatic('user', 'POST /api/…', …)` or `parseDynamicRoute('user', 'POST', '/api/…', …)`.
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent)) {
      const route = n.parent.arguments.filter(ts.isStringLiteral).map((a) => a.text).join(' ').match(/[A-Z]+ \/\S*/);
      if (route) return route[0];
    }
  }
  return '<top>';
}

const isUndefined = (e: ts.Expression): boolean => ts.isIdentifier(e) && e.text === 'undefined';

/** A spread whose every branch is an object literal without `principal`: `...(tier ? { model } : {})`. */
function closedWithout(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isConditionalExpression(e)) return closedWithout(e.whenTrue) && closedWithout(e.whenFalse);
  return ts.isObjectLiteralExpression(e)
    && e.properties.every((p) => !ts.isSpreadAssignment(p) && p.name?.getText() !== 'principal');
}

function namesIn(obj: ts.ObjectLiteralExpression): Names | 'nothing' {
  // In order: a spread after `principal` may overwrite it.
  let named = false;
  let spread = false;
  for (const p of obj.properties) {
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'principal') named = true;
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'principal') named = !isUndefined(p.initializer);
    if (ts.isSpreadAssignment(p) && !closedWithout(p.expression)) { spread = true; named = false; }
  }
  if (named) return 'principal';
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'internal' && p.initializer.kind === ts.SyntaxKind.TrueKeyword) return 'internal';
  }
  return spread ? 'passes through' : 'nothing';
}

/**
 * What an identifier at a place stands for: a parameter of the function it is used in (its caller's
 * options, handed on), or the object literal it was last declared with before the place, in that
 * function and not in one nested in it.
 */
function resolved(id: ts.Identifier): 'parameter' | ts.ObjectLiteralExpression | null {
  let scope: ts.Node | undefined = id.parent;
  while (scope && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  if (!scope) return null;
  if (ts.isFunctionLike(scope) && scope.parameters.some((p) => p.name.getText() === id.text)) return 'parameter';
  let found: ts.ObjectLiteralExpression | null = null;
  const visit = (n: ts.Node): void => {
    if (n.pos >= id.pos) return;
    if (ts.isVariableDeclaration(n) && n.name.getText() === id.text && n.initializer && ts.isObjectLiteralExpression(n.initializer)) found = n.initializer;
    if (!ts.isFunctionLike(n)) n.forEachChild(visit);
  };
  scope.forEachChild(visit);
  return found;
}

function namesOf(node: ts.NewExpression | ts.CallExpression, kind: Kind): Names | 'nothing' {
  const args = node.arguments ?? ts.factory.createNodeArray();
  if (kind === 'spawnPipeline' || kind === 'spawnInline' || kind === 'spawnViaAgent') {
    return args.some((a) => /(^|\.)principal$/.test(a.getText())) ? 'principal' : 'nothing';
  }
  const at: Record<Kind, number> = {
    'new Agent': 0, 'new Session': 1, createSession: 0, run: 1, getOrCreate: 2, runManifest: 2, retryManifest: 3,
    spawnPipeline: -1, spawnInline: -1, spawnViaAgent: -1,
  };
  let opts = args[at[kind]];
  // `buildRunCtx({ … })` asks for the principal by type; the literal it is given still has to name it.
  if (opts && ts.isCallExpression(opts) && opts.expression.getText() === 'buildRunCtx') opts = opts.arguments[0];
  if (!opts) return 'nothing';
  if (ts.isObjectLiteralExpression(opts)) return namesIn(opts);
  if (ts.isIdentifier(opts)) {
    const r = resolved(opts);
    return r === 'parameter' ? 'passes through' : r ? namesIn(r) : 'nothing';
  }
  return 'nothing';
}

export function sitesIn(file: string, text: string): Site[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Site[] = [];
  const visit = (node: ts.Node): void => {
    const kind = kindOf(node, file);
    if (kind) out.push({ file, kind, fn: enclosingFn(node), names: namesOf(node as ts.NewExpression | ts.CallExpression, kind) });
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(name) && !/\.(test|spec|d)\.ts$/.test(name) ? [p] : [];
  });
}

const key = (s: Site): string => `${s.file} · ${s.kind} in ${s.fn} · ${s.names}`;

it('every place in src that builds an agent or a session, or starts a run, names whom it runs for', () => {
  const found = sourceFiles(SRC).flatMap((p) => sitesIn(relative(SRC, p), readFileSync(p, 'utf8')));
  expect(found.map(key).sort()).toEqual(SITES.map(key).sort());
});

it('tells naming a principal from naming nothing, form by form', () => {
  const text = [
    'function a() { new Agent({ model: "x" }); new Agent({ principal }); new https.Agent({}); }',
    'function b() { const o = { principal: p }; s.createSession(o); const q = { model: "x" }; s.createSession(q); }',
    'function c() { session.run(t, { triggerOrigin: "x" }); session.run(t, { internal: true }); stmt.run(sessionId); }',
    'function d(opts) { engine.createSession({ ...opts, sessionId }); limiter.getOrCreate(id); return new Session(e, opts); }',
    'function e() { s.createSession({ principal: undefined }); s.createSession({ principal: p, ...rest }); s.createSession({ principal: p, ...(t ? { model: t } : {}) }); s.createSession({ principal: p, ...(t ? { principal: q } : {}) }); }',
    'function f() { const o = { model: "x" }; const g = () => { const o = { principal: p }; }; s.createSession(o); }',
    'function h() { s.createSession(o); const o = { principal: p }; }',
    'function i() { runManifest(m, c, buildRunCtx({ principal: p })); runManifest(m, c, buildRunCtx({ source })); }',
    'function j() { retryManifest(m, st, c, { principal: p }); store.getOrCreate(id, engine, { principal: p }); }',
    'function k() { spawnInline(s, ctx, options.principal); spawnViaAgent(s, ctx); }',
    'function l() { this.run(t, { principal: p }); }',
  ].join('\n');
  expect(sitesIn('x.ts', text).map(key)).toEqual([
    'x.ts · new Agent in a · nothing',
    'x.ts · new Agent in a · principal',
    'x.ts · createSession in b · principal',
    'x.ts · createSession in b · nothing',
    'x.ts · run in c · nothing',
    'x.ts · run in c · internal',
    'x.ts · createSession in d · passes through',
    'x.ts · new Session in d · passes through',
    'x.ts · createSession in e · nothing',
    'x.ts · createSession in e · passes through',
    'x.ts · createSession in e · principal',
    'x.ts · createSession in e · passes through',
    'x.ts · createSession in f · nothing',
    'x.ts · createSession in h · nothing',
    'x.ts · runManifest in i · principal',
    'x.ts · runManifest in i · nothing',
    'x.ts · retryManifest in j · principal',
    'x.ts · getOrCreate in j · principal',
    'x.ts · spawnInline in k · principal',
    'x.ts · spawnViaAgent in k · nothing',
  ]);
  // `this.run` is a session's own run in `session.ts` only.
  expect(sitesIn('core/session.ts', text).filter((s) => s.kind === 'run' && s.fn === 'l').map(key)).toEqual(['core/session.ts · run in l · principal']);
});
