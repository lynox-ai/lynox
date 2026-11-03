/**
 * Census of the places in `src/` that build an agent or a session, or start a session's run
 * (register 735), and the places that start a workflow run, whose principal its step agents
 * are built for. The public `Agent`, `Session`, `SessionStore` and `runManifest` still read a
 * missing principal as the owner: whoever calls the library directly is the owner. Inside the
 * engine nothing may lean on that default. Every place names whom it runs for, the owner
 * included, so a new entrypoint that forgets it fails here instead of running a mandate's work
 * as the owner.
 *
 * Since register 1173 it reads the code with the TYPE CHECKER, not by its form:
 *  - A place is every `new` or call whose RESOLVED signature is one of the targets below. So an
 *    imported alias, `session['run']`, a receiver of any name, a dynamic import or a subclass's
 *    inherited constructor is a place like any other.
 *  - A place "names" its principal when the TYPE of what it hands over has a `principal` that is
 *    neither optional nor possibly undefined (nor `any`/`unknown`): for the options argument, or,
 *    for a step spawner, the argument at the parameter the signature calls `principal`. A value
 *    that is undefined by type, a literal shadowed or loosened, a principal at the wrong position
 *    all name nothing. `internal: true` (by literal type) is a session's own housekeeping; options
 *    taken from the enclosing function's parameter pass on what its caller gave.
 *  - Refused outright, because a call through them would not resolve to a target: any other
 *    reference to a target (a method taken as a value, `.call`/`.apply`/`.bind`, a function
 *    handed on as a callback, a class extended), and any interface or type in `src/` that a
 *    target class satisfies through a member of a target's name.
 * The census fails both ways: a place not in the list, a listed place that is gone, and a listed
 * place that no longer names its principal.
 *
 *  - Refused too: a call by a target's name (`runManifest`, `createSession`, …) that does not
 *    resolve to the target, whatever type made it compile.
 * A cast (`as`, `<T>`), a `satisfies` or a non-null `!` on what a place hands over, on its
 * `principal`, or on the initializer of the variable it hands over, names nothing: a cast and `!`
 * are believed by the type checker, and `satisfies` keeps a narrower type than the place may
 * assume, so the census asks for the plain value.
 *
 * What it still does not see: a principal removed after the place read its type, through a looser
 * alias (`delete`, `Object.assign`); a value of type `any` assigned into a typed binding earlier,
 * or a cast more than one binding before the place; a call through an `any`-typed or union-typed
 * receiver, `Reflect`, or a non-literal element access; options taken from a parameter of any
 * function, a callback's included ("passes through"); code that is not in the program (`eval`, a
 * string-built import). It reads the program as the compiler does and asserts no compile errors
 * only for its self-test: the real tree's are the typecheck's.
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

type Kind = 'new Agent' | 'new Session' | 'createSession' | 'getOrCreate' | 'run' | 'runManifest' | 'retryManifest' | 'spawnPipeline' | 'spawnInline' | 'spawnViaAgent';
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

/** The targets, by the file (under the source root) that declares them. */
const CLASSES: Readonly<Record<string, string>> = { Agent: 'core/agent.ts', Session: 'core/session.ts' };
const METHODS: Readonly<Record<string, { file: string; kind: Kind }>> = {
  'Session#run': { file: 'core/session.ts', kind: 'run' },
  'Engine#createSession': { file: 'core/engine.ts', kind: 'createSession' },
  'SessionStore#getOrCreate': { file: 'core/session-store.ts', kind: 'getOrCreate' },
};
const FUNCTIONS: Readonly<Record<string, string>> = {
  runManifest: 'orchestrator/runner.ts', retryManifest: 'orchestrator/runner.ts',
  spawnPipeline: 'orchestrator/runtime-adapter.ts', spawnInline: 'orchestrator/runtime-adapter.ts', spawnViaAgent: 'orchestrator/runtime-adapter.ts',
};
/** Where the options are, for the places that take options. */
const OPTIONS_AT: Partial<Record<Kind, number>> = { 'new Agent': 0, 'new Session': 1, createSession: 0, run: 1, getOrCreate: 2, runManifest: 2, retryManifest: 3 };
const SPAWNERS: ReadonlySet<Kind> = new Set(['spawnPipeline', 'spawnInline', 'spawnViaAgent']);

