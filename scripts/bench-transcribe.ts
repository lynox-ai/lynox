#!/usr/bin/env npx tsx
/**
 * Phase 1 benchmark harness: latency + WER per provider on the Phase 0
 * reference set. Establishes the whisper.cpp baseline referenced by the
 * "halve German WER" success metric in the PRD.
 *
 * Usage:
 *   npx tsx scripts/bench-transcribe.ts                        # all providers
 *   npx tsx scripts/bench-transcribe.ts --provider whisper     # whisper only
 *   npx tsx scripts/bench-transcribe.ts --provider mistral     # mistral only
 *   npx tsx scripts/bench-transcribe.ts --glossary off         # skip post-process
 *
 * Fixtures live at tests/fixtures/voice/spike-{01..10}.webm (gitignored —
 * voice recordings stay out of the public repo).
 */
import { access, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeMistralVoxtral } from '../src/core/transcribe/mistral-voxtral.js';
import { transcribeWhisperCpp, hasWhisperCpp } from '../src/core/transcribe/whisper-cpp.js';
import { applyGlossary } from '../src/core/transcribe/glossary/apply.js';
import { CORE_GLOSSARY } from '../src/core/transcribe/glossary/core-terms.js';

interface Clip {
  readonly id: string;
  readonly file: string;
  readonly category: string;
  readonly expected: string | null;
}

const CLIPS: readonly Clip[] = [
  { id: '01', file: 'spike-01.webm', category: 'Pure DE ~5s',
    expected: 'Fass mir bitte die wichtigsten Punkte von heute zusammen.' },
  { id: '02', file: 'spike-02.webm', category: 'Pure EN ~5s',
    expected: "Give me a quick summary of yesterday's action items." },
  { id: '03', file: 'spike-03.webm', category: 'DE + light Anglicisms ~10s',
    expected: 'Kannst du das Meeting von Montag zusammenfassen und mir die Action Items als Liste schicken?' },
  { id: '04', file: 'spike-04.webm', category: 'DE + tech Anglicisms ~10s',
    expected: 'Push das Deployment auf Staging und schick mir ein Update wenn die Pipeline durch ist.' },
  { id: '05', file: 'spike-05.webm', category: 'DE + heavy code-switching ~15s',
    expected: 'Ich brauch ein Follow-up für den Call mit dem Marketing-Team. Die wollen wissen ob wir den Launch auf nächste Woche shiften oder ob wir beim Original-Timing bleiben.' },
  { id: '06', file: 'spike-06.webm', category: 'DE + product terms ~15s',
    expected: 'Erstell mir einen neuen Thread zum Thema Onboarding Flow. Der Setup Wizard muss vor dem Go-Live fertig sein, das ist ein Blocker für die Customer Journey.' },
  { id: '07', file: 'spike-07.webm', category: 'DE business ramble ~20s',
    expected: 'Also ich hab mir das nochmal angeschaut mit dem Pricing. Die Starter Tier ist okay aber ich glaub wir müssen das Messaging nochmal überarbeiten. Vielleicht sollten wir A/B Testing machen auf der Landing Page, was meinst du?' },
  { id: '08', file: 'spike-08.webm', category: 'DE + names + numbers ~30s',
    expected: 'Der Roland hat mir geschrieben, sein Dashboard zeigt seit Freitag falsche Zahlen an. Ich glaub das hängt mit dem letzten Release zusammen, Version eins Punkt null Punkt fünf. Kannst du dir mal die Logs anschauen auf dem Server? Die Instanz heisst war Punkt lynox Punkt cloud.' },
  { id: '09', file: 'spike-09.webm', category: 'DE mumbled/fast ~30s',
    expected: 'Also ich hab mir das nochmal angeschaut mit dem Pricing. Die Starter Tier ist okay aber ich glaub wir müssen das Messaging nochmal überarbeiten. Vielleicht sollten wir A/B Testing machen auf der Landing Page, was meinst du?' },
  { id: '10', file: 'spike-10.webm', category: 'Long DE mixed ~60s (free-form)',
    expected: null },
];

