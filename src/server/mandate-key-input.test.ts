import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { LynoxHTTPApi, MANDATE_KEY_INPUT_CODE } from './http-api.js';
import { reloadConfig } from '../core/config.js';
import { getFileAreaDir, _resetCache as resetWorkspaceCache } from '../core/workspace.js';
import { extractDocumentText } from '../core/document-extract.js';
import { buildDocx } from '../../tests/fixtures/minimal-documents.js';
import { channels } from '../core/observability.js';
import { Session } from '../core/session.js';
import { MANDATE_KEY_INPUT_REFUSAL, mandateDocumentCredential } from '../core/secret-store.js';
import { OWNER_PRINCIPAL, type RequestPrincipal } from '../core/request-principal.js';
import type { ThreadStore } from '../core/thread-store.js';
import type { PromptStore } from '../core/prompt-store.js';
import type { AuditLog } from '../core/audit-log.js';

/**
 * The refusal of a key a mandate's helper types, on a booted engine: a mandate's helper who types
 * a key into the chat, or into an answer, is refused with a fixed sentence, and the key reaches no
 * sink — not the model's input, the thread, a prompt row, the instance trail, a log line, an
 * observability event or the response.
 *
 * The model's input is `Session.run`: the run route hands the task to it, and everything after it
 * (the thread, the title, the run history, the model) gets the task from there. It is replaced by a
 * spy, so a run that is let through is seen with what it was handed, and no model is called.
 */
