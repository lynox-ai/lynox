/**
 * Audio duration probe — runs `ffprobe` on an in-memory buffer and returns
 * the clip length in seconds. Used by the Usage Dashboard to attribute
 * voice STT cost accurately (prd/usage-dashboard.md Phase 0.5).
 *
 * Decoupled from the transcribe providers so the duration call path is
 * universal: whisper.cpp, Mistral Voxtral, and any future provider all
 * read the same number. Adds ~20 ms per voice upload — bounded by a 5 s
 * ffprobe timeout so a malformed clip can never stall the request.
 *
 * Returns null on any failure (ffprobe missing, parse error, timeout).
 * Callers should treat null as "unknown" and fall back to 0 units rather
 * than refusing the request — voice upload still works without the
 * duration, just without dashboard attribution.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFPROBE_TIMEOUT_MS = 5_000;

/**
 * Hand-rolled Promise wrapper over execFile. Deliberately not using
 * util.promisify — promisify relies on a custom symbol on execFile that
 * a vi.mock replacement doesn't carry, which silently breaks destructuring
 * of the resolved value in tests.
 */
function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', args, { timeout: FFPROBE_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export async function getAudioDurationSec(buffer: Buffer, filename: string): Promise<number | null> {
  // Write the buffer to a private tmp dir — ffprobe reads from disk. Private
  // dir (not /tmp directly) so concurrent calls don't race on the same name.
  const dir = mkdtempSync(join(tmpdir(), 'lynox-audio-'));
  // Preserve the original extension so ffprobe picks the right demuxer
  // (.webm vs .ogg vs .mp3 — matters for container autodetection).
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const file = join(dir, safeName || 'audio');
  try {
    writeFileSync(file, buffer);
    const stdout = await runFfprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const parsed = parseFloat(stdout.trim());
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
  }
}
