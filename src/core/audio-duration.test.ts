/**
 * audio-duration tests — focus on the contract (null on any failure, number
 * on success), not on ffprobe itself. ffprobe availability is environmental;
 * we only assert that when ffprobe produces valid output we parse it, and
 * when anything goes wrong we return null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
type MockExecFile = (cmd: string, args: string[], opts: unknown, cb: ExecCallback) => unknown;

let _execFileImpl: MockExecFile = (_cmd, _args, _opts, cb) => {
  cb(new Error('not mocked'), '', '');
  return {};
};

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (cmd: string, args: string[], opts: unknown, cb: ExecCallback) =>
      _execFileImpl(cmd, args, opts, cb),
  };
});

// Import after vi.mock is registered so the module captures the mocked execFile.
const { getAudioDurationSec, estimateAudioSecondsFromBytes, ASSUMED_OPUS_BITRATE_BPS } = await import('./audio-duration.js');

describe('getAudioDurationSec', () => {
  beforeEach(() => {
    _execFileImpl = (_cmd, _args, _opts, cb) => {
      cb(new Error('not mocked'), '', '');
      return {};
    };
  });

  it('returns the parsed duration from ffprobe stdout', async () => {
    _execFileImpl = (_cmd, _args, _opts, cb) => { cb(null, '12.345\n', ''); return {}; };
    const duration = await getAudioDurationSec(Buffer.from('fake audio'), 'clip.webm');
    expect(duration).toBeCloseTo(12.345, 3);
  });

  it('returns null when ffprobe errors', async () => {
    _execFileImpl = (_cmd, _args, _opts, cb) => { cb(new Error('ffprobe not found'), '', ''); return {}; };
    const duration = await getAudioDurationSec(Buffer.from('fake audio'), 'clip.webm');
    expect(duration).toBeNull();
  });

  it('returns null when ffprobe stdout is not a number', async () => {
    _execFileImpl = (_cmd, _args, _opts, cb) => { cb(null, 'N/A\n', ''); return {}; };
    const duration = await getAudioDurationSec(Buffer.from('fake audio'), 'clip.webm');
    expect(duration).toBeNull();
  });

  it('returns null when duration is negative (defensive)', async () => {
    _execFileImpl = (_cmd, _args, _opts, cb) => { cb(null, '-1.5\n', ''); return {}; };
    const duration = await getAudioDurationSec(Buffer.from('fake audio'), 'clip.webm');
    expect(duration).toBeNull();
  });
});

describe('estimateAudioSecondsFromBytes — probe-free billing fallback', () => {
  it('returns a non-zero estimate for any non-empty buffer (never bills $0)', () => {
    expect(estimateAudioSecondsFromBytes(1)).toBeGreaterThan(0);
    expect(estimateAudioSecondsFromBytes(48_000)).toBeGreaterThan(0);
  });

  it('applies seconds ≈ bytes*8 / assumed bitrate', () => {
    // 48000 bytes × 8 bits ÷ 48000 bps = 8 seconds at the assumed bitrate.
    expect(estimateAudioSecondsFromBytes(ASSUMED_OPUS_BITRATE_BPS)).toBeCloseTo(8, 6);
    expect(estimateAudioSecondsFromBytes(2 * ASSUMED_OPUS_BITRATE_BPS)).toBeCloseTo(16, 6);
  });

  it('scales monotonically with byte length', () => {
    expect(estimateAudioSecondsFromBytes(96_000)).toBeGreaterThan(estimateAudioSecondsFromBytes(48_000));
  });

  it('returns 0 for an empty or non-positive buffer (nothing to bill)', () => {
    expect(estimateAudioSecondsFromBytes(0)).toBe(0);
    expect(estimateAudioSecondsFromBytes(-10)).toBe(0);
  });
});
