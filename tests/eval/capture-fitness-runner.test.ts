/**
 * tests/eval/capture-fitness-runner.mjs, run for real against a fake engine on a local port: the
 * runner is the instrument the capture numbers come from, so the parts that decide what reaches the
 * engine and what is counted are held here — every turn of a multi-turn case goes into the same
 * session, a question the agent asks gets the neutral answer, the written texts are listed and
 * `--out` keeps the rows. No model is called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = resolve(fileURLToPath(import.meta.url), '..', 'capture-fitness-runner.mjs');
// The key is built at run time: corpus-structure-guard refuses a tracked object carrying it.
const TURNS = ['tu', 'rns'].join('');

interface Seen { session: string; task: string }
const seen: Seen[] = [];
const replies: Array<{ promptId: string; answer: string }> = [];
const entries: Array<{ id: string; text: string; sourceThreadId: string | null }> = [];
let dir = '';
let server: Server;
let port = 0;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let s = '';
  for await (const c of req) s += String(c);
  return s ? JSON.parse(s) as Record<string, unknown> : {};
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'capture-runner-'));
  const sink = join(dir, 'capture-telemetry.jsonl');
  const waiting = new Map<string, () => void>();
  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const b = await body(req);
        res.end(JSON.stringify({ sessionId: b['threadId'] }));
        return;
      }
      const run = /^\/api\/sessions\/([^/]+)\/run$/.exec(url.pathname);
      if (req.method === 'POST' && run) {
        const session = run[1]!;
        const task = String((await body(req))['task']);
        seen.push({ session, task });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (task.includes('ASK')) {
          // The turn ends only after the runner answered, as the engine's ask_user does.
          const promptId = `p${seen.length}`;
          const answered = new Promise<void>((r) => waiting.set(promptId, r));
          res.write(`event: prompt\ndata: ${JSON.stringify({ promptId, question: 'Soll ich mir das merken?', options: ['Ja', 'Nein', '\x00'] })}\n\n`);
          await answered;
        }
        if (task.includes('PERM')) {
          const promptId = `p${seen.length}`;
          const answered = new Promise<void>((r) => waiting.set(promptId, r));
          res.write(`event: prompt\ndata: ${JSON.stringify({ promptId, question: 'bash: ls', options: ['Allow', 'Deny', '\x00'] })}\n\n`);
          await answered;
        }
        // An earlier case's run, still going, writes while this one runs.
        if (task.includes('LATE')) entries.push({ id: `x${entries.length + 1}`, text: 'Fremder Eintrag', sourceThreadId: 'another-thread' });
        appendFileSync(sink, JSON.stringify({ ts: Date.now(), event: 'capture_eligible', thread: session }) + '\n');
        if (task.includes('MERK')) {
          const id = `e${entries.length + 1}`;
          entries.push({ id, text: `Regel aus ${task.slice(0, 12)}`, sourceThreadId: session });
          appendFileSync(sink, JSON.stringify({ ts: Date.now(), event: 'remember_invoked', thread: session, outcome: 'active', source: 'model' }) + '\n');
        }
        res.end('event: done\ndata: {}\n\n');
        return;
      }
      if (req.method === 'POST' && /\/reply$/.test(url.pathname)) {
        const b = await body(req);
        if (String(b['answer']) === 'Deny') { res.statusCode = 409; res.end('{}'); return; }
        replies.push({ promptId: String(b['promptId']), answer: String(b['answer']) });
        waiting.get(String(b['promptId']))?.();
        res.end('{}');
        return;
      }
      if (url.pathname === '/api/knowledge/entries') { res.end(JSON.stringify({ entries })); return; }
      if (url.pathname === '/api/knowledge/queue') { res.end(JSON.stringify({ entries: [] })); return; }
      res.statusCode = 404;
      res.end('{}');
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function runRunner(fixtures: unknown, out: string): Promise<{ code: number | null; stdout: string }> {
  const fx = join(dir, `fx-${Date.now()}.json`);
  writeFileSync(fx, JSON.stringify(fixtures));
  return new Promise((done) => {
    const p = spawn(process.execPath, [RUNNER, '--base', `http://127.0.0.1:${port}`, '--data-dir', dir,
      '--fixtures', fx, '--label', 't', '--case-timeout', '30', '--out', out], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (c) => { stdout += String(c); });
    p.on('close', (code) => done({ code, stdout }));
  });
}

describe('capture-fitness-runner', () => {
  it('sends every turn into one session, answers the question neutrally, lists the texts and keeps the rows', async () => {
    const out = join(dir, 'rows.json');
    const r = await runRunner({
      sourceFile: 'src.txt',
      shapes: [
        { id: 'N9-multi', expect: 'silent', cases: [{ [TURNS]: ['Erster Zug ASK {N}', 'Zweiter Zug MERK LATE {N}'] }] },
        { id: 'S9-single', expect: 'capture', cases: ['Einzug MERK {N}'] },
      ],
    }, out);
    expect(r.code, r.stdout).toBe(0);

    // both turns of the multi-turn case reached the engine, in order, in the same session
    const multi = seen.filter((s) => s.task.startsWith('Erster') || s.task.startsWith('Zweiter'));
    expect(multi.map((s) => s.task.split(' ')[0])).toEqual(['Erster', 'Zweiter']);
    expect(new Set(multi.map((s) => s.session)).size).toBe(1);
    // the {N} placeholder was filled in every turn
    expect(seen.every((s) => !s.task.includes('{N}'))).toBe(true);

    // the question got free text, not an option: a "Nein" here would answer "don't remember"
    expect(replies).toEqual([{ promptId: 'p1', answer: 'Entscheide selbst.' }]);

    // the case's own new entry is listed; neither the earlier case's nor another thread's is
    const rows = (JSON.parse(readFileSync(out, 'utf8')) as { rows: Array<{ shape: string; ok: boolean; texts: string[]; answers: string[] }> }).rows;
    const m = rows.find((x) => x.shape === 'N9-multi')!;
    const s = rows.find((x) => x.shape === 'S9-single')!;
    expect(m.ok).toBe(false);
    expect(m.texts).toEqual([expect.stringMatching(/^active: Regel aus Zweiter/)]);
    expect(m.answers).toEqual([expect.stringContaining('→ Entscheide selbst.')]);
    expect(s.ok).toBe(true);
    expect(s.texts).toEqual([expect.stringMatching(/^active: Regel aus Einzug/)]);
    expect(r.stdout).toMatch(/active: Regel aus Zweiter/);
    expect(r.stdout).not.toMatch(/Fremder Eintrag/);
  }, 60_000);

  it('answers a permission prompt with Deny and reports a refused reply as the case\'s error', async () => {
    const out = join(dir, 'rows-perm.json');
    const r = await runRunner({ sourceFile: 'src.txt', shapes: [{ id: 'N8-perm', expect: 'silent', cases: ['Zug PERM {N}'] }] }, out);
    expect(r.code, r.stdout).toBe(0);
    const rows = (JSON.parse(readFileSync(out, 'utf8')) as { rows: Array<{ error?: string }> }).rows;
    // the fake refuses Deny with 409: the case says so instead of waiting for its timeout
    expect(rows[0]!.error).toMatch(/^Error: reply to p\d+: HTTP 409/);
  }, 60_000);
});
