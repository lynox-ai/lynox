/**
 * Audio transcription via whisper.cpp.
 * Shared between Telegram bot and HTTP API.
 */

import { execFile as nodeExecFile, spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from './utils.js';

const WHISPER_PATHS = [
  '/usr/local/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
];
const WHISPER_MODEL_PATHS = [
  '/usr/share/whisper/ggml-base.bin',
  join(process.env['HOME'] ?? '', '.local/share/whisper/ggml-base.bin'),
];

const WHISPER_CLI = WHISPER_PATHS.find(p => existsSync(p));
const WHISPER_MODEL = WHISPER_MODEL_PATHS.find(p => existsSync(p));

export const HAS_WHISPER = !!WHISPER_CLI && !!WHISPER_MODEL;

function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

export async function transcribeAudio(buffer: Buffer, filename: string, language?: string): Promise<string | null> {
  if (!HAS_WHISPER) return null;

  const id = randomUUID().slice(0, 8);
  const inputPath = join('/tmp', `whisper-in-${id}-${filename}`);
  const wavPath = join('/tmp', `whisper-${id}.wav`);
  const cleanup = () => {
    try { unlinkSync(inputPath); } catch { /* ok */ }
    try { unlinkSync(wavPath); } catch { /* ok */ }
  };
  try {
    writeFileSync(inputPath, buffer);
    await runCommand('ffmpeg', [
      '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
    ]);
    const { stdout } = await runCommand(WHISPER_CLI!, [
      '-m', WHISPER_MODEL!, '-f', wavPath, '--language', language ?? 'auto', '--no-timestamps',
    ]);
    const text = stdout.trim();
    cleanup();
    return text || null;
  } catch (err: unknown) {
    cleanup();
    process.stderr.write(`Whisper transcription failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}

/**
 * Streaming transcription — emits text segments as whisper processes them.
 * Uses timestamps mode so whisper outputs line-by-line.
 * All args are hardcoded paths (no user input in commands).
 */
export async function transcribeAudioStream(
  buffer: Buffer,
  filename: string,
  onSegment: (text: string) => void,
  language?: string,
): Promise<string | null> {
  if (!HAS_WHISPER) return null;

  const id = randomUUID().slice(0, 8);
  const inputPath = join('/tmp', `whisper-in-${id}-${filename}`);
  const wavPath = join('/tmp', `whisper-${id}.wav`);
  const cleanup = () => {
    try { unlinkSync(inputPath); } catch { /* ok */ }
    try { unlinkSync(wavPath); } catch { /* ok */ }
  };

  // Validate language to prevent injection (only allow safe values)
  const safeLang = /^[a-z]{2}$/.test(language ?? '') ? language! : 'auto';

  try {
    writeFileSync(inputPath, buffer);
    await runCommand('ffmpeg', [
      '-i', inputPath, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wavPath,
    ]);

    onSegment(''); // signal: ffmpeg done, whisper starting

    const fullText = await new Promise<string>((resolve, reject) => {
      const segments: string[] = [];
      // spawn with explicit arg array — no shell, no injection risk
      const proc = spawn(WHISPER_CLI!, [
        '-m', WHISPER_MODEL!, '-f', wavPath, '--language', safeLang,
      ], { timeout: 60_000, shell: false });

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
        if (code !== 0) reject(new Error(`whisper exited ${code}: ${stderr}`));
        else resolve(segments.join(' '));
      });

      proc.on('error', reject);
    });

    cleanup();
    return fullText || null;
  } catch (err: unknown) {
    cleanup();
    process.stderr.write(`Whisper streaming transcription failed: ${getErrorMessage(err)}\n`);
    return null;
  }
}
