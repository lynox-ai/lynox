import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Two mail send paths have no confirmation step of their own: the scheduled-send poller
 * sends every row of `mail_scheduled`, and `EscalationMailChannel` sends model-written
 * text to a configured address. Today nothing feeds either of them. This test fails as
 * soon as something does — a caller of `insertScheduledSend`, any other code that names
 * the `mail_scheduled` table in SQL, a new write statement on that table, or an import
 * (or re-export) of the escalation channel — so the first caller arrives together with
 * the question it owes the user: ask with a preview of the whole message before queuing
 * or sending, and prove the refusal without a prompt channel in a test.
 */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = (file: string): string => relative(SRC, file).split(sep).join('/');

const STATE_FILE = 'integrations/mail/state.ts';
const CHANNEL_FILE = 'integrations/mail/escalation-mail-channel.ts';
const CHANNEL_MODULE = /(^|\/)escalation-mail-channel(\.js|\.ts)?$/;
const TABLE = /\bmail_scheduled\b/;
// Any write that reaches the table: `INSERT OR REPLACE`, `REPLACE INTO`, `UPDATE OR IGNORE`,
// a quoted name or a schema prefix all count.
const TABLE_WRITE = /\b(INSERT|REPLACE|UPDATE|DELETE)\b[^;]*?["'`[]?\bmail_scheduled\b/i;

/**
 * A caller that has its confirmation step. `refusalTest` is the test that runs the caller
 * without a prompt channel and sees it refuse; this file checks that the test exists and
 * imports the caller. Empty on purpose: nothing may feed these paths yet.
 */
const ALLOWED_CALLERS: readonly Allowed[] = [];


/**
 * Every statement in state.ts that writes to `mail_scheduled`, whitespace-collapsed and
 * named by the method it sits in, so a pinned statement moved into another method fails. An
 * UPDATE that changes recipients, subject or body after the user agreed to the send is
 * the change this list exists to stop; one that only moves status or timestamps may be
 * added here.
 */
const PINNED_TABLE_WRITES: readonly string[] = [
  'insertScheduledSend: INSERT INTO mail_scheduled ( id, tenant_id, account_id, to_json, cc_json, bcc_json, subject, body_md, in_reply_to, reply_inbox_item_id, scheduled_at, created_at ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  'claimScheduledSend: UPDATE mail_scheduled SET sending_at = ? WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL AND sending_at IS NULL',
  'failStaleScheduledSends: UPDATE mail_scheduled SET failed_at = ?, fail_reason = ? WHERE sending_at IS NOT NULL AND sending_at < ? AND sent_at IS NULL AND failed_at IS NULL',
  'markScheduledSent: UPDATE mail_scheduled SET sent_at = ?, attempts = attempts + 1, failed_at = NULL, fail_reason = NULL, sending_at = NULL WHERE id = ? AND sent_at IS NULL',
  'bumpScheduledAttempt: UPDATE mail_scheduled SET attempts = attempts + 1, sending_at = NULL WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL RETURNING attempts',
  'markScheduledFailed: UPDATE mail_scheduled SET failed_at = ?, fail_reason = ? WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL',
  'cancelScheduledSend: DELETE FROM mail_scheduled WHERE id = ? AND sent_at IS NULL AND failed_at IS NULL AND sending_at IS NULL',
];

type HitKind = 'calls insertScheduledSend' | 'imports the escalation channel' | 'names the mail_scheduled table' | 'writes mail_scheduled';
interface Hit { kind: HitKind; text: string }

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The class member or function a node sits in, so a pinned statement is pinned to its method. */
function memberOf(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertyDeclaration(n)
         || ts.isGetAccessorDeclaration(n) || ts.isConstructorDeclaration(n))) {
      return ts.isConstructorDeclaration(n) ? 'constructor' : (n.name?.getText() ?? '(anonymous)');
    }
  }
  return '(module)';
}