function normalize(s: string): string[] {
  return s.toLowerCase()
    .replace(/[.,;:!?¿¡"“”„‚‘’()[\]{}<>/\\]/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const prev = new Array<number>(n + 1), curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? 0;
}

function wer(expected: string, got: string): number {
  const ref = normalize(expected), hyp = normalize(got);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return levenshtein(ref, hyp) / ref.length;
}

function pct(x: number | null): string { return x === null ? '-' : `${(x * 100).toFixed(1)}%`; }
function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

type Provider = 'whisper' | 'mistral';

interface Cell { provider: Provider; raw: string; applied: string; latencyMs: number; werRaw: number | null; werApplied: number | null }

interface Row { clip: Clip; status: 'ok' | 'skipped' | 'error'; cells: Cell[]; error?: string }

async function runProvider(provider: Provider, audio: Buffer, clip: Clip, applyGloss: boolean): Promise<Cell | null> {
  const t0 = Date.now();
  let raw: string | null;
  try {
    if (provider === 'whisper') {
      raw = await transcribeWhisperCpp(audio, clip.file, 'de');
    } else {
      raw = await transcribeMistralVoxtral(audio, clip.file, 'de');
    }
  } catch (err) {
    process.stderr.write(`  ${provider} ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
    return null;
  }
  const latencyMs = Date.now() - t0;
  if (!raw) return null;

  const applied = applyGloss ? applyGlossary(raw, CORE_GLOSSARY) : raw;
  const werRaw = clip.expected !== null ? wer(clip.expected, raw) : null;
  const werApplied = clip.expected !== null ? wer(clip.expected, applied) : null;
  return { provider, raw, applied, latencyMs, werRaw, werApplied };
}

function parseArgs(): { providers: Provider[]; glossary: boolean } {
  const args = process.argv.slice(2);
  let providers: Provider[] = ['whisper', 'mistral'];
  let glossary = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      const v = args[i + 1];
      providers = v === 'all' ? ['whisper', 'mistral'] : [v as Provider];
      i++;
    } else if (args[i] === '--glossary' && args[i + 1]) {
      glossary = args[i + 1] !== 'off';
      i++;
    }
  }
  return { providers, glossary };
}

async function main(): Promise<void> {
  const { providers, glossary } = parseArgs();

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixturesDir = resolve(scriptDir, '..', 'tests', 'fixtures', 'voice');

  const effective: Provider[] = [];
  if (providers.includes('whisper')) {
    if (hasWhisperCpp()) effective.push('whisper');
    else process.stderr.write('whisper.cpp not found — skipping whisper provider\n');
  }
  if (providers.includes('mistral')) {
    if (process.env['MISTRAL_API_KEY']) effective.push('mistral');
    else process.stderr.write('MISTRAL_API_KEY not set — skipping mistral provider\n');
  }
  if (effective.length === 0) {
    process.stderr.write('No providers available. Exiting.\n');
    process.exit(1);
  }

  process.stderr.write(`bench-transcribe — providers=${effective.join(',')} glossary=${glossary ? 'on' : 'off'}\n`);
  process.stderr.write(`fixtures: ${fixturesDir}\n\n`);

  const rows: Row[] = [];
  for (const clip of CLIPS) {
    const path = resolve(fixturesDir, clip.file);
    const row: Row = { clip, status: 'skipped', cells: [] };
    try { await access(path); } catch {
      process.stderr.write(`[${clip.id}] skip (missing ${clip.file})\n`);
      rows.push(row); continue;
    }
    const audio = await readFile(path);
    process.stderr.write(`[${clip.id}] ${clip.category} — ${(audio.byteLength / 1024).toFixed(1)} KB\n`);
    for (const p of effective) {
      const cell = await runProvider(p, audio, clip, glossary);
      if (cell) {
        row.cells.push(cell);
        const tag = cell.werRaw === null ? 'free-form' : `WER raw=${pct(cell.werRaw)} applied=${pct(cell.werApplied)}`;
        process.stderr.write(`  ${p.padEnd(8)} ${String(cell.latencyMs).padStart(6)} ms  ${tag}\n`);
        process.stderr.write(`    raw: ${truncate(cell.raw, 140)}\n`);
        if (glossary && cell.raw !== cell.applied) {
          process.stderr.write(`    +gl: ${truncate(cell.applied, 140)}\n`);
        }
      }
    }
    row.status = 'ok';
    rows.push(row);
  }

  process.stderr.write('\n── Summary ──\n');
  for (const p of effective) {
    const cells = rows.flatMap(r => r.cells).filter(c => c.provider === p);
    const scored = cells.filter(c => c.werApplied !== null);
    if (cells.length === 0) continue;
    const avgLatency = cells.reduce((s, c) => s + c.latencyMs, 0) / cells.length;
    const avgWerRaw = scored.length > 0 ? scored.reduce((s, c) => s + (c.werRaw ?? 0), 0) / scored.length : null;
    const avgWerApplied = scored.length > 0 ? scored.reduce((s, c) => s + (c.werApplied ?? 0), 0) / scored.length : null;
    process.stderr.write(
      `${p.padEnd(8)}  avg latency ${avgLatency.toFixed(0).padStart(5)} ms  ` +
      `avg WER raw ${pct(avgWerRaw).padStart(6)}  applied ${pct(avgWerApplied).padStart(6)}  ` +
      `(n=${scored.length})\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
