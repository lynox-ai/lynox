/**
 * Census of the sinks that write an error's own text to stderr or the console. A contained
 * run's errors leave as class and status (`error-egress.ts`); a NEW sink that prints
 * `err.message`, `String(err)`, the whole error object or a response body without going
 * through `errorText` fails here, so none is added silently.
 *
 * The census is by FORM, not by data flow: it sees the shapes listed in `rawText` and nothing
 * else (a helper that formats the error first, `JSON.stringify(err)`, a body under another
 * name, `const msg = err.message` printed as `msg`, `errorText(err, <expression>)`). And it
 * counts per file: one raw sink removed and another added in the same file passes. The existing sites are frozen per file with their count, NOT judged safe one by one:
 * most write internal state errors (SQLite, init, the file system) on paths that carry no
 * provider answer; the ones judged by hand are named in `JUDGED` (whole files) and
 * `JUDGED_SINKS` (single sinks). Neither exempts anything: the counts still hold, and a judgement
 * only records why a frozen sink's text may stay.
 */
import { it, expect } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dirname, '..');
const ERRISH = /^(err|e|error|reason|cause|ex|exc|[a-z]+(Err|Error))$/;
const BODYISH = /^(body|bodyText|errText|errBody|responseText|respText|responseBody)$/;

function sinkKind(call: ts.CallExpression): 'stderr' | 'console' | null {
  const callee = call.expression.getText();
  if (callee === 'process.stderr.write') return 'stderr';
  if (/^console\.(error|warn|log|info|debug)$/.test(callee)) return 'console';
  return null;
}

/** The first raw-error form in `node`, or null. `errorText(...)` subtrees are the sanctioned form. */
function rawText(node: ts.Node, kind: 'stderr' | 'console', topLevelArg: boolean): string | null {
  if (ts.isCallExpression(node) && /^(errorText|reducedErrorText|processErrorText)$/.test(node.expression.getText())) {
    // `errorText(err, false)` is the full text under another name.
    if (node.expression.getText() === 'errorText' && node.arguments[1]?.kind === ts.SyntaxKind.FalseKeyword) return node.getText();
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && (node.name.text === 'message' || node.name.text === 'stack')) return node.getText();
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText();
    const arg = node.arguments[0];
    if (callee === 'String' && arg && ts.isIdentifier(arg) && ERRISH.test(arg.text)) return node.getText();
    if (/(^|\.)getErrorMessage$/.test(callee)) return node.getText();
  }
  if (ts.isTemplateSpan(node) && ts.isIdentifier(node.expression) && ERRISH.test(node.expression.text)) return `\${${node.expression.text}}`;
  if (ts.isIdentifier(node) && BODYISH.test(node.text)) return node.text;
  // A console call formats a whole error object: message and stack.
  if (kind === 'console' && topLevelArg && ts.isIdentifier(node) && ERRISH.test(node.text)) return node.text;
  let hit: string | null = null;
  node.forEachChild((child) => { hit ??= rawText(child, kind, false); });
  return hit;
}

interface RawSink { line: number; form: string; call: string }

/** Every raw sink in one source text, with the text of its call. */
function rawSinks(fileName: string, text: string): RawSink[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: RawSink[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = sinkKind(node);
      if (kind) {
        for (const arg of node.arguments) {
          const hit = rawText(arg, kind, true);
          if (hit) { out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, form: hit, call: node.getText() }); break; }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** `file:line  form` for every raw sink in one source text. */
function census(fileName: string, text: string): string[] {
  return rawSinks(fileName, text).map((s) => `${fileName}:${String(s.line)}  ${s.form}`);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
  });
}

/**
 * Sites judged by hand, beyond "internal state error": why their text may stay.
 * - transcribe/mistral-voxtral.ts: the provider body of a transcription; its input is the
 *   user's audio, never a store read.
 * - core/llm-wire-rules.ts: the wire rule's own refusal text, built by lynox.
 * - integrations/mail/escalation-mail-channel.ts: the mail provider's failure text. Gmail quotes up
 *   to 200 characters of its error body (`oauth-gmail.ts`), SMTP the server's reply line uncut
 *   (`imap-smtp.ts`, `SMTP send failed: …`), Graph only a status and a checked code. That is the
 *   provider's answer to a send, not a store read; it carries the escalation's text only if the
 *   server echoes it back.
 * - core/config.ts: a schema issue about the local config file.
 * - core/mistral-health-check.ts: the answer to the boot-time GET of the model list, which
 *   sends no run data.
 */
const JUDGED = [
  'core/transcribe/mistral-voxtral.ts', 'core/llm-wire-rules.ts', 'integrations/mail/escalation-mail-channel.ts',
  'core/config.ts', 'core/mistral-health-check.ts',
];

