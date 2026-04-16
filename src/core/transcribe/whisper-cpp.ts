/**
 * Local whisper.cpp provider (fallback + OSS self-host default).
 *
 * Wraps the whisper-cli binary + ggml models. Prefers the tiny model for clips
 * ≤10s (faster, good enough) and base for longer clips.
 *
 * Preserves the exact behavior of the legacy `core/transcribe.ts` implementation
 * — same tmp-file paths, same ffmpeg pre-conversion, same safe-language regex.
 * Only structural change: exposed as a TranscribeProvider for the facade.
 *
 * Security: all subprocess invocations use execFile + spawn with explicit
 * argument arrays (no shell). The `language` arg is validated against a strict
 * `/^[a-z]{2}$/` regex before use.
 */

import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../utils.js';
import type { SegmentCallback, TranscribeOpts, TranscribeProvider } from './types.js';

const WHISPER_PATHS = [
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
];
const WHISPER_MODEL_PATHS = [
  '/usr/share/whisper/ggml-base.bin',
  join(process.env['HOME'] ?? '', '.local/share/whisper/ggml-base.bin'),
];
const WHISPER_TINY_MODEL_PATHS = [
  '/usr/share/whisper/ggml-tiny.bin',
  join(process.env['HOME'] ?? '', '.local/share/whisper/ggml-tiny.bin'),
];

const WHISPER_CLI = WHISPER_PATHS.find((p) => existsSync(p));
const WHISPER_MODEL_BASE = WHISPER_MODEL_PATHS.find((p) => existsSync(p));
const WHISPER_MODEL_TINY = WHISPER_TINY_MODEL_PATHS.find((p) => existsSync(p));

const HAS_WHISPER = !!WHISPER_CLI && !!WHISPER_MODEL_BASE;

export function hasWhisperCpp(): boolean {
  return HAS_WHISPER;
}

/** Short-audio threshold — use tiny model for clips under this duration (seconds). */
const SHORT_AUDIO_THRESHOLD = 10;

function wavDurationSec(wavPath: string): number {
  try {
    const stat = statSync(wavPath);
    return Math.max(0, (stat.size - 44) / 32000); // 16kHz mono 16-bit PCM
  } catch {
    return 999;
  }
}

function pickModel(wavPath: string): string {
  if (!WHISPER_MODEL_TINY) return WHISPER_MODEL_BASE!;
  const duration = wavDurationSec(wavPath);
  return duration <= SHORT_AUDIO_THRESHOLD ? WHISPER_MODEL_TINY : WHISPER_MODEL_BASE!;
}

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    nodeExecFile(cmd, args, { timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) rej(err);
      else res({ stdout, stderr });
    });
  });
}

function safeLang(language: string | undefined): string {
  return /^[a-z]{2}$/.test(language ?? '') ? language! : 'auto';
}

function tmpPaths(filename: string, tenantId?: string): { input: string; wav: string; cleanup: () => void } {
  const id = randomUUID().slice(0, 8);
  const ns = tenantId ? `${tenantId.slice(0, 16)}-` : '';
  const input = join('/tmp', `whisper-in-${ns}${id}-${filename}`);
  const wav = join('/tmp', `whisper-${ns}${id}.wav`);
  const cleanup = () => {
    try { unlinkSync(input); } catch { /* ok */ }
    try { unlinkSync(wav); } catch { /* ok */ }
  };
  return { input, wav, cleanup };
}

export async function transcribeWhisperCpp(
  audio: Buffer,
  filename: string,
  language?: string | undefined,
  opts?: { tenantId?: string | undefined },
): Promise<string | null> {
  if (!HAS_WHISPER) return null;

  const { input, wav, cleanup } = tmpPaths(filename, opts?.tenantId);
  try {
    writeFileSync(input, audio);
    await runCommand('ffmpeg', ['-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wav]);
    const model = pickModel(wav);
    const { stdout } = await runCommand(WHISPER_CLI!, [
      '-m', model, '-f', wav, '--language', safeLang(language), '--no-timestamps',
    ]);
    const text = stdout.trim();
    cleanup();
    return text || null;
  } catch (err: unknown) {
    cleanup();
    process.stderr.write(`[whisper] transcription failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}

export async function transcribeWhisperCppStream(
  audio: Buffer,
  filename: string,
  onSegment: SegmentCallback,
  language?: string | undefined,
  opts?: { tenantId?: string | undefined },
): Promise<string | null> {
  if (!HAS_WHISPER) return null;

  const { input, wav, cleanup } = tmpPaths(filename, opts?.tenantId);
  const lang = safeLang(language);

  try {
    writeFileSync(input, audio);
    await runCommand('ffmpeg', ['-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wav]);

    const model = pickModel(wav);
    const duration = wavDurationSec(wav);
    const modelName = model.includes('tiny') ? 'tiny' : 'base';
    process.stderr.write(`[whisper] ${modelName} model, ${duration.toFixed(1)}s audio\n`);
    onSegment(''); // signal: ffmpeg done, whisper starting

    const t0 = Date.now();
    const fullText = await new Promise<string>((resolve, reject) => {
      const segments: string[] = [];
      const proc = spawn(WHISPER_CLI!, ['-m', model, '-f', wav, '--language', lang], {
        timeout: 120_000,
        shell: false,
      });

      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          // whisper outputs: [00:00:00.000 --> 00:00:03.000]  transcribed text
          const match = /\]\s+(.+)/.exec(line);
          if (match?.[1]) {
            const text = match[1].trim();
            if (text) {
              segments.push(text);
              onSegment(text);
            }
          }
        }
      });

      proc.on('close', (code) => {
        process.stderr.write(`[whisper] done in ${Date.now() - t0}ms (${segments.length} segments)\n`);
        if (code !== 0) reject(new Error(`whisper exited ${String(code)}: ${stderr}`));
        else resolve(segments.join(' '));
      });

      proc.on('error', reject);
    });

    cleanup();
    return fullText || null;
  } catch (err: unknown) {
    cleanup();
    process.stderr.write(`[whisper] streaming transcription failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}

export const whisperCppProvider: TranscribeProvider = {
  name: 'whisper-cpp',
  get isAvailable() { return HAS_WHISPER; },
  async transcribe(buf: Buffer, filename: string, opts: TranscribeOpts): Promise<string | null> {
    return transcribeWhisperCpp(buf, filename, opts.language, {
      ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    });
  },
  async transcribeStream(buf: Buffer, filename: string, onSegment: SegmentCallback, opts: TranscribeOpts): Promise<string | null> {
    return transcribeWhisperCppStream(buf, filename, onSegment, opts.language, {
      ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
    });
  },
};