/** Every hit in one source text, before any exemption. */
function scanSource(fileName: string, text: string): Hit[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const moduleHit = (spec: ts.Node | undefined): void => {
    if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec)) && CHANNEL_MODULE.test(spec.text)) {
      hits.push({ kind: 'imports the escalation channel', text: spec.text });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'insertScheduledSend') {
      hits.push({ kind: 'calls insertScheduledSend', text: node.parent.getText() });
    }
    // The class name counts on its own too, so an import whose path is built at runtime
    // still shows up where the class is used.
    if (ts.isIdentifier(node) && node.text === 'EscalationMailChannel') {
      hits.push({ kind: 'imports the escalation channel', text: node.parent.getText() });
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) moduleHit(node.moduleSpecifier);
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      moduleHit(node.moduleReference.expression);
    }
    if (ts.isCallExpression(node)
        && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      moduleHit(node.arguments[0]);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) moduleHit(node.argument.literal);
    if (ts.isTemplateExpression(node)) {
      // Judged as a whole, with each substitution as a placeholder, so `INSERT INTO ${schema}.mail_scheduled`
      // is a write; its parts are not judged again on their own.
      const whole = node.head.text + node.templateSpans.map((sp) => '${…}' + sp.literal.text).join('');
      if (TABLE_WRITE.test(whole)) hits.push({ kind: 'writes mail_scheduled', text: `${memberOf(node)}: ${collapse(whole)}` });
      else if (TABLE.test(whole)) hits.push({ kind: 'names the mail_scheduled table', text: collapse(whole) });
      for (const sp of node.templateSpans) visit(sp.expression);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text === 'insertScheduledSend') hits.push({ kind: 'calls insertScheduledSend', text: node.getText() });
      // The bare table name, held in a constant or joined by `+`, is treated as a write: the
      // statement that uses it cannot be read here, so it has to be looked at.
      if (TABLE_WRITE.test(node.text) || /^\s*["'`[]?mail_scheduled["'`\]]?\s*$/.test(node.text)) hits.push({ kind: 'writes mail_scheduled', text: `${memberOf(node)}: ${collapse(node.text)}` });
      else if (TABLE.test(node.text)) hits.push({ kind: 'names the mail_scheduled table', text: collapse(node.text) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function sourceFiles(dir: string, seen: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const real = realpathSync(dir);
  if (seen.has(real)) return out;
  seen.add(real);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory());
    if (isDir) out.push(...sourceFiles(full, seen));
    else if (/\.(ts|mts|cts)$/.test(entry.name) && !/\.test\.[mc]?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Hits that are the definitions themselves, not callers of them. */
function isDefinition(file: string, hit: Hit): boolean {
  if (file === CHANNEL_FILE) return hit.kind === 'imports the escalation channel';
  if (file !== STATE_FILE) return false;
  // state.ts owns the table: its schema and reads are the definition. Its writes are
  // pinned separately, and a call of insertScheduledSend from inside state.ts would
  // still be a caller — only the method's own declaration is exempt.
  if (hit.kind === 'names the mail_scheduled table' || hit.kind === 'writes mail_scheduled') return true;
  return hit.kind === 'calls insertScheduledSend' && /^insertScheduledSend\s*\(input: ScheduledSendInput\)/.test(hit.text);
}

interface Allowed { caller: string; refusalTest: string }

/** Every hit that is neither a definition nor in an allowed caller, as a readable line. */
function offendersOf(scanned: ReadonlyArray<{ file: string; hits: Hit[] }>, allowedCallers: readonly Allowed[]): string[] {
  const allowed = new Set(allowedCallers.map((a) => a.caller));
  return scanned.flatMap(({ file, hits }) => hits
    .filter((h) => !isDefinition(file, h) && !allowed.has(file))
    .map((h) => `${file}: ${h.kind} — ${h.text.slice(0, 120)}`));
}

/** What is wrong with an allowlist entry: its refusal test is missing or does not import the caller. */
function problemsOf(entry: Allowed): string[] {
  const testPath = join(SRC, entry.refusalTest);
  if (!existsSync(testPath)) return [`${entry.refusalTest} does not exist`];
  const base = entry.caller.replace(/^.*\//, '').replace(/\.ts$/, '');
  // Any quoted module path ending in the caller: a static import, `await import(…)` or a mock.
  return new RegExp(`['"][^'"]*/${base}(\\.js|\\.ts)?['"]`).test(readFileSync(testPath, 'utf-8'))
    ? [] : [`${entry.refusalTest} does not import ${entry.caller}`];
}

describe('mail send paths without a confirmation step have no unconfirmed caller', () => {
  const files = sourceFiles(SRC);
  const scanned = files.map((f) => ({ file: rel(f), hits: scanSource(f, readFileSync(f, 'utf-8')) }));

  it('the detector sees the definitions it guards (positive control)', () => {
    expect(files.length, 'the source tree was found').toBeGreaterThan(100);
    const state = scanned.find((s) => s.file === STATE_FILE);
    expect(state, 'state.ts was scanned').toBeDefined();
    expect(state!.hits.some((h) => h.kind === 'calls insertScheduledSend'), 'the method declaration').toBe(true);
    expect(state!.hits.some((h) => h.kind === 'writes mail_scheduled' && h.text.startsWith('insertScheduledSend: INSERT INTO mail_scheduled')), 'the INSERT').toBe(true);
    expect(scanned.some((s) => s.file === CHANNEL_FILE), 'the escalation channel was scanned').toBe(true);
    const channelTest = join(SRC, 'integrations/mail/escalation-mail-channel.test.ts');
    expect(scanSource(channelTest, readFileSync(channelTest, 'utf-8')).some((h) => h.kind === 'imports the escalation channel'),
      'an import of the channel is recognised').toBe(true);
  });

  it('walks into symlinked directories and skips test files', () => {
    const root = mkdtempSync(join(tmpdir(), 'dormant-walk-'));
    try {
      mkdirSync(join(root, 'real'));
      writeFileSync(join(root, 'real', 'a.ts'), '');
      writeFileSync(join(root, 'real', 'a.test.ts'), '');
      symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');
      symlinkSync(root, join(root, 'real', 'loop'), 'dir');
      // A directory reached twice is walked once, so a cycle ends; which path names it is the first one met.
      expect(sourceFiles(root).map((f) => relative(root, f).split(sep).join('/')).sort()).toEqual(['linked/a.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognises every shape a caller can take', () => {
    const shapes: ReadonlyArray<[string, HitKind]> = [
      ['state.insertScheduledSend(input);', 'calls insertScheduledSend'],
      ['const { insertScheduledSend: queue } = state;', 'calls insertScheduledSend'],
      ["state['insertScheduledSend'](input);", 'calls insertScheduledSend'],
      ["import { EscalationMailChannel as E } from './escalation-mail-channel.js';", 'imports the escalation channel'],
      ["import type { EscalationMailChannel } from '../mail/escalation-mail-channel.js';", 'imports the escalation channel'],
      ["export * from './escalation-mail-channel.js';", 'imports the escalation channel'],
      ["export { EscalationMailChannel } from './escalation-mail-channel';", 'imports the escalation channel'],
      ["const m = await import('./escalation-mail-channel.js');", 'imports the escalation channel'],
      ["const m = require('./escalation-mail-channel.js');", 'imports the escalation channel'],
      ["type C = import('./escalation-mail-channel.js').EscalationMailChannel;", 'imports the escalation channel'],
      ["db.prepare('SELECT * FROM mail_scheduled').all();", 'names the mail_scheduled table'],
      ['db.prepare(`INSERT INTO mail_scheduled (id) VALUES (${id})`).run();', 'writes mail_scheduled'],
      ["db.prepare('UPDATE  mail_scheduled SET subject = ?').run(s);", 'writes mail_scheduled'],
      ["db.prepare('INSERT OR REPLACE INTO mail_scheduled (id) VALUES (?)').run(id);", 'writes mail_scheduled'],
      ["db.prepare('REPLACE INTO main.mail_scheduled (id) VALUES (?)').run(id);", 'writes mail_scheduled'],
      ['db.prepare(\'UPDATE OR IGNORE "mail_scheduled" SET body_md = ?\').run(b);', 'writes mail_scheduled'],
      ["const m = await import(`./escalation-${'mail'}-channel.js`); new m.EscalationMailChannel(cfg);", 'imports the escalation channel'],
      ['db.prepare(`INSERT INTO ${schema}.mail_scheduled (id) VALUES (?)`).run(id);', 'writes mail_scheduled'],
      ["const T = 'mail_scheduled'; db.prepare(`UPDATE ${T} SET body_md = ?`).run(b);", 'writes mail_scheduled'],
      ["db.prepare('UPDATE ' + 'mail_scheduled' + ' SET subject = ?').run(s);", 'writes mail_scheduled'],
    ];
    for (const [code, kind] of shapes) {
      expect(scanSource('shape.ts', code).map((h) => h.kind), code).toContain(kind);
    }
    expect(scanSource('shape.ts', '// polls mail_scheduled rows\nconst x = 1;'), 'a comment is not a caller').toEqual([]);
    expect(scanSource('shape.ts', "import { x } from './escalation-mail-channel-notes.js';"), 'a different module is not').toEqual([]);
  });

  it('no file outside the definitions feeds these paths without an allowed confirmation step', () => {
    expect(offendersOf(scanned, ALLOWED_CALLERS), [
      'A send path without its own confirmation step gained a caller. Before it can feed the',
      'path, the caller asks the user with a preview of the whole message (as mail_send does),',
      'and a test runs it without a prompt channel and sees the refusal. Then add the caller',
      'and that test to ALLOWED_CALLERS here. A re-export counts as a caller: a barrel that',
      'exports the escalation channel is listed itself, so look there, not only for imports.',
    ].join('\n')).toEqual([]);
  });

  it('the exemptions cover the definitions and nothing else', () => {
    const call: Hit = { kind: 'calls insertScheduledSend', text: 'this.insertScheduledSend(input)' };
    const sql: Hit = { kind: 'names the mail_scheduled table', text: 'SELECT * FROM mail_scheduled' };
    const imp: Hit = { kind: 'imports the escalation channel', text: './escalation-mail-channel.js' };
    expect(offendersOf([{ file: 'integrations/mail/other.ts', hits: [call, sql, imp] }], []), 'a caller elsewhere counts').toHaveLength(3);
    expect(offendersOf([{ file: STATE_FILE, hits: [call] }], []), 'a call inside state.ts still counts').toHaveLength(1);
    expect(offendersOf([{ file: CHANNEL_FILE, hits: [call, sql] }], []), 'the channel file is exempt only for itself').toHaveLength(2);
    const ownState = scanned.find((s) => s.file === STATE_FILE)!;
    expect(offendersOf([ownState], []), 'positive control: state.ts as it is has no offender').toEqual([]);
    expect(offendersOf([{ file: 'x.ts', hits: [call] }], [{ caller: 'x.ts', refusalTest: 'x.test.ts' }]), 'an allowed caller is not listed').toEqual([]);
  });

  it('every allowed caller names a refusal test that exists and imports it', () => {
    expect(ALLOWED_CALLERS.flatMap(problemsOf)).toEqual([]);
    expect(problemsOf({ caller: 'integrations/mail/nowhere.ts', refusalTest: 'integrations/mail/nowhere.test.ts' }), 'a missing test is reported').toHaveLength(1);
    expect(problemsOf({ caller: 'integrations/mail/state.ts', refusalTest: 'integrations/mail/escalation-mail-channel.test.ts' }),
      'a test that does not import the caller is reported').toHaveLength(1);
    expect(problemsOf({ caller: CHANNEL_FILE, refusalTest: 'integrations/mail/escalation-mail-channel.test.ts' }),
      'positive control: a test that imports it passes').toEqual([]);
  });

  it('the writes on mail_scheduled in state.ts are exactly the pinned ones', () => {
    const writes = scanned.find((s) => s.file === STATE_FILE)!.hits
      .filter((h) => h.kind === 'writes mail_scheduled').map((h) => h.text);
    expect(writes, [
      'The statements that write mail_scheduled changed. A write that changes recipients,',
      'subject or body after the user agreed to the send must not be added; one that only',
      'moves status or timestamps may be pinned here.',
    ].join('\n')).toEqual(PINNED_TABLE_WRITES);
  });
});
