/**
 * The TLS floor (tls-floor.ts), measured on real handshakes: a local server that speaks only
 * TLS 1.1 must be refused, one that speaks TLS 1.2 accepted.
 *
 * The client in these tests passes `ciphers: 'DEFAULT:@SECLEVEL=0'`. Without it, OpenSSL 3's
 * security level refuses TLS 1.1 by itself, and a test of the floor would pass with the floor
 * gone. With it, `tls.DEFAULT_MIN_VERSION` is what decides, which the positive control shows:
 * with the default lowered to TLS 1.0, as a `--tls-min-v1.0` launch would do, the 1.1 server IS
 * reached.
 *
 * The certificate is made by `openssl` at test time, so no private key sits in the repository.
 * A missing `openssl` fails the test; it does not skip it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import { pinTlsFloor, TLS_FLOOR } from './tls-floor.js';
import { Engine } from './engine.js';
import { reloadConfig } from './config.js';
import type { LynoxConfig } from '../types/index.js';

const LOW_SECLEVEL = 'DEFAULT:@SECLEVEL=0';
const startDefault = tls.DEFAULT_MIN_VERSION;

let certDir = '';
let key = '';
let cert = '';
const servers: tls.Server[] = [];

/** A local TLS server that accepts exactly one protocol version. */
async function serverAt(version: 'TLSv1.1' | 'TLSv1.2'): Promise<number> {
  const server = tls.createServer({ key, cert, minVersion: version, maxVersion: version, ciphers: LOW_SECLEVEL }, (s) => s.end());
  servers.push(server);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return (server.address() as AddressInfo).port;
}

/** The error a client gets when its floor is above what the server speaks (measured, Node 22). */
const VERSION_REFUSED = 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION';

/** Connect with no `minVersion` of our own, so the process default decides. Resolves with the
 *  negotiated protocol, or with the error code, so a refusal for another reason does not pass. */
function connect(port: number): Promise<string> {
  return new Promise((ok) => {
    // The test certificate is trusted explicitly, so verification stays on.
    const socket = tls.connect({ port, host: '127.0.0.1', servername: 'localhost', ca: cert, ciphers: LOW_SECLEVEL }, () => {
      const protocol = socket.getProtocol() ?? 'unknown';
      socket.destroy();
      ok(protocol);
    });
    socket.on('error', (e: NodeJS.ErrnoException) => ok(e.code ?? 'error without code'));
  });
}

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'lynox-tls-floor-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'k.pem'),
    '-out', join(certDir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  key = readFileSync(join(certDir, 'k.pem'), 'utf8');
  cert = readFileSync(join(certDir, 'c.pem'), 'utf8');
});

afterAll(async () => {
  for (const s of servers) await new Promise<void>((ok) => s.close(() => ok()));
  rmSync(certDir, { recursive: true, force: true });
});

afterEach(() => { tls.DEFAULT_MIN_VERSION = startDefault; });

describe('pinTlsFloor', () => {
  it('refuses a TLS 1.1 server that a lowered default would reach, and still reaches TLS 1.2', async () => {
    const old = await serverAt('TLSv1.1');
    const current = await serverAt('TLSv1.2');
    tls.DEFAULT_MIN_VERSION = 'TLSv1';
    // Positive control: with the default lowered, the client does reach the 1.1 server.
    expect(await connect(old)).toBe('TLSv1.1');
    pinTlsFloor();
    expect(tls.DEFAULT_MIN_VERSION).toBe(TLS_FLOOR);
    expect(await connect(old)).toBe(VERSION_REFUSED);
    expect(await connect(current)).toBe('TLSv1.2');
  });

  it('only raises: a process started with TLS 1.3 as its floor keeps it', () => {
    tls.DEFAULT_MIN_VERSION = 'TLSv1.3';
    pinTlsFloor();
    expect(tls.DEFAULT_MIN_VERSION).toBe('TLSv1.3');
  });
});