/**
 * Single sinks judged by hand, for a file whose other sinks are not: those on the paths a store
 * connection runs (setup, grant, renewal, bulk ledger). `marker` is a literal of the call and
 * must match exactly `count` raw sinks of the file, so a judgement fails when its log line moves
 * away, changes or multiplies. It does NOT see a change in what the try block calls: a provider
 * call added there, or a callee that starts to reach the network, leaves the judgement green and
 * the `why` false. Whoever changes such a try block judges its sink again. As judged: none of
 * these calls a provider; the error is the grant ledger's, the vault's or SQLite's, or a module
 * that did not load.
 */
const JUDGED_SINKS: Record<string, { marker: string; count: number; why: string }[]> = {
  'core/api-store.ts': [
    { marker: 'Hosts of grant for', count: 2, why: 'ledger.recordHosts over hosts lynox derives from the profile' },
    { marker: 'Renewed credential for', count: 1, why: 'the row write of a profile lynox built' },
    { marker: 'Grant ${reason} for', count: 1, why: 'ledger.mint, the in-memory vault fingerprints, recordHosts and the row write, in one local transaction' },
  ],
  'core/engine.ts': [
    { marker: 'Grant backfill failed', count: 1, why: 'backfillGrants and checkFingerprints read the ledger and the vault, no provider' },
    { marker: 'Grant host recompute failed', count: 1, why: 'recomputeGrantHosts, the same ledger write as above' },
    { marker: '[lynox:vault-bindings] Migration failed', count: 1, why: 'binds vault names to the hosts of stored profiles' },
    { marker: 'ending bulk runs of ended mandates failed', count: 1, why: 'the bulk ledger sweep, rows only' },
  ],
  'server/http-api.ts': [
    { marker: 'Grant for the credential write to', count: 1, why: 'secretWritten mints a grant locally after the vault write' },
  ],
  'tools/builtin/http.ts': [
    { marker: 'api_setup did not load', count: 1, why: 'a failed dynamic import of a lynox module; a store connection never renews here' },
  ],
};

/** The judgements whose marker does not match exactly `count` raw sinks of their file. */
function staleJudgements(sinksOf: (file: string) => RawSink[], judged: typeof JUDGED_SINKS): string[] {
  return Object.entries(judged).flatMap(([file, entries]) => {
    const sinks = sinksOf(file);
    return entries
      .filter((j) => sinks.filter((s) => s.call.includes(j.marker)).length !== j.count)
      .map((j) => `${file}: "${j.marker}" matches ${String(sinks.filter((s) => s.call.includes(j.marker)).length)} raw sinks, judged ${String(j.count)}`);
  });
}

it('names a judgement whose sink moved away or multiplied', () => {
  const src = 'process.stderr.write(`[a] one: ${err.message}\\n`);\nprocess.stderr.write(`[a] one: ${String(err)}\\n`);\nprocess.stderr.write(`[a] plain\\n`);';
  const of = (): RawSink[] => rawSinks('a.ts', src);
  expect(staleJudgements(of, { 'a.ts': [{ marker: '[a] one', count: 2, why: '' }] })).toEqual([]);
  expect(staleJudgements(of, { 'a.ts': [{ marker: '[a] one', count: 1, why: '' }] })).toEqual(['a.ts: "[a] one" matches 2 raw sinks, judged 1']);
  // A marker on a call that is no raw sink judges nothing.
  expect(staleJudgements(of, { 'a.ts': [{ marker: '[a] plain', count: 1, why: '' }] })).toEqual(['a.ts: "[a] plain" matches 0 raw sinks, judged 1']);
});

/** Raw sinks per file as of this change. A rise fails (a new sink); a drop asks to lower it here. */
const FROZEN: Record<string, number> = {
  'core/api-store.ts': 8,
  'core/config.ts': 1,
  'core/crm.ts': 2,
  'core/engine-init.ts': 2,
  'core/engine.ts': 34,
  'core/knowledge-layer.ts': 9,
  'core/knowledge-store.ts': 2,
  'core/llm-wire-rules.ts': 1,
  'core/managed-hook.ts': 1,
  'core/mandate-ends.ts': 1,
  'core/memory-facade.ts': 1,
  'core/memory-graph-store.ts': 1,
  'core/mistral-health-check.ts': 1,
  'core/onboarding-promotion.ts': 2,
  'core/retrieval-engine.ts': 1,
  'core/run-history.ts': 1,
  'core/speak/mistral-voxtral-tts.ts': 2,
  'core/transcribe/mistral-voxtral.ts': 2,
  'core/transcribe/whisper-cpp.ts': 2,
  'core/wire-capture.ts': 2,
  'core/worker-loop.ts': 13,
  'core/workflow-questions.ts': 4,
  'egress-proxy/main.ts': 1,
  'integrations/google/google-auth.ts': 1,
  'integrations/inbox/classifier/queue.ts': 1,
  'integrations/mail/escalation-mail-channel.ts': 1,
  'integrations/mail/providers/imap-smtp.ts': 1,
  'integrations/microsoft/microsoft-auth.ts': 1,
  'integrations/push/web-push-channel.ts': 1,
  'scripts/subject-sweep.ts': 1,
  'server/http-api.ts': 8,
  'shell-sidecar/exec-daemon.ts': 1,
  'tools/builtin/http.ts': 1,
};