interface Census { sites: Site[]; refused: string[] }

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

export function censusOf(program: ts.Program, srcRoot: string): Census {
  const checker = program.getTypeChecker();
  const fileOf = (d: ts.Node): string => relative(srcRoot, d.getSourceFile().fileName);
  const resolve = (s: ts.Symbol | undefined): ts.Symbol | undefined => (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);

  /** The target class a class declaration is, or extends. */
  const targetClassOf = (t: ts.Type | undefined, seen = new Set<ts.Type>()): string | null => {
    if (!t || seen.has(t)) return null;
    seen.add(t);
    const decl = t.getSymbol()?.valueDeclaration;
    if (decl && ts.isClassDeclaration(decl) && decl.name && CLASSES[decl.name.text] === fileOf(decl)) return decl.name.text;
    if (t.isClassOrInterface()) for (const b of checker.getBaseTypes(t)) { const hit = targetClassOf(b, seen); if (hit) return hit; }
    return null;
  };
  const methodKey = (d: ts.Node | undefined): string | null => {
    if (!d || !(ts.isMethodDeclaration(d) || ts.isPropertyDeclaration(d)) || !d.name) return null;
    const cls = d.parent;
    if (!ts.isClassDeclaration(cls) || !cls.name) return null;
    const key = `${cls.name.text}#${d.name.getText()}`;
    return METHODS[key]?.file === fileOf(d) ? key : null;
  };
  const functionName = (d: ts.Node | undefined): string | null =>
    d && ts.isFunctionDeclaration(d) && d.name && FUNCTIONS[d.name.text] === fileOf(d) ? d.name.text : null;

  const kindOfCall = (node: ts.CallExpression | ts.NewExpression): Kind | null => {
    if (ts.isNewExpression(node)) {
      const cls = targetClassOf(checker.getTypeAtLocation(node));
      return cls ? (`new ${cls}` as Kind) : null;
    }
    const decl = checker.getResolvedSignature(node)?.declaration;
    const m = methodKey(decl);
    if (m) return METHODS[m]!.kind;
    const f = functionName(decl);
    return f ? (f as Kind) : null;
  };

  /** Whether a value of this type always holds a principal: present, and never undefined, null, any or unknown. */
  const holdsPrincipal = (t: ts.Type): boolean => {
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)) return false;
    if (t.isUnion()) return t.types.every(holdsPrincipal);
    return true;
  };
  const property = (t: ts.Type, name: string, at: ts.Node): { optional: boolean; type: ts.Type } | null => {
    const sym = checker.getPropertyOfType(checker.getApparentType(t), name);
    return sym ? { optional: (sym.flags & ts.SymbolFlags.Optional) !== 0, type: checker.getTypeOfSymbolAtLocation(sym, at) } : null;
  };
  /** Whether options come from a parameter of a function (the caller's, handed on). */
  const fromParameter = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isIdentifier(e)) return resolve(checker.getSymbolAtLocation(e))?.valueDeclaration?.kind === ts.SyntaxKind.Parameter;
    if (ts.isObjectLiteralExpression(e)) return e.properties.some((p) => ts.isSpreadAssignment(p) && fromParameter(p.expression));
    return false;
  };

  /** A cast or a non-null assertion, which the type checker would take at its word. */
  const asserted = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e);
  };
  /** The same, on the `principal` of an object literal handed over. */
  const principalAsserted = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return ts.isObjectLiteralExpression(e) && e.properties.some((p) =>
      (ts.isPropertyAssignment(p) && p.name.getText().replace(/['"[\]]/g, '') === 'principal' && asserted(p.initializer))
      || (ts.isSpreadAssignment(p) && asserted(p.expression)));
  };

  /** The initializer of the variable an identifier names, one binding back. */
  const initializerOf = (e: ts.Expression): ts.Expression | undefined => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isIdentifier(e)) return undefined;
    const d = resolve(checker.getSymbolAtLocation(e))?.valueDeclaration;
    return d && ts.isVariableDeclaration(d) ? d.initializer : undefined;
  };
  const castAt = (e: ts.Expression): boolean => {
    const init = initializerOf(e);
    return asserted(e) || principalAsserted(e) || (init !== undefined && (asserted(init) || principalAsserted(init)));
  };

  const namesOf = (node: ts.CallExpression | ts.NewExpression, kind: Kind): Names | 'nothing' => {
    const args = node.arguments ?? ts.factory.createNodeArray<ts.Expression>();
    if (SPAWNERS.has(kind)) {
      const params = checker.getResolvedSignature(node)?.getParameters() ?? [];
      const at = params.findIndex((p) => p.getName() === 'principal');
      const arg = at >= 0 ? args[at] : undefined;
      return arg && !castAt(arg) && holdsPrincipal(checker.getTypeAtLocation(arg)) ? 'principal' : 'nothing';
    }
    const opts = args[OPTIONS_AT[kind] ?? -1];
    if (!opts) return 'nothing';
    const t = checker.getTypeAtLocation(opts);
    if (castAt(opts)) return 'nothing';
    const principal = property(t, 'principal', opts);
    if (principal && !principal.optional && holdsPrincipal(principal.type)) return 'principal';
    const internal = property(t, 'internal', opts);
    if (internal && !internal.optional && internal.type.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(internal.type) === 'true') return 'internal';
    return fromParameter(opts) ? 'passes through' : 'nothing';
  };

  /** A reference to a target that is not a call of it, nor harmless (see the header). */
  const harmless = (node: ts.Node): boolean => {
    const p = node.parent;
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node) return true;
    if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isNamespaceImport(p)) return true;
    // Destructured from a module (`const { runManifest } = await import(…)`): the name it is bound
    // to is tracked as the target itself (`bound` below), so its uses are checked like the target's.
    if (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) return true;
    if ((ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isQualifiedName(p) && p.right === node)) return harmless(p);
    // The declaration of the target itself.
    if ((ts.isClassDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === node) return true;
    // A static member of a target class: `Agent.MAX_RETRIES`. Not of a method or function:
    // `session.run.call(…)` is the reference this refuses.
    if (ts.isPropertyAccessExpression(p) && p.expression === node && isTargetClass(checker.getSymbolAtLocation(node))) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.right === node) return true;
    for (let n: ts.Node = node; n.parent; n = n.parent) {
      if (ts.isHeritageClause(n.parent)) return n.parent.token !== ts.SyntaxKind.ExtendsKeyword;
      if (ts.isTypeNode(n.parent) && !ts.isExpressionWithTypeArguments(n.parent)) return true;
    }
    return false;
  };
  /** Local names bound by destructuring a target out of a module or object. */
  const bound = new Set<ts.Symbol>();
  const isTargetClass = (s: ts.Symbol | undefined): boolean => {
    const d = resolve(s)?.valueDeclaration;
    return d !== undefined && ts.isClassDeclaration(d) && d.name !== undefined && CLASSES[d.name.text] === fileOf(d);
  };
  const isTargetSymbol = (s: ts.Symbol | undefined): boolean => {
    if (s && bound.has(s)) return true;
    const d = resolve(s)?.valueDeclaration;
    if (!d) return false;
    if (ts.isClassDeclaration(d) && d.name) return CLASSES[d.name.text] === fileOf(d);
    return methodKey(d) !== null || functionName(d) !== null;
  };

  const targetInstances = Object.keys(CLASSES).concat(['Engine', 'SessionStore']).flatMap((name) => {
    const file = name === 'Engine' ? 'core/engine.ts' : name === 'SessionStore' ? 'core/session-store.ts' : CLASSES[name]!;
    const sf = program.getSourceFile(join(srcRoot, file));
    const decl = sf?.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name);
    return decl ? [checker.getTypeAtLocation(decl)] : [];
  });
  const MEMBER_NAMES = new Set(Object.keys(METHODS).map((k) => k.split('#')[1]!));
  /** Names a call may not carry unless it resolves to the target of that name. */
  const GUARDED_NAMES = new Set([...Object.keys(FUNCTIONS), 'createSession', 'getOrCreate']);
  const memberName = (m: ts.TypeElement): string => (m.name ? m.name.getText().replace(/['"`\[\]]/g, '') : '');

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.startsWith(srcRoot + '/')) continue;
    const bind = (node: ts.Node): void => {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && ts.isObjectBindingPattern(node.parent)) {
        const decl = node.parent.parent;
        const init = ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
        const prop = init ? checker.getPropertyOfType(checker.getTypeAtLocation(init), (node.propertyName ?? node.name).getText()) : undefined;
        const local = checker.getSymbolAtLocation(node.name);
        if (prop && local && isTargetSymbol(prop)) bound.add(local);
      }
      node.forEachChild(bind);
    };
    bind(sf);
  }
  const sites: Site[] = [];
  const refused: string[] = [];
  for (const sf of program.getSourceFiles()) {
    if (!sf.fileName.startsWith(srcRoot + '/') || /\.(test|spec)\.ts$/.test(sf.fileName)) continue;
    // A declaration file under src declares types only: the type guard reads it, nothing else does.
    const declarationOnly = sf.isDeclarationFile;
    const file = relative(srcRoot, sf.fileName);
    const at = (n: ts.Node): string => `${file}:${String(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)}`;
    const visit = (node: ts.Node): void => {
      if (!declarationOnly && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
        const kind = kindOfCall(node);
        if (kind) sites.push({ file, kind, fn: enclosingFn(node), names: namesOf(node, kind) });
        // Called by a target's name but resolved elsewhere: a type, a module stand-in or a wrapper
        // made it compile, and the census would not see whom it runs for. `getOrCreate` of one
        // argument is the rate limiter's.
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : '';
        if (!kind && GUARDED_NAMES.has(name) && !(name === 'getOrCreate' && (node.arguments?.length ?? 0) < 2)) {
          refused.push(`${at(node)} a call named ${name} that does not resolve to it`);
        }
      }
      if (!declarationOnly && (ts.isIdentifier(node) || ts.isStringLiteral(node))) {
        const target = ts.isStringLiteral(node) ? (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) : true;
        if (target && isTargetSymbol(checker.getSymbolAtLocation(node))) {
          const ref = ts.isStringLiteral(node) ? node.parent : node;
          if (!harmless(ref)) refused.push(`${at(node)} a reference to ${node.getText()} that is not a call`);
        }
      }
      // An interface or type a target class satisfies through a member of a target's name: a call
      // through it resolves to the interface, not to the target.
      if ((ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node))
        && node.members.some((m) => MEMBER_NAMES.has(memberName(m)))) {
        const t = checker.getTypeAtLocation(node);
        if (targetInstances.some((c) => checker.isTypeAssignableTo(c, t))) refused.push(`${at(node)} a type a target class satisfies: a call through it is not seen`);
      }

      node.forEachChild(visit);
    };
    visit(sf);
  }
  return { sites, refused };
}