describe('Engine boot pins the floor', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const saved = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  afterEach(async () => {
    for (const e of engines) { try { await e.shutdown(); } catch { /* best effort */ } }
    engines.length = 0;
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    saved.clear();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    reloadConfig();
  });

  it('a process launched with a lowered default refuses TLS 1.1 once the engine has booted, and still reaches TLS 1.2', async () => {
    const old = await serverAt('TLSv1.1');
    const current = await serverAt('TLSv1.2');
    const dir = mkdtempSync(join(tmpdir(), 'lynox-tls-floor-boot-'));
    dirs.push(dir);
    for (const k of ['LYNOX_VAULT_KEY', 'LYNOX_MANAGED_INSTANCE_ID']) setEnv(k, undefined);
    setEnv('LYNOX_DATA_DIR', dir);
    reloadConfig();
    tls.DEFAULT_MIN_VERSION = 'TLSv1';
    expect(await connect(old)).toBe('TLSv1.1');
    const engine = new Engine({} as LynoxConfig);
    engines.push(engine);
    await engine.init();
    expect(await connect(old)).toBe(VERSION_REFUSED);
    expect(await connect(current)).toBe('TLSv1.2');
  });
});

describe('no code here lowers the floor on its own', () => {
  const root = fileURLToPath(new URL('../', import.meta.url)); // src/
  /** What would set a floor below TLS 1.2 for one connection or for the process. */
  const LOWERING = [
    /['"]?\bminVersion['"]?\s*[:=]\s*['"`]TLSv1(?:\.1)?['"`]/,
    /['"]?\bsecureProtocol['"]?\s*[:=]/,
    /--tls-min-v1\.[01]\b/,
    /DEFAULT_MIN_VERSION['"]?\]?\s*=(?!=)/,
    /defineProperty\([^)]*DEFAULT_MIN_VERSION/,
  ];
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|mts|cts|mjs|cjs|js)$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });

  it('positive control: each pattern finds what it is meant to find', () => {
    const planted: Array<[number, string]> = [
      [0, `minVersion: 'TLSv1'`], [0, `'minVersion': "TLSv1.1"`], [0, `opts.minVersion = 'TLSv1'`],
      [1, `secureProtocol: 'TLSv1_method'`], [1, `"secureProtocol": x`],
      [2, `node --tls-min-v1.0 x`],
      [3, `tls.DEFAULT_MIN_VERSION = 'TLSv1'`], [3, `tls['DEFAULT_MIN_VERSION'] = v`],
      [4, `Object.defineProperty(tls, 'DEFAULT_MIN_VERSION', { value: 'TLSv1' })`],
    ];
    for (const [i, line] of planted) expect(LOWERING[i]!.test(line), line).toBe(true);
    expect(LOWERING.some((p) => p.test(`minVersion: 'TLSv1.2'`))).toBe(false);
  });

  it('only tls-floor.ts assigns the default, and no file asks for less than TLS 1.2', () => {
    const files = sources(root);
    expect(files.length).toBeGreaterThan(100);
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => ({ at: `${relative(root, f)}:${i + 1}`, line }))
      .filter(({ line }) => LOWERING.some((p) => p.test(line))))
      .filter(({ at }) => !at.startsWith('core/tls-floor.ts:'));
    expect(hits).toEqual([]);
  });

  // Not a boot: the CLI entry runs commands (the installer checks a key over TLS) before any
  // engine exists, and running it here would run a command. So this reads where the call sits.
  it('the CLI entry pins the floor as its first statement', () => {
    const index = readFileSync(join(root, 'index.ts'), 'utf8');
    const body = /async function runCLI\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(index)?.[1] ?? '';
    // Positive control: the body was found (it parses the arguments).
    expect(body).toContain('argv.slice(2)');
    const statements = body.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('//'));
    expect(statements[0]).toBe('pinTlsFloor();');
  });
});
