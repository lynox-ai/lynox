/**
 * media_process — adversarial guard tests. Each test proves a guard holds
 * against REAL behavior, not against the agent behaving. The unit layer
 * (validation, arg-building, size cap, pre-spawn rejection) runs without a
 * real ffmpeg; a gated integration layer runs the happy path only when an
 * ffmpeg binary is present.
 *
 * execFile is wrapped so we can (a) COUNT spawns — every "must be rejected
 * before ffmpeg runs" test asserts the counter stayed at 0 — and (b) let the
 * integration tests pass through to the real binary.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// node:child_process is mocked below; execFileSync is preserved via `...actual`,
// so this resolves to the REAL binary runner (used only to build fixtures + probe).
import { execFileSync as execFileSyncShim } from 'node:child_process';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileFn = (cmd: string, args: string[], opts: unknown, cb: ExecCallback) => unknown;

// Hoisted shared state — the mock factory is hoisted above imports, so its state
// must be too (a plain top-level `let` assigned inside the factory hits a TDZ).
const h = vi.hoisted(() => ({
  spawnCount: 0,
  real: null as ExecFileFn | null,
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  h.real = actual.execFile as unknown as ExecFileFn;
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: ExecCallback) => {
      h.spawnCount++;
      // Real passthrough — the integration tests need the actual binary; the
      // rejection tests never reach here (they throw pre-spawn), which is
      // exactly what `h.spawnCount === 0` asserts.
      return h.real!(cmd, args, opts, cb);
    },
  };
});

// Import after vi.mock is registered so the module captures the mocked execFile.
const {
  mediaProcessTool,
  buildFfmpegArgs,
  validateMediaInput,
  checkOutputSize,
  MEDIA_FORMATS,
  MEDIA_OPERATIONS,
} = await import('./media-process.js');
const { setTenantWorkspace, clearTenantWorkspace, getFileAreaDir } = await import('../../core/workspace.js');

type Input = Parameters<typeof mediaProcessTool.handler>[0];
// Minimal agent stub — this tool ignores the agent argument entirely.
const agent = {} as Parameters<typeof mediaProcessTool.handler>[1];

function run(input: Input): Promise<string> {
  return mediaProcessTool.handler(input, agent);
}

// A dedicated tmp file area for every test (isolation workspace override).
let areaDir: string;
const HAS_FFMPEG: boolean = (() => {
  try { execFileSyncShim('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

beforeEach(() => {
  h.spawnCount = 0;
  areaDir = mkdtempSync(join(tmpdir(), 'lynox-media-area-'));
  setTenantWorkspace(areaDir);
});

// Count the tool's private work dirs (lynox-media-*) but not the test areas
// (lynox-media-area-*) — used to prove the finally-block cleanup.
function workDirCount(): number {
  return readdirSync(tmpdir(), { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('lynox-media-') && !e.name.startsWith('lynox-media-area-'))
    .length;
}

afterAll(() => {
  clearTenantWorkspace();
});

describe('validateMediaInput / pre-spawn rejections', () => {
  it('rejects path traversal (../../../etc/passwd) before ffmpeg runs', async () => {
    await expect(run({ operation: 'transcode', input: '../../../etc/passwd', format: 'mp4' }))
      .rejects.toThrow(/outside your files area/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects an absolute path outside the area (/etc/passwd) before ffmpeg runs', async () => {
    await expect(run({ operation: 'transcode', input: '/etc/passwd', format: 'mp4' }))
      .rejects.toThrow(/outside your files area/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects a URL scheme (http://) before ffmpeg runs', async () => {
    await expect(run({ operation: 'transcode', input: 'http://evil.example/x.mp4', format: 'mp4' }))
      .rejects.toThrow(/not a URL\/protocol/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects the file: protocol before ffmpeg runs', async () => {
    await expect(run({ operation: 'transcode', input: 'file:/etc/passwd', format: 'mp4' }))
      .rejects.toThrow(/not a URL\/protocol/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects the concat: protocol before ffmpeg runs', async () => {
    await expect(run({ operation: 'transcode', input: 'concat:/etc/passwd|/etc/hosts', format: 'mp4' }))
      .rejects.toThrow(/not a URL\/protocol/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects a shell-injection format value (never reaches args)', async () => {
    await expect(run({ operation: 'transcode', input: 'clip.mov', format: 'mp4; rm -rf /' as unknown as 'mp4' }))
      .rejects.toThrow(/Unsupported format/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects an arg-injection format value (-i /etc/passwd)', async () => {
    await expect(run({ operation: 'transcode', input: 'clip.mov', format: '-i /etc/passwd' as unknown as 'mp4' }))
      .rejects.toThrow(/Unsupported format/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects a non-number (arg-flag string) start param', async () => {
    await expect(run({ operation: 'trim', input: 'clip.mov', format: 'mp4', start: '-ss' as unknown as number }))
      .rejects.toThrow(/'start' must be a finite number/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects a negative start and a NaN/Infinity duration', () => {
    expect(() => validateMediaInput({ operation: 'trim', input: 'a.mov', format: 'mp4', start: -5 }))
      .toThrow(/'start' must be a finite number/);
    expect(() => validateMediaInput({ operation: 'trim', input: 'a.mov', format: 'mp4', duration: Infinity }))
      .toThrow(/'duration' must be a finite number/);
    expect(() => validateMediaInput({ operation: 'trim', input: 'a.mov', format: 'mp4', duration: 0 }))
      .toThrow(/'duration' must be a finite number/);
  });

  it('rejects extract_audio into a video format', async () => {
    await expect(run({ operation: 'extract_audio', input: 'clip.mov', format: 'mp4' }))
      .rejects.toThrow(/extract_audio requires an audio format/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects an unknown operation', async () => {
    await expect(run({ operation: 'exfiltrate' as unknown as 'trim', input: 'clip.mov', format: 'mp4' }))
      .rejects.toThrow(/Unsupported operation/);
    expect(h.spawnCount).toBe(0);
  });

  it('rejects a valid-but-nonexistent input (stat gate) before ffmpeg runs', async () => {
    await expect(run({ operation: 'transcode', input: 'does-not-exist.mov', format: 'mp4' }))
      .rejects.toThrow(/not found in your files area/);
    expect(h.spawnCount).toBe(0);
  });
});

describe('buildFfmpegArgs — exact arg arrays (attack surface)', () => {
  const IN = '/tmp/priv/input.mov';
  const OUT = '/tmp/priv/output.mp4';

  it('transcode → mp4: fixed codec array, input-side protocol whitelist, capped -t', () => {
    const args = buildFfmpegArgs('transcode', 'mp4', IN, OUT, {});
    expect(args).toEqual([
      '-hide_banner', '-nostdin', '-y',
      '-protocol_whitelist', 'file,pipe',
      '-i', IN,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4',
      '-t', '600.000',
      OUT,
    ]);
    // protocol_whitelist must be an INPUT option (before -i).
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
  });

  it('trim → wav: seek+range are OUTPUT options rendered as \\d+.\\d{3}', () => {
    const args = buildFfmpegArgs('trim', 'wav', IN, '/tmp/priv/output.wav', { start: 1.5, duration: 2 });
    expect(args).toEqual([
      '-hide_banner', '-nostdin', '-y',
      '-protocol_whitelist', 'file,pipe',
      '-i', IN,
      '-ss', '1.500',
      '-vn', '-c:a', 'pcm_s16le', '-f', 'wav',
      '-t', '2.000',
      '/tmp/priv/output.wav',
    ]);
    expect(args.indexOf('-ss')).toBeGreaterThan(args.indexOf('-i')); // -ss AFTER -i
  });

  it('extract_audio → mp3: audio-only (-vn) fixed codecs', () => {
    const args = buildFfmpegArgs('extract_audio', 'mp3', IN, '/tmp/priv/output.mp3', {});
    expect(args).toContain('-vn');
    expect(args).toContain('libmp3lame');
    expect(args.slice(0, 5)).toEqual(['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe']);
  });

  it('caps an oversized requested duration to the hard ceiling (600s)', () => {
    const args = buildFfmpegArgs('trim', 'mp4', IN, OUT, { start: 0, duration: 99_999 });
    const t = args[args.indexOf('-t') + 1];
    expect(t).toBe('600.000');
  });

  it('no built arg array ever contains agent free-text — only whitelisted tokens', () => {
    // For every op×format the only non-fixed tokens are our own paths + numeric
    // durations. Assert nothing shell/flag-injection-shaped leaks in.
    for (const op of MEDIA_OPERATIONS) {
      for (const fmt of MEDIA_FORMATS) {
        if (op === 'extract_audio' && fmt !== 'mp3' && fmt !== 'wav') continue;
        const args = buildFfmpegArgs(op, fmt, IN, OUT, { start: 1, duration: 3 });
        for (const a of args) {
          expect(a.includes(';')).toBe(false);
          expect(a.includes('rm -rf')).toBe(false);
          expect(a.includes('$(')).toBe(false);
          expect(a.includes('&&')).toBe(false);
        }
        expect(args).toContain('file,pipe');
      }
    }
  });
});

describe('checkOutputSize — tiny-input → huge-output bomb defence', () => {
  it('throws on an over-cap output', () => {
    expect(() => checkOutputSize(200 * 1024 * 1024)).toThrow(/size cap/);
  });
  it('throws on an empty output', () => {
    expect(() => checkOutputSize(0)).toThrow(/empty output/);
  });
  it('accepts an in-bounds output', () => {
    expect(() => checkOutputSize(4096)).not.toThrow();
  });
});

describe.runIf(HAS_FFMPEG)('integration (real ffmpeg)', () => {
  function makeFixtureWav(name: string, durationS = 1): string {
    const p = `${areaDir}/${name}`;
    execFileSyncShim('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${durationS}`,
      '-c:a', 'pcm_s16le', '-y', p,
    ], { stdio: 'ignore' });
    return p;
  }

  it('trims a real clip → output lands in the file area and tmp is cleaned', async () => {
    makeFixtureWav('fixture.wav', 2);
    const before = workDirCount();
    const result = await run({ operation: 'trim', input: 'fixture.wav', format: 'wav', start: 0, duration: 0.5 });
    expect(h.spawnCount).toBeGreaterThan(0);
    expect(result).toMatch(/Saved to your files area as "media_/);
    // The output file exists in the area and is non-empty.
    const outName = /"(media_[^"]+)"/.exec(result)?.[1];
    expect(outName).toBeTruthy();
    const outPath = `${getFileAreaDir()}/${outName}`;
    expect(existsSync(outPath)).toBe(true);
    expect(statSync(outPath).size).toBeGreaterThan(0);
    // No leftover work dirs (finally cleaned up).
    expect(workDirCount()).toBeLessThanOrEqual(before);
  });

  it('extracts audio from a real clip → mp3 in the file area', async () => {
    makeFixtureWav('voice.wav', 1);
    const result = await run({ operation: 'extract_audio', input: 'voice.wav', format: 'mp3' });
    const outName = /"(media_[^"]+\.mp3)"/.exec(result)?.[1];
    expect(outName).toBeTruthy();
    expect(existsSync(`${getFileAreaDir()}/${outName}`)).toBe(true);
  });
});