/**
 * One entry per file whose count rose above FROZEN. The census counts per file and has no
 * key for a single sink, so it cannot say WHICH line is new: it states the count, the frozen
 * count and the difference, then lists every hit of that file. Without the difference, one new
 * sink in a file with ten frozen ones read as eleven new ones.
 */
function risingReport(found: Record<string, string[]>, frozen: Record<string, number>): string[] {
  return Object.keys(found)
    .filter((f) => found[f]!.length > (frozen[f] ?? 0))
    .map((f) => {
      const n = found[f]!.length;
      const m = frozen[f] ?? 0;
      return [`${f}: found ${String(n)}, frozen ${String(m)} (+${String(n - m)}); the new sink is among these lines:`,
        ...found[f]!.map((h) => `  ${h}`)].join('\n');
    });
}

it('reports a rising file with its count, its frozen count and the difference', () => {
  const found = { 'a.ts': ['a.ts:3  err.message', 'a.ts:9  String(e)', 'a.ts:12  err'], 'b.ts': ['b.ts:1  err'] };
  expect(risingReport(found, { 'a.ts': 2, 'b.ts': 1 })).toEqual([
    'a.ts: found 3, frozen 2 (+1); the new sink is among these lines:\n  a.ts:3  err.message\n  a.ts:9  String(e)\n  a.ts:12  err',
  ]);
  // A file below its frozen count is not a rise; the equality check below reports it.
  expect(risingReport({ 'd.ts': ['d.ts:1  err'] }, { 'd.ts': 2 })).toEqual([]);
  // A file the census has never seen counts from zero.
  expect(risingReport({ 'c.ts': ['c.ts:4  err'] }, {})).toEqual([
    'c.ts: found 1, frozen 0 (+1); the new sink is among these lines:\n  c.ts:4  err',
  ]);
});

it('sees every raw form it claims to see, and lets errorText through', () => {
  const src = [
    'process.stderr.write(`a ${err.message}\\n`);',
    'process.stderr.write(`b ${err instanceof Error ? err.message : String(err)}\\n`);',
    'process.stderr.write(`c ${String(reason)}\\n`);',
    'process.stderr.write(`d ${error}\\n`);',
    'process.stderr.write(`e ${body.slice(0, 300)}\\n`);',
    'process.stderr.write(`f ${getErrorMessage(err)}\\n`);',
    'process.stderr.write(`f2 ${errorText(err, false)}\\n`);',
    'console.error(err);',
    "console.warn('g', fetchErr);",
    "console.log('h', e.stack);",
    'process.stderr.write(`ok ${errorText(err, reduce)}\\n`);',
    "console.error('ok', errorText(err, true));",
    "process.stderr.write('ok plain\\n');",
    'process.stderr.write(`ok ${processErrorText(err)}\\n`);',
  ].join('\n');
  expect(census('probe.ts', src).map((l) => l.split(':')[1]?.split(' ')[0])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
});

it('no sink writes raw error text beyond the frozen census', () => {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file);
    const hits = census(rel, readFileSync(file, 'utf8'));
    if (hits.length > 0) found[rel] = hits;
  }
  const counts = Object.fromEntries(Object.entries(found).map(([f, h]) => [f, h.length]));
  expect(risingReport(found, FROZEN), 'a new sink writes an error\'s own text: route it through errorText(err, errorTextReduced(...)) from error-egress.ts').toEqual([]);
  expect(counts, 'the census dropped: lower FROZEN to match').toEqual(FROZEN);
  for (const f of JUDGED) expect(FROZEN[f], `${f} is judged but not frozen`).toBeGreaterThan(0);
  const sinksOf = (file: string): RawSink[] => rawSinks(file, readFileSync(join(SRC, file), 'utf8'));
  expect(staleJudgements(sinksOf, JUDGED_SINKS), 'a judged sink moved or changed: judge it again').toEqual([]);
});
