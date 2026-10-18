import { describe, it, expect } from 'vitest';
import { INPUT_DEMUXERS, INPUT_GUARD_ARGS } from './ffmpeg-input.js';
import { toWavArgs } from './transcribe/whisper-cpp.js';

/**
 * The input-side ffmpeg guard and the voice path that uses it. What ffmpeg then does with
 * these arguments was measured on the image's ffmpeg (5.1), not here: this host has none.
 */

describe('INPUT_GUARD_ARGS', () => {
  it('allows only local protocols and the listed demuxers', () => {
    expect(INPUT_GUARD_ARGS).toEqual(['-protocol_whitelist', 'file,pipe', '-format_whitelist', INPUT_DEMUXERS.join(',')]);
  });

  it('names no demuxer that reads a list of further files or URLs', () => {
    for (const demuxer of ['hls', 'applehttp', 'dash', 'imf', 'concat', 'image2', 'image2pipe', 'mpd', 'sdp', 'rtsp', 'tee', 'subfile']) {
      expect(INPUT_DEMUXERS).not.toContain(demuxer);
    }
  });
});

describe('the whisper.cpp voice conversion', () => {
  it('puts the guard before the input, so ffmpeg applies it to the upload', () => {
    const args = toWavArgs('/tmp/in.webm', '/tmp/out.wav');
    const i = args.indexOf('-i');
    expect(args.slice(i - INPUT_GUARD_ARGS.length, i)).toEqual([...INPUT_GUARD_ARGS]);
    expect(args.slice(i, i + 2)).toEqual(['-i', '/tmp/in.webm']);
    expect(args[args.length - 1]).toBe('/tmp/out.wav');
  });
});