const key = (s: Site): string => `${s.file} · ${s.kind} in ${s.fn} · ${s.names}`;

function programFor(root: string): ts.Program {
  const cfg = ts.readConfigFile(join(root, 'tsconfig.json'), (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
  return ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, incremental: false });
}

describe('principal census (735, 1173)', () => {
  it('every place in src that builds an agent or a session, or starts a run, names whom it runs for', () => {
    const { sites, refused } = censusOf(programFor(ROOT), join(ROOT, 'src'));
    expect(refused).toEqual([]);
    expect(sites.map(key).sort()).toEqual(SITES.map(key).sort());
    // A place that names nothing is the finding itself, never an entry of the list.
    expect(SITES.filter((s) => s.names === 'nothing')).toEqual([]);
  }, 120_000);

  // A program of stand-ins under the same paths as the targets, one place per form.
  const VSRC = '/virtual/src';
  const STUBS: Record<string, string> = {
    'core/principal.ts': 'export interface P { readonly id: string }',
    'core/agent.ts': "import type { P } from './principal.js';\nexport class Agent { static MAX = 1; constructor(_c: { principal?: P | undefined; model?: string }) {} }",
    'core/session.ts': "import type { P } from './principal.js';\nexport class Session { constructor(_e: unknown, _o?: { principal?: P | undefined }) {} run(_task: string, _o?: { principal?: P | undefined; internal?: boolean }): Promise<string> { return Promise.resolve(''); } }",
    'core/engine.ts': "import type { P } from './principal.js';\nimport { Session } from './session.js';\nexport class Engine { createSession(o?: { principal?: P | undefined; model?: string }): Session { return new Session(this, o); } }",
    'core/session-store.ts': "import type { P } from './principal.js';\nimport type { Engine } from './engine.js';\nimport type { Session } from './session.js';\nexport class SessionStore { getOrCreate(_id: string, e: Engine, o?: { principal?: P | undefined }): Session { return e.createSession(o); } }",
    'orchestrator/runner.ts': "import type { P } from '../core/principal.js';\nexport function runManifest(_m: unknown, _c: unknown, _o: { principal?: P | undefined }): void {}\nexport function retryManifest(_m: unknown, _s: unknown, _c: unknown, _o: { principal?: P | undefined }): void {}",
    'orchestrator/runtime-adapter.ts': "import type { P } from '../core/principal.js';\nexport function spawnInline(_s: unknown, _ctx: unknown, principal?: P | undefined): void { void principal; }\nexport function spawnViaAgent(_s: unknown, _ctx: unknown, principal?: P | undefined): void { void principal; }\nexport function spawnPipeline(_s: unknown, principal?: P | undefined): void { void principal; }",
  };
  const CASES = `
import { Agent, Agent as Aliased } from './core/agent.js';
import { Session } from './core/session.js';
import type { Engine } from './core/engine.js';
import type { SessionStore } from './core/session-store.js';
import { spawnInline, spawnViaAgent, spawnPipeline } from './orchestrator/runtime-adapter.js';
import { runManifest } from './orchestrator/runner.js';
import type { P } from './core/principal.js';
declare const p: P; declare const maybe: P | undefined; declare const loose: any; declare const e: Engine; declare const store: SessionStore; declare const s: Session;
declare function getSession(id: string): Session;
export function literal() { new Agent({ principal: p }); new Agent({ model: 'x' }); }
export function alias() { new Aliased({ principal: p }); new Aliased({}); }
export function element() { void s['run']('t', { principal: p }); }
export function receiver() { void getSession('x').run('t', { principal: p }); }
export function undefinedValue() { e.createSession({ principal: maybe }); }
export function shadowed() { const o = { model: 'x' }; { const o = { principal: p }; void o; } e.createSession(o); }
export function loosened() { const o: { principal?: P | undefined } = { principal: p }; e.createSession(o); }
export function computed() { e.createSession({ ['principal']: p }); }
export function computedKey(k: string) { e.createSession({ [k]: p }); }
export function internal() { void s.run('t', { internal: true }); }
export function notInternal() { void s.run('t', { internal: false }); }
export function cast() { e.createSession({ principal: maybe as P }); e.createSession({ principal: maybe! }); e.createSession({} as { principal: P }); spawnPipeline(1, maybe!); }
export function castMore() { e.createSession({ principal: <P>maybe }); e.createSession({ principal: p } satisfies { principal: P }); e.createSession({ ...({} as { principal: P }) }); const o = { principal: maybe! }; e.createSession(o); }
export function anyValue() { e.createSession({ principal: loose }); }
export interface Deps { runManifest(m: unknown, c: unknown, o: { principal?: P | undefined }): void }
declare const deps: Deps; declare const loose2: { ['createSession'](o?: unknown): Session };
export function stand() { deps.runManifest(1, 2, { principal: p }); loose2.createSession(); }
export function handedOn(opts: { principal?: P }) { store.getOrCreate('id', e, { ...opts }); }
export function position(x: { principal: P }) { spawnInline(1, x.principal, maybe); spawnViaAgent(1, 2, p); spawnPipeline(1, p); }
export async function dynamic() { const { runManifest: run } = await import('./orchestrator/runner.js'); run(1, 2, { principal: p }); const later = run; void later; }
export function reference() { const make = e.createSession; void make; void s.run.call(s, 't'); const cb = runManifest; void cb; }
export class Sub extends Agent {}
export function sub() { new Sub({ principal: p }); }
export interface Starter { createSession(o?: { principal?: P | undefined }): Session }
export function harmless(x: unknown) { void Agent.MAX; return x instanceof Agent; }
`;

  function virtualProgram(cases: string): ts.Program {
    const files = new Map(Object.entries({ ...STUBS, 'x.ts': cases }).map(([k, v]) => [`${VSRC}/${k}`, v]));
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true };
    const host = ts.createCompilerHost(options);
    const tsName = (f: string): string => f.replace(/\.js$/, '.ts');
    const original = { fileExists: host.fileExists.bind(host), readFile: host.readFile.bind(host), getSourceFile: host.getSourceFile.bind(host) };
    host.fileExists = (f) => files.has(tsName(f)) || files.has(f) || (!f.startsWith('/virtual') && original.fileExists(f));
    host.readFile = (f) => files.get(f) ?? (f.startsWith('/virtual') ? undefined : original.readFile(f));
    const dirs = new Set([...files.keys()].flatMap((f) => f.split('/').slice(1, -1).map((_, i, parts) => `/${parts.slice(0, i + 1).join('/')}`)));
    const directoryExists = host.directoryExists?.bind(host);
    host.directoryExists = (d) => dirs.has(d.replace(/\/$/, '')) || (!d.startsWith('/virtual') && (directoryExists?.(d) ?? false));
    host.getSourceFile = (f, lang, ...rest) => {
      const text = files.get(f);
      return text !== undefined ? ts.createSourceFile(f, text, lang, true) : original.getSourceFile(f, lang, ...rest);
    };
    return ts.createProgram([...files.keys()], options, host);
  }

  it('tells naming a principal from naming nothing, form by form, by type', () => {
    const program = virtualProgram(CASES);
    // The stand-ins compile: a census over a program with errors would read types as `any`.
    expect(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const { sites, refused } = censusOf(program, VSRC);
    expect(sites.filter((s) => s.file === 'x.ts').map((s) => `${s.kind} in ${s.fn} · ${s.names}`)).toEqual([
      'new Agent in literal · principal',
      'new Agent in literal · nothing',
      'new Agent in alias · principal',
      'new Agent in alias · nothing',
      'run in element · principal',
      'run in receiver · principal',
      'createSession in undefinedValue · nothing',
      'createSession in shadowed · nothing',
      'createSession in loosened · nothing',
      'createSession in computed · principal',
      'createSession in computedKey · nothing',
      'run in internal · internal',
      'run in notInternal · nothing',
      'createSession in cast · nothing',
      'createSession in cast · nothing',
      'createSession in cast · nothing',
      'spawnPipeline in cast · nothing',
      'createSession in castMore · nothing',
      'createSession in castMore · nothing',
      'createSession in castMore · nothing',
      'createSession in castMore · nothing',
      'createSession in anyValue · nothing',
      'getOrCreate in handedOn · passes through',
      'spawnInline in position · nothing',
      'spawnViaAgent in position · principal',
      'spawnPipeline in position · principal',
      'runManifest in dynamic · principal',
      'new Agent in sub · principal',
    ]);
    // The stand-ins' own places are found too: the engine's session and the store's.
    expect(sites.filter((s) => s.file !== 'x.ts').map(key).sort()).toEqual([
      'core/engine.ts · new Session in createSession · passes through',
      'core/session-store.ts · createSession in getOrCreate · passes through',
    ]);
    expect(refused.map((r) => r.replace(/^x\.ts:\d+ /, ''))).toEqual([
      // A bracketed member name is still the target's name.
      'a type a target class satisfies: a call through it is not seen',
      // A module or object typed to compile, called by the target's name.
      'a call named runManifest that does not resolve to it',
      'a call named createSession that does not resolve to it',
      // `const later = run`: a name destructured from the module is the target.
      'a reference to run that is not a call',
      'a reference to createSession that is not a call',
      'a reference to run that is not a call',
      'a reference to runManifest that is not a call',
      'a reference to Agent that is not a call',
      'a type a target class satisfies: a call through it is not seen',
    ]);
  }, 60_000);
});
