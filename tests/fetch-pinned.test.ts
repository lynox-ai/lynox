/**
 * Tests for scripts/fetch-pinned.sh — the Whisper model download in the image
 * build — against a local HTTP server, through `sh` (dash on the Debian build
 * stage and on the Ubuntu CI runners; on macOS `sh` is bash).
 *
 * Two claims, each with both directions:
 *   - Fallback: a source that fails — an error status, or a connection that goes
 *     quiet — hands over to the next one; a source that answers is used and the
 *     next one is never asked. A 504 is retried on the same source, a 404 is not.
 *   - Pin: wrong bytes fail the run on EITHER path (first source, or the
 *     fallback), and leave nothing at the destination.
 *
 * The last block reads the Dockerfile and .dockerignore: the tests above prove
 * the script, these prove the build actually runs THAT script with the pinned
 * hash and the mirror first — otherwise a green script test says nothing about
 * the image.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/fetch-pinned.sh', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../Dockerfile', import.meta.url));
const DOCKERIGNORE = fileURLToPath(new URL('../.dockerignore', import.meta.url));

const GOOD = 'the model bytes';
const OTHER = 'some other bytes';
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const GOOD_SHA = sha256(GOOD);

let server: Server;
let base: string;
const hits: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/good') { res.end(GOOD); return; }
    if (req.url === '/other') { res.end(OTHER); return; }
    if (req.url === '/504') { res.statusCode = 504; res.end('gateway timeout'); return; }
    if (req.url === '/stall') return; // accepts the request, never answers
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let dir: string;
let dest: string;
beforeEach(() => {
  hits.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  dest = join(dir, 'model.bin');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** The test env: no retries, a short stall cut-off, and no proxy between curl and the local server. */
function testEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FETCH_RETRIES: '0', FETCH_RETRY_DELAY: '0', FETCH_SPEED_TIME: '2', ...extra };
  for (const k of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) delete env[k];
  return env;
}

/** Run the script asynchronously — a sync spawn would block the server it calls. */
function run(sha: string, ...paths: string[]): Promise<{ code: number; stderr: string }> {
  return runWith({}, sha, ...paths);
}

function runWith(extra: Record<string, string>, sha: string, ...paths: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [SCRIPT, dest, sha, ...paths.map((p) => base + p)], {
      env: testEnv(extra),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe('fetch-pinned.sh — fallback', () => {
  it('uses the second source when the first answers 504', async () => {
    const r = await run(GOOD_SHA, '/504', '/good');
    expect(r.code).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe(GOOD);
    expect(hits).toEqual(['/504', '/good']);
    expect(r.stderr).toContain('trying the next source');
  });

  it('does not ask the second source when the first answers', async () => {
    const r = await run(GOOD_SHA, '/good', '/504');
    expect(r.code).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe(GOOD);
    expect(hits).toEqual(['/good']);
  });

  it('moves on from a source that connects and then goes quiet', async () => {
    const r = await run(GOOD_SHA, '/stall', '/good');
    expect(r.code).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe(GOOD);
    expect(hits).toEqual(['/stall', '/good']);
  }, 15_000);

  it('retries a 504 on the same source, but hands a 404 over at once', async () => {
    const r = await runWith({ FETCH_RETRIES: '2', FETCH_RETRY_DELAY: '1' }, GOOD_SHA, '/504', '/missing', '/good');
    expect(r.code).toBe(0);
    expect(hits).toEqual(['/504', '/504', '/504', '/missing', '/good']);
  }, 15_000);

  it('fails when every source fails, and leaves nothing behind', async () => {
    const r = await run(GOOD_SHA, '/504', '/missing');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('every source failed');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });
});

describe('fetch-pinned.sh — the pin holds on both paths', () => {
  it('fails on wrong bytes from the FIRST source', async () => {
    const r = await run(GOOD_SHA, '/other', '/good');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('do not match the pinned sha256');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it('fails on wrong bytes from the FALLBACK source', async () => {
    const r = await run(GOOD_SHA, '/504', '/other');
    expect(r.code).not.toBe(0);
    expect(hits).toEqual(['/504', '/other']);
    expect(r.stderr).toContain('do not match the pinned sha256');
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
  });

  it('accepts the right bytes on the fallback path (the pin is not simply refusing)', async () => {
    const r = await run(sha256(OTHER), '/504', '/other');
    expect(r.code).toBe(0);
    expect(readFileSync(dest, 'utf8')).toBe(OTHER);
  });
});

describe('the image build runs this script', () => {
  const dockerfile = readFileSync(DOCKERFILE, 'utf8');
  const stage = dockerfile.slice(
    dockerfile.indexOf('AS whisper-build'),
    dockerfile.indexOf('FROM', dockerfile.indexOf('AS whisper-build')),
  );
  const call = stage.slice(stage.indexOf('fetch-pinned.sh /usr/share/whisper/ggml-base.bin'));
  /** The whole RUN instruction that calls the script: from its RUN line to the first line without a trailing `\`. */
  const runStart = stage.search(/^RUN --mount=type=bind,source=scripts\/fetch-pinned\.sh,target=\/tmp\/fetch-pinned\.sh \\$/m);
  const instruction = runStart < 0 ? '' : stage.slice(runStart).split('\n').reduce<{ lines: string[]; open: boolean }>(
    (acc, line) => (acc.open ? { lines: [...acc.lines, line], open: line.endsWith('\\') } : acc),
    { lines: [], open: true },
  ).lines.join('\n');

  it('downloads the model through fetch-pinned.sh, with the pinned hash', () => {
    // The mount must be the RUN instruction itself, not a comment that mentions it.
    expect(runStart).toBeGreaterThanOrEqual(0);
    expect(instruction).toContain('sh /tmp/fetch-pinned.sh /usr/share/whisper/ggml-base.bin');
    expect(call).toMatch(/^fetch-pinned\.sh \/usr\/share\/whisper\/ggml-base\.bin \\\n\s+60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe \\/);
  });

  it('asks the GitHub mirror first and Hugging Face (pinned commit) second', () => {
    const urls = [...call.matchAll(/https:\/\/\S+/g)].map((m) => m[0]);
    expect(urls.slice(0, 2)).toEqual([
      'https://github.com/lynox-ai/lynox/releases/download/whisper-models/ggml-base.bin',
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin',
    ]);
  });

  it('lets a failed download fail the build — no `||`, no `;` after the call', () => {
    expect(instruction).not.toMatch(/\|\||;/);
    expect(instruction.trimEnd().endsWith('/ggml-base.bin')).toBe(true);
  });

  it('has no second, unguarded download of the model left in the stage', () => {
    expect(stage.match(/ggml-base\.bin/g)?.length).toBe(3); // dest + the two URLs
    expect(stage).not.toMatch(/curl[^\n]*ggml-base/);
  });

  it('sends the script into the build context', () => {
    const lines = readFileSync(DOCKERIGNORE, 'utf8').split('\n').map((l) => l.trim());
    expect(lines.indexOf('!scripts/fetch-pinned.sh')).toBeGreaterThan(lines.indexOf('scripts/'));
  });
});
