#!/usr/bin/env npx tsx
/**
 * Phase 0 spike: evaluate Mistral Voxtral on German business speech with
 * Anglicisms.
 *
 * See pro/docs/internal/prd/voice-transcription-v2.md (Phase 0).
 *
 * Models tested per clip (both EU-hosted, Mistral La Plateforme / Paris):
 *   - mistral/voxtral-mini-2602       (transcribe-optimized, primary candidate)
 *   - mistral/voxtral-small-latest    (bigger sibling — does size help code-switching?)
 *
 * Each model runs twice per clip: plain and with a `context_biasing` keyword
 * hint listing business/tech Anglicisms the speaker uses.
 *
 * Reads core/tests/fixtures/voice/spike-{01..10}.webm; missing files are
 * skipped (record them yourself).
 *
 * Requirements: MISTRAL_API_KEY. No US/China-hosted providers by policy.
 * Run: npx tsx core/scripts/spike-voxtral.ts
 */

import { readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ──────────────────────────────────────────────────────────────────

const LANGUAGE = 'de';

const BIAS_KEYWORDS = [
  'Meeting', 'Deployment', 'Staging', 'Sprint', 'Launch', 'Follow-up',
  'Setup Wizard', 'Go-Live', 'Customer Journey', 'A/B Testing',
  'Landing Page', 'Pricing', 'Dashboard', 'Release', 'Logs', 'Server',
  'Onboarding', 'Blocker', 'Pipeline', 'Action Items', 'Thread',
];

interface Clip {
  readonly id: string;
  readonly file: string;
  readonly category: string;
  readonly expected: string | null; // null = free-form, WER skipped
}

const CLIPS: readonly Clip[] = [
  {
    id: '01',
    file: 'spike-01.webm',
    category: 'Pure DE ~5s',
    expected: 'Fass mir bitte die wichtigsten Punkte von heute zusammen.',
  },
  {
    id: '02',
    file: 'spike-02.webm',
    category: 'Pure EN ~5s',
    expected: "Give me a quick summary of yesterday's action items.",
  },
  {
    id: '03',
    file: 'spike-03.webm',
    category: 'DE + light Anglicisms ~10s',
    expected:
      'Kannst du das Meeting von Montag zusammenfassen und mir die Action Items als Liste schicken?',
  },
  {
    id: '04',
    file: 'spike-04.webm',
    category: 'DE + tech Anglicisms ~10s',
    expected:
      'Push das Deployment auf Staging und schick mir ein Update wenn die Pipeline durch ist.',
  },
  {
    id: '05',
    file: 'spike-05.webm',
    category: 'DE + heavy code-switching ~15s',
    expected:
      'Ich brauch ein Follow-up für den Call mit dem Marketing-Team. Die wollen wissen ob wir den Launch auf nächste Woche shiften oder ob wir beim Original-Timing bleiben.',
  },
  {
    id: '06',
    file: 'spike-06.webm',
    category: 'DE + product terms ~15s',
    expected:
      'Erstell mir einen neuen Thread zum Thema Onboarding Flow. Der Setup Wizard muss vor dem Go-Live fertig sein, das ist ein Blocker für die Customer Journey.',
  },
  {
    id: '07',
    file: 'spike-07.webm',
    category: 'DE business ramble ~20s',
    expected:
      'Also ich hab mir das nochmal angeschaut mit dem Pricing. Die Starter Tier ist okay aber ich glaub wir müssen das Messaging nochmal überarbeiten. Vielleicht sollten wir A/B Testing machen auf der Landing Page, was meinst du?',
  },
  {
    id: '08',
    file: 'spike-08.webm',
    category: 'DE + names + numbers ~30s',
    expected:
      'Der Roland hat mir geschrieben, sein Dashboard zeigt seit Freitag falsche Zahlen an. Ich glaub das hängt mit dem letzten Release zusammen, Version eins Punkt null Punkt fünf. Kannst du dir mal die Logs anschauen auf dem Server? Die Instanz heisst war Punkt lynox Punkt cloud.',
  },
  {
    id: '09',
    file: 'spike-09.webm',
    category: 'DE mumbled/fast ~30s (same script as #7)',
    expected:
      'Also ich hab mir das nochmal angeschaut mit dem Pricing. Die Starter Tier ist okay aber ich glaub wir müssen das Messaging nochmal überarbeiten. Vielleicht sollten wir A/B Testing machen auf der Landing Page, was meinst du?',
  },
  {
    id: '10',
    file: 'spike-10.webm',
    category: 'Long DE mixed ~60s (free-form)',
    expected: null,
  },
];

// ── Providers ───────────────────────────────────────────────────────────────

interface RunResult {
  readonly text: string;
  readonly latencyMs: number;
}

interface ModelRunner {
  readonly key: string;          // short label: "mistral/voxtral-mini-2602"
  readonly available: boolean;   // skip if no API key
  run(audio: Buffer, filename: string, withBias: boolean): Promise<RunResult>;
}

function audioBlob(audio: Buffer): Blob {
  // Copy into a fresh ArrayBuffer — Node Buffer's ArrayBufferLike type won't
  // widen to Blob's required ArrayBuffer under TS 5.7+ strict.
  const ab = new ArrayBuffer(audio.byteLength);
  new Uint8Array(ab).set(audio);
  return new Blob([ab], { type: 'audio/webm' });
}

async function postMultipart(url: string, headers: Record<string, string>, form: FormData): Promise<{ text: string; latencyMs: number }> {
  const started = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: form });
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
  }
  const json = (await res.json()) as { text?: unknown };
  if (typeof json.text !== 'string') {
    throw new Error(`Missing "text" in response: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return { text: json.text.trim(), latencyMs };
}

function mistralRunner(model: string, apiKey: string): ModelRunner {
  return {
    key: `mistral/${model}`,
    available: true,
    async run(audio, filename, withBias) {
      const form = new FormData();
      form.append('file', audioBlob(audio), filename);
      form.append('model', model);
      form.append('language', LANGUAGE);
      if (withBias) {
        // Mistral's public docs don't advertise context_biasing yet. We pass it
        // anyway — this is the hypothesis under test. If ignored, plain and
        // biased results will be identical and that itself is a finding.
        form.append('context_biasing', JSON.stringify(BIAS_KEYWORDS));
      }
      return postMultipart(
        'https://api.mistral.ai/v1/audio/transcriptions',
        { 'x-api-key': apiKey },
        form,
      );
    },
  };
}

// ── WER + formatting helpers ────────────────────────────────────────────────

function normalize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[.,;:!?¿¡"“”„‚‘’()[\]{}<>/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? 0;
}

function wer(expected: string, got: string): number {
  const ref = normalize(expected);
  const hyp = normalize(got);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

function matchQuality(werValue: number): string {
  if (werValue === 0) return 'perfect';
  if (werValue < 0.1) return 'excellent';
  if (werValue < 0.2) return 'good';
  if (werValue < 0.35) return 'fair';
  if (werValue < 0.5) return 'poor';
  return 'broken';
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function pct(x: number | null): string {
  return x === null ? '-' : `${(x * 100).toFixed(1)}%`;
}

// ── Main ────────────────────────────────────────────────────────────────────

type Mode = 'plain' | 'biased';

interface Cell {
  readonly modelKey: string;
  readonly mode: Mode;
  readonly text: string;
  readonly latencyMs: number;
  readonly wer: number | null;
}

interface Row {
  clip: Clip;
  status: 'ok' | 'skipped' | 'error';
  cells: Cell[];
  error?: string;
}

async function main(): Promise<void> {
  const mistralKey = process.env['MISTRAL_API_KEY'];
  if (!mistralKey) {
    console.error('error: MISTRAL_API_KEY is not set.');
    console.error('Set it in your shell (e.g. `export MISTRAL_API_KEY=...`) and re-run.');
    process.exit(1);
  }

  const runners: readonly ModelRunner[] = [
    mistralRunner('voxtral-mini-2602', mistralKey),
    mistralRunner('voxtral-small-latest', mistralKey),
  ];

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(scriptDir, '..', 'tests', 'fixtures', 'voice');

  console.log(`Voxtral spike — lang=${LANGUAGE}`);
  console.log(`Fixtures: ${fixturesDir}`);
  console.log(`Models: ${runners.map((r) => r.key).join(', ')}`);
  console.log(`Bias keywords (${BIAS_KEYWORDS.length}): ${BIAS_KEYWORDS.join(', ')}`);
  console.log('');

  const rows: Row[] = [];

  for (const clip of CLIPS) {
    const path = resolve(fixturesDir, clip.file);
    const row: Row = { clip, status: 'skipped', cells: [] };

    try {
      await access(path);
    } catch {
      console.log(`[${clip.id}] skip — not found: ${path}`);
      rows.push(row);
      continue;
    }

    try {
      const audio = await readFile(path);
      console.log(`[${clip.id}] ${clip.category} — ${(audio.byteLength / 1024).toFixed(1)} KB`);

      for (const runner of runners) {
        for (const mode of ['plain', 'biased'] as const) {
          try {
            const result = await runner.run(audio, clip.file, mode === 'biased');
            const cellWer = clip.expected !== null ? wer(clip.expected, result.text) : null;
            row.cells.push({
              modelKey: runner.key,
              mode,
              text: result.text,
              latencyMs: result.latencyMs,
              wer: cellWer,
            });
            const werTag = cellWer === null ? 'free-form' : `WER ${pct(cellWer)} (${matchQuality(cellWer)})`;
            console.log(
              `  ${runner.key.padEnd(32)} ${mode.padEnd(6)} ${String(result.latencyMs).padStart(5)} ms  ${werTag}`,
            );
            console.log(`    → ${truncate(result.text, 140)}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ${runner.key.padEnd(32)} ${mode.padEnd(6)} ERROR: ${truncate(msg, 120)}`);
          }
        }
      }
      row.status = 'ok';
    } catch (err) {
      row.status = 'error';
      row.error = err instanceof Error ? err.message : String(err);
      console.log(`  error: ${row.error}`);
    }

    rows.push(row);
    console.log('');
  }

  printWerMatrix(rows, runners);
  printModelSummary(rows, runners);
  printPerClipTable(rows, runners);
}

function printWerMatrix(rows: readonly Row[], runners: readonly ModelRunner[]): void {
  console.log('── WER matrix (lower = better) ─────────────────────────────────');
  const header = ['Clip', 'Category', ...runners.flatMap((r) => [`${r.key} plain`, `${r.key} biased`])];
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const row of rows) {
    if (row.status !== 'ok') {
      console.log([row.clip.id, truncate(row.clip.category, 30), ...runners.flatMap(() => ['-', '-'])].join(' | '));
      continue;
    }
    const cols: string[] = [row.clip.id, truncate(row.clip.category, 30)];
    for (const runner of runners) {
      for (const mode of ['plain', 'biased'] as const) {
        const cell = row.cells.find((c) => c.modelKey === runner.key && c.mode === mode);
        cols.push(cell ? pct(cell.wer) : 'err');
      }
    }
    console.log(cols.join(' | '));
  }
  console.log('');
}

function printModelSummary(rows: readonly Row[], runners: readonly ModelRunner[]): void {
  console.log('── Per-model averages ──────────────────────────────────────────');
  const header = ['Model', 'Mode', 'Scored clips', 'Avg WER', 'Avg latency', 'Best', 'Worst'];
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const runner of runners) {
    for (const mode of ['plain', 'biased'] as const) {
      const cells = rows
        .flatMap((r) => r.cells)
        .filter((c) => c.modelKey === runner.key && c.mode === mode);
      const scored = cells.filter((c) => c.wer !== null);
      if (cells.length === 0) {
        console.log([runner.key, mode, '0', '-', '-', '-', '-'].join(' | '));
        continue;
      }
      const avgLatency = cells.reduce((s, c) => s + c.latencyMs, 0) / cells.length;
      if (scored.length === 0) {
        console.log([runner.key, mode, String(cells.length), 'n/a', `${avgLatency.toFixed(0)} ms`, '-', '-'].join(' | '));
        continue;
      }
      const avgWer = scored.reduce((s, c) => s + (c.wer ?? 0), 0) / scored.length;
      const best = scored.reduce((a, b) => ((a.wer ?? 1) <= (b.wer ?? 1) ? a : b));
      const worst = scored.reduce((a, b) => ((a.wer ?? 0) >= (b.wer ?? 0) ? a : b));
      console.log([
        runner.key,
        mode,
        String(scored.length),
        pct(avgWer),
        `${avgLatency.toFixed(0)} ms`,
        `#${rows.find((r) => r.cells.includes(best))?.clip.id ?? '?'} ${pct(best.wer)}`,
        `#${rows.find((r) => r.cells.includes(worst))?.clip.id ?? '?'} ${pct(worst.wer)}`,
      ].join(' | '));
    }
  }
  console.log('');
}

function printPerClipTable(rows: readonly Row[], runners: readonly ModelRunner[]): void {
  console.log('── Per-clip transcripts ────────────────────────────────────────');
  for (const row of rows) {
    if (row.status === 'skipped') {
      console.log(`[${row.clip.id}] SKIPPED — no fixture file`);
      continue;
    }
    console.log(`[${row.clip.id}] ${row.clip.category}`);
    console.log(`  expected: ${row.clip.expected ?? '(free-form)'}`);
    for (const runner of runners) {
      for (const mode of ['plain', 'biased'] as const) {
        const cell = row.cells.find((c) => c.modelKey === runner.key && c.mode === mode);
        if (!cell) continue;
        console.log(`  ${runner.key} / ${mode}: ${truncate(cell.text, 180)}`);
      }
    }
    console.log('');
  }

  const completed = rows.filter((r) => r.status === 'ok').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const errored = rows.filter((r) => r.status === 'error').length;
  console.log(`Completed: ${completed}, skipped: ${skipped}, errored: ${errored}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
