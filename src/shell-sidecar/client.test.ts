import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execViaSidecar, SidecarOverflowError } from './client.js';
import { MAX_EXEC_TIMEOUT_MS } from './protocol.js';

/** A daemon stand-in: reads the request line, then does whatever `script` says. */
function fakeDaemon(script: (s: Socket, request: unknown) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'exec-client-'));
  const sock = join(dir, 'exec.sock');
  const requests: unknown[] = [];
  const server: Server = createServer((s) => {
    let buf = '';
    s.on('error', () => {});
    s.on('data', (d) => {
      buf += d.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) { const r: unknown = JSON.parse(buf.slice(0, nl)); requests.push(r); script(s, r); }
    });
  });
  const ready = new Promise<void>((r) => server.listen(sock, () => r()));
  const cleanup = async (): Promise<void> => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { sock, ready, requests, cleanup };
}

const exit0 = '{"t":"exit","code":0,"signal":null,"timedOut":false}\n';
let current: ReturnType<typeof fakeDaemon> | null = null;
afterEach(async () => { await current?.cleanup(); current = null; });

describe('exec client', () => {
  it('collects both streams and the exit, and sends a capped timeout', async () => {
    const d = (current = fakeDaemon((s) => { s.write('{"t":"out","d":"a"}\n{"t":"err","d":"b"}\n{"t":"out","d":"c"}\n'); s.end(exit0); }));
    await d.ready;
    const r = await execViaSidecar(d.sock, { cmd: 'x', timeoutMs: 0, env: { A: '1' } }, 1024);
    expect(r).toEqual({ stdout: 'ac', stderr: 'b', code: 0, signal: null, timedOut: false, limitMs: 120_000 });
    expect(d.requests[0]).toEqual({ cmd: 'x', timeoutMs: 120_000, env: { A: '1' } });
  });

  it('caps a huge timeout before sending it', async () => {
    const d = (current = fakeDaemon((s) => s.end(exit0)));
    await d.ready;
    await execViaSidecar(d.sock, { cmd: 'x', timeoutMs: 10 * MAX_EXEC_TIMEOUT_MS, env: {} }, 1024);
    expect(d.requests[0]).toMatchObject({ timeoutMs: MAX_EXEC_TIMEOUT_MS });
  });

  it('passes a refusal through as error', async () => {
    const d = (current = fakeDaemon((s) => s.end('{"t":"exit","code":null,"signal":null,"timedOut":false,"error":"no free uid in the pool"}\n')));
    await d.ready;
    const r = await execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 1024);
    expect(r.error).toBe('no free uid in the pool');
  });

  it('keeps a character whole when a frame line arrives in two chunks', async () => {
    const d = (current = fakeDaemon((s) => {
      const line = Buffer.from('{"t":"out","d":"ä"}\n');
      s.write(line.subarray(0, 15));
      setTimeout(() => { s.write(line.subarray(15)); s.end(exit0); }, 50);
    }));
    await d.ready;
    expect((await execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 1024)).stdout).toBe('ä');
  });

  it('rejects a bad frame instead of passing it on', async () => {
    const d = (current = fakeDaemon((s) => s.end('{"t":"out","d":"a","extra":1}\n' + exit0)));
    await d.ready;
    await expect(execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 1024)).rejects.toThrow(/bad frame/);
  });

  it('rejects a stream that ends without an exit frame', async () => {
    const d = (current = fakeDaemon((s) => s.end('{"t":"out","d":"a"}\n')));
    await d.ready;
    await expect(execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 1024)).rejects.toThrow(/without an exit frame/);
  });

  it('rejects data after the exit frame', async () => {
    const d = (current = fakeDaemon((s) => s.end(exit0 + '{"t":"out","d":"late"}\n')));
    await d.ready;
    await expect(execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 1024)).rejects.toThrow(/after the exit frame/);
  });

  it('stops at the output cap per stream and keeps what came', async () => {
    const d = (current = fakeDaemon((s) => { s.write('{"t":"err","d":"xxxxxxxx"}\n'); s.write('{"t":"out","d":"yyyyyyyyy"}\n'); }));
    await d.ready;
    const err: unknown = await execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 8).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SidecarOverflowError);
    expect((err as SidecarOverflowError).stderr).toBe('xxxxxxxx');
    expect((err as SidecarOverflowError).stdout).toBe('yyyyyyyyy');
  });

  it('rejects an oversize line without waiting for its end', async () => {
    const d = (current = fakeDaemon((s) => { s.write('{"t":"out","d":"' + 'x'.repeat(200 * 1024)); }));
    await d.ready;
    await expect(execViaSidecar(d.sock, { cmd: 'x', timeoutMs: undefined, env: {} }, 1 << 20)).rejects.toThrow(/oversize line/);
  });

  it('gives up at its own deadline when the daemon never answers', async () => {
    const d = (current = fakeDaemon(() => {}));
    await d.ready;
    await expect(execViaSidecar(d.sock, { cmd: 'x', timeoutMs: 50, env: {} }, 1024, 50)).rejects.toThrow(/no exit within 100ms/);
  });

  it('fails when there is no daemon', async () => {
    await expect(execViaSidecar(join(tmpdir(), 'no-such-exec.sock'), { cmd: 'x', timeoutMs: undefined, env: {} }, 1024)).rejects.toThrow(/exec sidecar: .*ENOENT/);
  });
});
