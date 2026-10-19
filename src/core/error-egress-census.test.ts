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
 * provider answer; the ones judged by hand are named in `JUDGED`.
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

/** `file:line  form` for every raw sink in one source text. */
function census(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = sinkKind(node);
      if (kind) {
        for (const arg of node.arguments) {
          const hit = rawText(arg, kind, true);
          if (hit) { out.push(`${fileName}:${String(sf.getLineAndCharacterOfPosition(node.getStart()).line + 1)}  ${hit}`); break; }
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
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
 * - integrations/mail/escalation-mail-channel.ts: a send result lynox formats.
 * - core/config.ts: a schema issue about the local config file.
 * - core/mistral-health-check.ts: the answer to the boot-time GET of the model list, which
 *   sends no run data.
 */
const JUDGED = [
  'core/transcribe/mistral-voxtral.ts', 'core/llm-wire-rules.ts', 'integrations/mail/escalation-mail-channel.ts',
  'core/config.ts', 'core/mistral-health-check.ts',
];

/** Raw sinks per file as of this change. A rise fails (a new sink); a drop asks to lower it here. */
const FROZEN: Record<string, number> = {
  'core/api-store.ts': 9,
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
  const rising = Object.keys(counts).filter((f) => counts[f]! > (FROZEN[f] ?? 0));
  expect(rising.flatMap((f) => found[f]!), 'a new sink writes an error\'s own text: route it through errorText(err, errorTextReduced(...)) from error-egress.ts').toEqual([]);
  expect(counts, 'the census dropped: lower FROZEN to match').toEqual(FROZEN);
  for (const f of JUDGED) expect(FROZEN[f], `${f} is judged but not frozen`).toBeGreaterThan(0);
});