describe('a key typed by a mandate\'s helper (real engine)', () => {
  // Built at runtime, never a literal: a key-shaped fixture string is what the commit-time secret
  // scan looks for, and this repo is public.
  const SECRET = `t-${randomBytes(12).toString('hex')}`;
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const randomKey = (n: number): string => [...randomBytes(n)].map((b) => ALNUM[b % ALNUM.length]).join('');
  /** No vendor prefix: the run route's mask for every principal does not know it. */
  const KEY = `Xq7${randomKey(29)}`;
  const TYPED = `Hier ist der Token: ${KEY}`;
  const ENV = ['LYNOX_DATA_DIR', 'LYNOX_HTTP_SECRET', 'LYNOX_ALLOW_PLAIN_HTTP', 'LYNOX_VAULT_KEY', 'ANTHROPIC_API_KEY', 'LYNOX_WORKSPACE', 'LYNOX_WORKSPACE_ROOT'];
  const saved: Record<string, string | undefined> = {};
  let api: LynoxHTTPApi | undefined;
  let baseUrl: string;
  let dir: string | undefined;
  let ownerResolver: unknown;

  /** A mandate with a grant the engine reads as live (`_mandateLive` is stubbed below): without one, the
   *  run route ends the run before `Session.run`, and the control could not see the model's input. */
  const HELPER: RequestPrincipal = { kind: 'mandate', email: 'helper@example.org', display: 'Helfer', mandateId: 'grant-h' };

  type Engine = { getThreadStore: () => ThreadStore | null; getPromptStore: () => PromptStore | null; getAuditLog: () => AuditLog | null };
  const engine = (): Engine => (api as unknown as { engine: Engine }).engine;
  const as = (p: RequestPrincipal): void => { api!.setPrincipalResolverForTesting(() => p); };

  async function call(method: string, path: string, body?: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-mandate-key-input-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['LYNOX_DATA_DIR'] = dir;
    // The file area an upload is saved to: the default one, under this test's data directory.
    delete process.env['LYNOX_WORKSPACE'];
    delete process.env['LYNOX_WORKSPACE_ROOT'];
    resetWorkspaceCache();
    process.env['LYNOX_HTTP_SECRET'] = SECRET;
    process.env['LYNOX_ALLOW_PLAIN_HTTP'] = 'true';
    process.env['LYNOX_VAULT_KEY'] = `v-${randomBytes(12).toString('hex')}`;
    // The run route's preflight wants a provider key; no model is called (Session.run is a spy).
    process.env['ANTHROPIC_API_KEY'] = `k-${randomBytes(12).toString('hex')}`;
    reloadConfig();
    api = new LynoxHTTPApi();
    await api.init();
    await api.start(0);
    const addr = (api as unknown as { server: Server | null }).server?.address();
    if (addr === null || addr === undefined || typeof addr === 'string') throw new Error('no port');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    ownerResolver = (api as unknown as { _principalResolver: unknown })._principalResolver;
  }, 120_000);

  afterEach(() => {
    (api as unknown as { _principalResolver: unknown })._principalResolver = ownerResolver;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      await api?.shutdown();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
      reloadConfig();
      resetWorkspaceCache();
    }
  });

  /** Everything a request could write to: log lines, process output, and every observability channel. */
  function captureSinks(): { text: () => string; stop: () => void } {
    const lines: string[] = [];
    const push = (...a: unknown[]): void => { lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x) ?? String(x))).join(' ')); };
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(push);
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => { push(String(chunk)); return (out as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => { push(String(chunk)); return (err as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write);
    const subs = Object.values(channels).map((ch) => {
      const fn = (msg: unknown): void => { push(msg); };
      ch.subscribe(fn);
      return { ch, fn };
    });
    return { text: () => lines.join('\n'), stop: () => { for (const { ch, fn } of subs) ch.unsubscribe(fn); } };
  }

  /** Whether any file under the data directory holds `needle`, byte for byte: every SQLite store with
   *  its WAL (threads, run history, prompts, memory, the trail), and any file a capture or a log wrote. */
  function dataDirHolds(needle: string): boolean {
    const want = Buffer.from(needle, 'utf8');
    const walk = (d: string): boolean => readdirSync(d, { withFileTypes: true }).some((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (!e.isFile()) return false;
      return readFileSync(p).includes(want);
    });
    return walk(dir!);
  }

  /** The instance trail's rows, as stored. */
  function trailRows(): string {
    const db = (engine().getAuditLog() as unknown as { db: { prepare(sql: string): { all(): unknown[] } } }).db;
    return JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  }

  /** A session the helper started, so the run and reply routes let the helper in. */
  async function helperSession(): Promise<string> {
    as(HELPER);
    vi.spyOn(api as unknown as { _mandateLive: (id: string) => boolean }, '_mandateLive').mockImplementation((id) => id === 'grant-h');
    const created = await call('POST', '/api/sessions', {});
    expect(created.status, created.text).toBeLessThan(300);
    const { sessionId } = JSON.parse(created.text) as { sessionId: string };
    engine().getThreadStore()!.createThread(sessionId, { title: 't', created_by: `mandate:${HELPER.kind === 'mandate' ? HELPER.email : ''}` });
    return sessionId;
  }

  function spyRun(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(Session.prototype, 'run').mockResolvedValue('ok');
  }

  it('control: the helper\'s ordinary message reaches the model\'s input', async () => {
    const sid = await helperSession();
    const run = spyRun();
    const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Verbinde bitte unseren Shopify-Shop.' });
    expect(res.status, res.text).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
    expect(String(run.mock.calls[0]![0])).toContain('Verbinde bitte unseren Shopify-Shop.');
  }, 60_000);

  it('a message with a key is refused with the fixed sentence, and the key reaches no sink', async () => {
    const sid = await helperSession();
    const run = spyRun();
    const titleBefore = engine().getThreadStore()!.getThread(sid)?.title;
    const sinks = captureSinks();
    let res: { status: number; text: string };
    try {
      res = await call('POST', `/api/sessions/${sid}/run`, { task: TYPED });
    } finally { sinks.stop(); }
    expect(res.status).toBe(422);
    const body = JSON.parse(res.text) as { error?: string; code?: string };
    expect(body.code).toBe(MANDATE_KEY_INPUT_CODE);
    expect(body.error).toBe(MANDATE_KEY_INPUT_REFUSAL);
    // The model's input: never reached.
    expect(run).not.toHaveBeenCalled();
    // The thread, the trail, the log lines and events, the response: none holds any of it.
    const thread = JSON.stringify(engine().getThreadStore()!.getMessages(sid));
    for (const sink of [thread, trailRows(), sinks.text(), res.text]) {
      expect(sink).not.toContain(KEY);
      expect(sink).not.toContain(KEY.slice(-8));
    }
    // Every store on disk: run history, prompts, memory, the thread's title, a capture. The scan finds
    // what a store did write (control first), so its "not found" is a reading, not a blind spot.
    const marker = `m-${randomBytes(12).toString('hex')}`;
    engine().getThreadStore()!.createThread(`probe-${marker}`, { title: marker });
    expect(dataDirHolds(marker), 'control: the scan finds a value a store wrote').toBe(true);
    expect(dataDirHolds(KEY.slice(-8))).toBe(false);
    expect(engine().getThreadStore()!.getThread(sid)?.title).toBe(titleBefore);
  }, 60_000);

  it('a key is refused before a busy conversation could answer instead (409 keeps the message resendable)', async () => {
    const sid = await helperSession();
    const running = (api as unknown as { runningSessions: Map<string, unknown> }).runningSessions;
    running.set(sid, { streamAlive: true, lastEventAt: Date.now(), takeover: () => {} });
    try {
      const busy = await call('POST', `/api/sessions/${sid}/run`, { task: 'Verbinde bitte unseren Shopify-Shop.' });
      expect(busy.status, 'control: an ordinary message gets the busy answer').toBe(409);
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: TYPED });
      expect(res.status).toBe(422);
      expect((JSON.parse(res.text) as { code?: string }).code).toBe(MANDATE_KEY_INPUT_CODE);
    } finally { running.delete(sid); }
  }, 60_000);

  it('a key in a conversation\'s title, a task\'s fields or a compaction\'s focus is refused and not stored', async () => {
    const sid = await helperSession();
    const titled = await call('PATCH', `/api/threads/${sid}`, { title: TYPED });
    expect(titled.status).toBe(422);
    expect(JSON.stringify(engine().getThreadStore()!.getThread(sid))).not.toContain(KEY.slice(-8));
    const control = await call('PATCH', `/api/threads/${sid}`, { title: 'Shop einrichten' });
    expect(control.status, `control: an ordinary title is saved: ${control.text}`).toBeLessThan(300);

    const ordinary = await call('POST', '/api/tasks', { title: 'Lager zählen', description: 'Bis Freitag.' });
    expect(ordinary.status, `control: an ordinary task is created: ${ordinary.text}`).toBeLessThan(300);
    for (const body of [
      { title: TYPED },
      { title: 'Shop verbinden', description: TYPED },
      { title: 'Shop verbinden', params: { token: KEY } },
      { title: 'Shop verbinden', params: { [TYPED]: 'x' } },
      { title: 'Shop verbinden', params: { a: { b: { c: { d: 'x' } } } } },
    ]) {
      const task = await call('POST', '/api/tasks', body);
      expect(task.status, JSON.stringify(body).slice(0, 60)).toBe(422);
      expect((JSON.parse(task.text) as { code?: string }).code).toBe(MANDATE_KEY_INPUT_CODE);
      expect(task.text).not.toContain(KEY.slice(-8));
    }
    const listed = await call('GET', '/api/tasks');
    expect(listed.text, 'control: the listing shows the helper\'s tasks').toContain('Lager zählen');
    expect(listed.text).not.toContain(KEY.slice(-8));

    const compacted = await call('POST', `/api/sessions/${sid}/compact`, { focus: TYPED });
    expect(compacted.status).toBe(422);
    expect((JSON.parse(compacted.text) as { code?: string }).code).toBe(MANDATE_KEY_INPUT_CODE);
    const compactOk = await call('POST', `/api/sessions/${sid}/compact`, { focus: 'die Bestellungen' });
    expect(compactOk.status, 'control: an ordinary focus is not refused for a key').not.toBe(422);
  }, 60_000);

  it('a key in a task edit is refused', async () => {
    as(OWNER_PRINCIPAL);
    const created = await call('POST', '/api/tasks', { title: 'Lager zählen' });
    expect(created.status, created.text).toBeLessThan(300);
    const id = (JSON.parse(created.text) as { id?: string; task?: { id?: string } });
    const taskId = id.id ?? id.task?.id;
    expect(taskId).toBeTruthy();
    await helperSession();
    const edited = await call('PATCH', `/api/tasks/${taskId!}`, { description: TYPED });
    expect(edited.status).toBe(422);
    expect((JSON.parse(edited.text) as { code?: string }).code).toBe(MANDATE_KEY_INPUT_CODE);
    const ok = await call('PATCH', `/api/tasks/${taskId!}`, { description: 'Bis Freitag.' });
    expect(ok.status, `control: an ordinary edit is not refused for a key: ${ok.text}`).not.toBe(422);
    as(OWNER_PRINCIPAL);
    const listed = (await call('GET', '/api/tasks')).text;
    expect(listed, 'control: the owner\'s listing shows the task').toContain('Lager zählen');
    expect(listed).not.toContain(KEY.slice(-8));
  }, 60_000);

  it('the owner\'s message with the same text is not refused (the owner stores keys; the route masks known shapes)', async () => {
    as(OWNER_PRINCIPAL);
    const created = await call('POST', '/api/sessions', {});
    const { sessionId } = JSON.parse(created.text) as { sessionId: string };
    const run = spyRun();
    const res = await call('POST', `/api/sessions/${sessionId}/run`, { task: TYPED });
    expect(res.status, res.text).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('an answer with a key is refused, the question stays open, and nothing of it is stored', async () => {
    const sid = await helperSession();
    const ps = engine().getPromptStore()!;
    const promptId = ps.insertAskUser(sid, 'Wie lautet der Token?', undefined, undefined, undefined, undefined, undefined, { principal: HELPER });
    const sinks = captureSinks();
    let res: { status: number; text: string };
    try {
      res = await call('POST', `/api/sessions/${sid}/reply`, { promptId, answer: KEY });
    } finally { sinks.stop(); }
    expect(res.status).toBe(422);
    expect((JSON.parse(res.text) as { code?: string }).code).toBe(MANDATE_KEY_INPUT_CODE);
    const row = ps.getById(promptId)!;
    expect(row.status).toBe('pending');
    expect(row.answer ?? null).toBeNull();
    for (const sink of [JSON.stringify(row), trailRows(), sinks.text(), res.text]) expect(sink).not.toContain(KEY.slice(-8));
    // The same question takes an ordinary answer afterwards.
    const ok = await call('POST', `/api/sessions/${sid}/reply`, { promptId, answer: 'Den hat der Inhaber.' });
    expect(ok.status, ok.text).toBe(200);
    expect(ps.getById(promptId)!.status).toBe('answered');
  }, 60_000);

  it('a tabs answer and a tabs progress with a key are refused and not stored', async () => {
    const sid = await helperSession();
    const ps = engine().getPromptStore()!;
    const promptId = ps.insertAskUserTabs(sid, [{ question: 'Shop?' }, { question: 'Token?' }], undefined, { principal: HELPER });
    const progress = await call('POST', `/api/sessions/${sid}/tab-progress`, { promptId, partial: ['acme', KEY] });
    expect(progress.status).toBe(422);
    expect(JSON.stringify(ps.getById(promptId))).not.toContain(KEY.slice(-8));
    const tabs = await call('POST', `/api/sessions/${sid}/reply-tabs`, { promptId, answers: ['acme', KEY] });
    expect(tabs.status).toBe(422);
    const row = ps.getById(promptId)!;
    expect(row.status).toBe('pending');
    expect(JSON.stringify(row)).not.toContain(KEY.slice(-8));
  }, 60_000);
  describe('a file the helper attaches', () => {
    /** A vendor-shaped key, built at runtime (this repo is public and scanned for key-shaped literals). */
    const VENDOR_KEY = `${'shp'}at_${randomBytes(16).toString('hex')}`;
    const b64 = (t: string): string => Buffer.from(t, 'utf8').toString('base64');
    /** Longer than the inline limit, so an accepted upload is saved to the file area, not inlined. */
    const big = (marker: string, extra = ''): string => `${marker}\n${'Artikel;Menge;Lager\n'.repeat(1500)}${extra}\n`;

    it('the file area the uploads go to is this test\'s own', () => {
      expect(getFileAreaDir().startsWith(dir!)).toBe(true);
    });

    it('control: an ordinary large file is saved to the file area and the run goes on', async () => {
      const sid = await helperSession();
      const run = spyRun();
      const marker = `m-${randomBytes(12).toString('hex')}`;
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte zusammenfassen.', files: [{ name: 'lager.csv', type: 'text/csv', data: b64(big(marker)) }] });
      expect(res.status, res.text).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
      expect(dataDirHolds(marker), 'control: the saved upload is found on disk').toBe(true);
    }, 60_000);

    it('a large file with a key is refused before any of it is saved, and the run does not start', async () => {
      const sid = await helperSession();
      const run = spyRun();
      const marker = `m-${randomBytes(12).toString('hex')}`;
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte zusammenfassen.', files: [{ name: 'lager.csv', type: 'text/csv', data: b64(big(marker, `Zugang ${VENDOR_KEY}`)) }] });
      expect(res.status).toBe(422);
      expect((JSON.parse(res.text) as { code?: string }).code).toBe(MANDATE_KEY_INPUT_CODE);
      expect(run).not.toHaveBeenCalled();
      expect(dataDirHolds(marker)).toBe(false);
      expect(dataDirHolds(VENDOR_KEY.slice(-8))).toBe(false);
    }, 60_000);

    it('an ordinary first file is not saved when a second one holds a key', async () => {
      const sid = await helperSession();
      const run = spyRun();
      const marker = `m-${randomBytes(12).toString('hex')}`;
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte zusammenfassen.', files: [
        { name: 'lager.csv', type: 'text/csv', data: b64(big(marker)) },
        { name: 'zugang.txt', type: 'text/plain', data: b64(`SHOPIFY=${VENDOR_KEY}\n`) },
      ] });
      expect(res.status).toBe(422);
      expect(run).not.toHaveBeenCalled();
      expect(dataDirHolds(marker)).toBe(false);
    }, 60_000);

    it('a small file with a key is refused, and neither the thread nor the model gets it', async () => {
      const sid = await helperSession();
      const run = spyRun();
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte verbinden.', files: [{ name: 'zugang.txt', type: 'text/plain', data: b64(`SHOPIFY=${VENDOR_KEY}\n`) }] });
      expect(res.status).toBe(422);
      expect(run).not.toHaveBeenCalled();
      expect(JSON.stringify(engine().getThreadStore()!.getMessages(sid))).not.toContain(VENDOR_KEY.slice(-8));
      expect(dataDirHolds(VENDOR_KEY.slice(-8))).toBe(false);
    }, 60_000);

    it('a Word file whose key shows only in its extracted text is refused', async () => {
      // The key split across two runs of the document's XML: its bytes do not hold the key, the text
      // the extraction gives does. So this file is refused only for what the extraction reads.
      const docx = buildDocx(`Zugang ${VENDOR_KEY.slice(0, 12)}</w:t></w:r><w:r><w:t xml:space="preserve">${VENDOR_KEY.slice(12)}`);
      expect(mandateDocumentCredential(docx.toString('utf-8')), 'control: the raw bytes hold no key').toBeNull();
      const extracted = await extractDocumentText(docx, 'zugang.docx');
      expect(mandateDocumentCredential(extracted?.text ?? ''), 'control: the extracted text does').not.toBeNull();
      const sid = await helperSession();
      const run = spyRun();
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte ablegen.', files: [{ name: 'zugang.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx.toString('base64') }] });
      expect(res.status).toBe(422);
      expect(run).not.toHaveBeenCalled();
    }, 60_000);

    it('a file named with a key is refused', async () => {
      const sid = await helperSession();
      const run = spyRun();
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte ansehen.', files: [{ name: `Token ${KEY}.txt`, type: 'text/plain', data: b64('Hallo') }] });
      expect(res.status).toBe(422);
      expect(run).not.toHaveBeenCalled();
      expect(dataDirHolds(KEY.slice(-8))).toBe(false);
    }, 60_000);

    it('control: a document that says "Schlüssel" and carries long reference numbers is not refused', async () => {
      const sid = await helperSession();
      const run = spyRun();
      const doc = `Der Schlüssel für das Lager liegt bei Frau Meier.\nReferenz: ${KEY}\nToken-Nummer der Lieferung: 4711\n`;
      const res = await call('POST', `/api/sessions/${sid}/run`, { task: 'Bitte ablegen.', files: [{ name: 'notiz.txt', type: 'text/plain', data: b64(doc) }] });
      expect(res.status, res.text).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
    }, 60_000);

    it('the owner\'s file with the same key is not refused (the owner stores keys)', async () => {
      const run = spyRun();
      as(OWNER_PRINCIPAL);
      const created = await call('POST', '/api/sessions', {});
      const { sessionId } = JSON.parse(created.text) as { sessionId: string };
      const res = await call('POST', `/api/sessions/${sessionId}/run`, { task: 'Bitte verbinden.', files: [{ name: 'zugang.txt', type: 'text/plain', data: b64(`SHOPIFY=${VENDOR_KEY}\n`) }] });
      expect(res.status, res.text).toBe(200);
      expect(run).toHaveBeenCalledTimes(1);
    }, 60_000);
  });
});
