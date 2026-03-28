/**
 * Audio transcription via whisper.cpp.
 * Shared between Telegram bot and HTTP API.
 */

import { execFile as nodeExecFile } from 'node:child_process';
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

export async function transcribeAudio(buffer: Buffer, filename: string): Promise<string | null> {
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
      '-m', WHISPER_MODEL!, '-f', wavPath, '--language', 'auto', '--no-timestamps',
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
