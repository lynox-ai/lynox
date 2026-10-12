/**
 * Tests for scripts/fetch-pinned.sh — the Whisper model download in the image
 * build — against a local HTTP server, through the same `sh` the build stage
 * uses.
 *
 * Two claims, each with both directions:
 *   - Fallback: a source that fails hands over to the next one; a source that
 *     answers is used and the next one is never asked.
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
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

let dir: string;
let dest: string;
beforeEach(() => {
  hits.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'fetch-pinned-'));
  dest = join(dir, 'model.bin');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Run the script asynchronously — a sync spawn would block the server it calls. */
function run(sha: string, ...paths: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [SCRIPT, dest, sha, ...paths.map((p) => base + p)], {
      env: { ...process.env, FETCH_RETRIES: '0', FETCH_RETRY_DELAY: '0' },
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

  it('downloads the model through fetch-pinned.sh, with the pinned hash', () => {
    expect(stage).toContain('--mount=type=bind,source=scripts/fetch-pinned.sh,target=/tmp/fetch-pinned.sh');
    expect(call).toMatch(/^fetch-pinned\.sh \/usr\/share\/whisper\/ggml-base\.bin \\\n\s+60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe \\/);
  });

  it('asks the GitHub mirror first and Hugging Face (pinned commit) second', () => {
    const urls = [...call.matchAll(/https:\/\/\S+/g)].map((m) => m[0]);
    expect(urls.slice(0, 2)).toEqual([
      'https://github.com/lynox-ai/lynox/releases/download/whisper-models/ggml-base.bin',
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin',
    ]);
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
