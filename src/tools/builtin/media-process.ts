/**
 * media_process — a CONSTRAINED, always-on agent tool that shells out to
 * `ffmpeg` to transcode / trim / extract-audio from a file the tenant already
 * owns. It is PERMANENT prompt-injection attack surface (any turn — a mail
 * body, a web result, an uploaded doc — can invoke it), so it is safe by
 * CONSTRUCTION, not by trusting the agent:
 *
 *   1. execFile('ffmpeg', argArray, …) ONLY — never a shell, never `exec`.
 *      Every arg is a separate array element BUILT by this module.
 *   2. `operation` is a closed enum; each op builds its OWN fixed arg array
 *      from validated STRUCTURED params. No free-form -vf/-af/codec/flag
 *      passthrough of any kind.
 *   3. `format` is a hardcoded allowlist; the raw string is only ever a lookup
 *      KEY (FORMAT_SPECS[format]) — never spliced into args. `start`/`duration`
 *      are finite bounded numbers rendered via toFixed(3) (no sign/exponent).
 *   4. The input is confined to the tenant's OWN file area via the SAME
 *      resolver `GET /api/files/download` uses (resolveFileAreaPath), then
 *      COPIED into a private mkdtemp dir. ffmpeg's `-i` only ever sees THAT
 *      controlled tmp path — the agent's input string never reaches argv.
 *   5. `-protocol_whitelist file,pipe` (input-side, before `-i`) blocks a
 *      crafted input file from making ffmpeg open http/concat/subfile/… targets.
 *   6. Bounded: hard execFile timeout + maxBuffer, an always-present `-t`
 *      output-duration ceiling, and a post-run output-size cap (reject + delete).
 *   7. Output lands in the tenant's file area so the existing download endpoint
 *      can serve it; the tool returns a reference, not raw bytes.
 *
 * Mirrors the exec discipline of src/core/audio-duration.ts (ffprobe).
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, copyFileSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ToolEntry } from '../../types/index.js';
import { resolveFileAreaPath, getFileAreaDir } from '../../core/workspace.js';
import { MAX_BUFFER_BYTES } from '../../core/constants.js';

// ── Resource bounds (safe-by-construction ceilings) ──────────────────────────
const FFMPEG_TIMEOUT_MS = 60_000;               // hard wall-clock kill
const MAX_OUTPUT_DURATION_S = 600;              // always-applied `-t` ceiling
const MAX_START_S = 86_400;                     // start-offset sanity ceiling (24h)
const MAX_INPUT_BYTES = 100 * 1024 * 1024;      // reject oversized inputs up front
const MAX_OUTPUT_BYTES = 100 * 1024 * 1024;     // reject+delete oversized outputs
// (100 MB also matches what GET /api/files/download will serve.)

export type MediaOperation = 'transcode' | 'trim' | 'extract_audio';
export const MEDIA_OPERATIONS: readonly MediaOperation[] = ['transcode', 'trim', 'extract_audio'];

export type MediaFormat = 'mp4' | 'webm' | 'mp3' | 'wav' | 'gif';
export const MEDIA_FORMATS: readonly MediaFormat[] = ['mp4', 'webm', 'mp3', 'wav', 'gif'];

export interface MediaProcessInput {
  operation: MediaOperation;
  /** File-area-relative (or absolute-in-area) path to an EXISTING tenant file. */
  input: string;
  /** Target container/codec — hardcoded allowlist. */
  format: MediaFormat;
  /** Seconds to seek before the output starts (trim only). >=0, bounded. */
  start?: number | undefined;
  /** Output duration in seconds. >0, bounded by MAX_OUTPUT_DURATION_S. */
  duration?: number | undefined;
}

interface FormatSpec {
  ext: string;
  kind: 'audio' | 'video';
  /** Fixed encoder+muxer args for a video (or video+audio) output. */
  videoArgs: readonly string[];
  /** Fixed encoder+muxer args for an audio-only output. */
  audioArgs: readonly string[];
}

/**
 * The ONLY codec/muxer configurations this tool can emit. `-f <muxer>` is forced
 * explicitly so the output muxer is never inferred from any agent-supplied
 * string either. `format` is validated against MEDIA_FORMATS before this map is
 * indexed, so an off-allowlist value can never select or splice anything.
 */
const FORMAT_SPECS: Record<MediaFormat, FormatSpec> = {
  mp4:  { ext: 'mp4',  kind: 'video',
    videoArgs: ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-f', 'mp4'],
    audioArgs: ['-vn', '-c:a', 'aac', '-f', 'mp4'] },
  webm: { ext: 'webm', kind: 'video',
    videoArgs: ['-c:v', 'libvpx-vp9', '-c:a', 'libopus', '-f', 'webm'],
    audioArgs: ['-vn', '-c:a', 'libopus', '-f', 'webm'] },
  gif:  { ext: 'gif',  kind: 'video',
    videoArgs: ['-an', '-f', 'gif'],
    audioArgs: ['-an', '-f', 'gif'] },
  mp3:  { ext: 'mp3',  kind: 'audio',
    videoArgs: ['-vn', '-c:a', 'libmp3lame', '-f', 'mp3'],
    audioArgs: ['-vn', '-c:a', 'libmp3lame', '-f', 'mp3'] },
  wav:  { ext: 'wav',  kind: 'audio',
    videoArgs: ['-vn', '-c:a', 'pcm_s16le', '-f', 'wav'],
    audioArgs: ['-vn', '-c:a', 'pcm_s16le', '-f', 'wav'] },
};

