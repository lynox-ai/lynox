import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Both whisper.cpp entry points hand the upload to ffmpeg with the input guard in front of
 * `-i`. The binary and the model are made to look present; ffmpeg is stubbed to record its
 * arguments and fail, which both entry points catch.
 */

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
const calls: { cmd: string; args: string[] }[] = [];

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: () => true, writeFileSync: () => undefined, unlinkSync: () => undefined };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (cmd: string, args: string[], _opts: unknown, cb: ExecCallback) => {
      calls.push({ cmd, args });
      cb(new Error('stubbed'), '', '');
      return {};
    },
  };
});

const { transcribeWhisperCpp, transcribeWhisperCppStream } = await import('./whisper-cpp.js');
const { INPUT_GUARD_ARGS } = await import('../ffmpeg-input.js');

function guardBeforeInput(args: string[]): boolean {
  const i = args.indexOf('-i');
  return i >= INPUT_GUARD_ARGS.length && args.slice(i - INPUT_GUARD_ARGS.length, i).join('\0') === INPUT_GUARD_ARGS.join('\0');
}

describe('whisper.cpp hands the upload to ffmpeg behind the input guard', () => {
  beforeEach(() => { calls.length = 0; vi.spyOn(process.stderr, 'write').mockImplementation(() => true); });

  it('in the one-shot path', async () => {
    expect(await transcribeWhisperCpp(Buffer.from('x'), 'voice.webm')).toBeNull();
    const ffmpeg = calls.filter((c) => c.cmd === 'ffmpeg');
    expect(ffmpeg).toHaveLength(1);
    expect(guardBeforeInput(ffmpeg[0]!.args)).toBe(true);
  });

  it('in the streaming path', async () => {
    expect(await transcribeWhisperCppStream(Buffer.from('x'), 'voice.webm', () => undefined)).toBeNull();
    const ffmpeg = calls.filter((c) => c.cmd === 'ffmpeg');
    expect(ffmpeg).toHaveLength(1);
    expect(guardBeforeInput(ffmpeg[0]!.args)).toBe(true);
  });
});