/**
 * Pre-spawn validation. Throws (never reaches ffmpeg) on any invalid or
 * injection-shaped input. Called BEFORE any filesystem work or spawn.
 */
export function validateMediaInput(input: MediaProcessInput): void {
  if (!MEDIA_OPERATIONS.includes(input.operation)) {
    throw new Error(`Unsupported operation '${String(input.operation)}'. Allowed: ${MEDIA_OPERATIONS.join(', ')}.`);
  }
  if (!MEDIA_FORMATS.includes(input.format)) {
    throw new Error(`Unsupported format '${String(input.format)}'. Allowed: ${MEDIA_FORMATS.join(', ')}.`);
  }
  if (input.operation === 'extract_audio' && FORMAT_SPECS[input.format].kind !== 'audio') {
    throw new Error(`extract_audio requires an audio format (mp3 or wav), got '${input.format}'.`);
  }
  // `start`/`duration` are the ONLY params rendered into args — they must be
  // finite, non-negative, and bounded. A non-number (schema bypass) is rejected.
  if (input.start !== undefined) {
    if (typeof input.start !== 'number' || !Number.isFinite(input.start) || input.start < 0 || input.start > MAX_START_S) {
      throw new Error(`'start' must be a finite number between 0 and ${MAX_START_S}.`);
    }
  }
  if (input.duration !== undefined) {
    if (typeof input.duration !== 'number' || !Number.isFinite(input.duration) || input.duration <= 0 || input.duration > MAX_OUTPUT_DURATION_S) {
      throw new Error(`'duration' must be a finite number between 0 and ${MAX_OUTPUT_DURATION_S}.`);
    }
  }
  if (input.operation === 'trim' && input.start === undefined && input.duration === undefined) {
    throw new Error(`'trim' requires 'start' and/or 'duration'.`);
  }
  // The input reference must name a file in the tenant's file area — never a
  // URL/protocol reference. Reject scheme-shaped strings up front (defence in
  // depth; resolveFileAreaPath + copy-to-tmp already neutralize them, but this
  // gives a clear rejection before any fs touch).
  const raw = input.input;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('input file reference is required.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.includes('://')) {
    throw new Error(`input must be a file in your files area, not a URL/protocol reference (got '${raw}').`);
  }
}

/**
 * Build the EXACT ffmpeg arg array for an operation. Pure + exported so the
 * guards are unit-testable without spawning ffmpeg. `inputPath`/`outputPath`
 * are ALWAYS this module's controlled tmp paths — never agent strings.
 */
export function buildFfmpegArgs(
  operation: MediaOperation,
  format: MediaFormat,
  inputPath: string,
  outputPath: string,
  opts: { start?: number | undefined; duration?: number | undefined },
): string[] {
  const spec = FORMAT_SPECS[format];
  // Always-present output-duration ceiling = min(requested, hard cap). This
  // bounds a tiny-input → huge-output attempt regardless of operation.
  const requested = opts.duration;
  const outDur =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, MAX_OUTPUT_DURATION_S)
      : MAX_OUTPUT_DURATION_S;

  const args: string[] = [
    '-hide_banner',
    '-nostdin',                            // never read commands from stdin
    '-y',                                  // overwrite our own tmp output only
    '-protocol_whitelist', 'file,pipe',    // INPUT-side: block http/concat/subfile/...
    '-i', inputPath,
  ];

  // trim: frame-accurate seek as an OUTPUT option (after -i). `start` is a
  // validated finite non-negative number rendered as \d+\.\d{3} — no metachar.
  if (operation === 'trim') {
    const start = opts.start;
    if (typeof start === 'number' && Number.isFinite(start) && start > 0) {
      args.push('-ss', start.toFixed(3));
    }
  }

  const encoderArgs =
    operation === 'extract_audio' || spec.kind === 'audio'
      ? spec.audioArgs
      : spec.videoArgs;
  args.push(...encoderArgs);

  // Hard output-duration cap, always applied.
  args.push('-t', outDur.toFixed(3));

  args.push(outputPath);
  return args;
}

/**
 * Post-run output-size guard. Throws on empty or over-cap output so the caller
 * refuses + deletes it (the finally block wipes the tmp dir). Exported for unit
 * tests of the bomb defence without needing a real >100 MB file.
 */
export function checkOutputSize(bytes: number): void {
  if (bytes <= 0) throw new Error('ffmpeg produced an empty output.');
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new Error(`output exceeds the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MB size cap — refused and deleted.`);
  }
}

/** Hand-rolled Promise wrapper over execFile (mirrors audio-duration.ts —
 *  util.promisify's custom symbol doesn't survive vi.mock). */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: FFMPEG_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES }, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}

export const mediaProcessTool: ToolEntry<MediaProcessInput> = {
  definition: {
    name: 'media_process',
    description:
      'Process a media file you already have in your files area with ffmpeg: transcode it to another format, trim a time range, or extract its audio. ' +
      'Input must be an existing file in your files area (the same area write_file saves to and /api/files/download serves) — not a URL. ' +
      'The output is saved back into your files area and a reference is returned. ' +
      'Only these operations and formats are supported — there is no way to pass arbitrary ffmpeg flags or filters.',
    input_schema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string',
          enum: ['transcode', 'trim', 'extract_audio'],
          description: 'transcode: re-encode to `format`. trim: cut a time range (needs start and/or duration). extract_audio: strip to an audio-only file (format must be mp3 or wav).',
        },
        input: {
          type: 'string',
          description: 'Path to an existing file in your files area (relative to it, e.g. "clip.mov"). Not a URL or a path outside the files area.',
        },
        format: {
          type: 'string',
          enum: ['mp4', 'webm', 'mp3', 'wav', 'gif'],
          description: 'Target container/codec. Video: mp4, webm, gif. Audio: mp3, wav.',
        },
        start: {
          type: 'number',
          description: `Trim only: seconds to seek before the output begins (0–${MAX_START_S}).`,
        },
        duration: {
          type: 'number',
          description: `Output duration in seconds (0–${MAX_OUTPUT_DURATION_S}). Also a safety ceiling on the output length.`,
        },
      },
      required: ['operation', 'input', 'format'],
    },
  },
  handler: async (input: MediaProcessInput): Promise<string> => {
    // 1. Structured validation — throws before any fs work or spawn.
    validateMediaInput(input);

    // 2. Confine the input to the tenant's file area (SAME resolver as
    //    GET /api/files/download). Rejects '..', absolute-outside, symlink escape.
    const resolvedInput = resolveFileAreaPath(input.input);
    if (!resolvedInput) {
      throw new Error(`input '${input.input}' is outside your files area.`);
    }
    let inStat;
    try {
      inStat = statSync(resolvedInput);
    } catch {
      throw new Error(`input file not found in your files area: ${input.input}`);
    }
    if (!inStat.isFile()) throw new Error('input is not a regular file.');
    if (inStat.size > MAX_INPUT_BYTES) {
      throw new Error(`input is too large (max ${MAX_INPUT_BYTES / (1024 * 1024)} MB).`);
    }

    const spec = FORMAT_SPECS[input.format];
    // 3. Private tmp dir; copy the resolved file in. ffmpeg only ever sees the
    //    tmp paths built below — never the agent's input string.
    const dir = mkdtempSync(join(tmpdir(), 'lynox-media-'));
    const inExt = extname(resolvedInput).replace(/[^a-zA-Z0-9.]/g, '');
    const localInput = join(dir, `input${inExt}`);
    const localOutput = join(dir, `output.${spec.ext}`);
    try {
      copyFileSync(resolvedInput, localInput);

      const args = buildFfmpegArgs(input.operation, input.format, localInput, localOutput, {
        start: input.start,
        duration: input.duration,
      });
      await runFfmpeg(args);

      // 4. Bound the output: must exist and be within the size cap. On failure
      //    the finally block deletes the whole tmp dir (incl. the partial output).
      let outStat;
      try {
        outStat = statSync(localOutput);
      } catch {
        throw new Error('ffmpeg produced no output (unsupported or corrupt input).');
      }
      checkOutputSize(outStat.size);

      // 5. Land the output in the tenant's file area so the download endpoint
      //    can serve it. The name is generated by this module (no agent input).
      const areaBase = getFileAreaDir();
      mkdirSync(areaBase, { recursive: true });
      const outName = `media_${Date.now()}_${randomBytes(4).toString('hex')}.${spec.ext}`;
      copyFileSync(localOutput, join(areaBase, outName));

      const kb = (outStat.size / 1024).toFixed(1);
      // The output-duration ceiling is always applied as a safety bound. For a
      // whole-file op (transcode / extract_audio) with no explicit duration it
      // would silently truncate a source longer than the cap — disclose it so
      // the truncation is never a surprise.
      const capNote =
        input.operation !== 'trim' && input.duration === undefined
          ? `Output is capped at ${MAX_OUTPUT_DURATION_S / 60} min — a longer source was truncated; ` +
            `pass an explicit 'duration' or 'trim' a range for a specific length. `
          : '';
      return (
        `Done: ${input.operation} → ${input.format}. ` +
        `Saved to your files area as "${outName}" (${kb} KB). ` +
        capNote +
        `Download it via /api/files/download?path=${encodeURIComponent(outName)}.`
      );
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* cleanup best-effort */
      }
    }
  },
};
