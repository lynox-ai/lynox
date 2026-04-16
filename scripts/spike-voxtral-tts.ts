#!/usr/bin/env npx tsx
/**
 * Phase 0 spike: evaluate Mistral Voxtral TTS for lynox voice output.
 *
 * See pro/docs/internal/prd/voice-tts.md (Phase 0).
 *
 * Answers the 8 validation questions systematically:
 *   1. Endpoint shape — URL, request body, response Content-Type
 *   2. Voices — list endpoint if any, default voice behavior, named voice attempts
 *   3. DE quality — 5 representative German prompts, audio saved for manual review
 *   4. Latency — TTFB + full duration for 100 / 300 / 1000 / 3000 char inputs
 *   5. Streaming — stream:true flag, chunked transfer, time-to-first-audio
 *   6. Code-switching — DE + English product terms + numbers + URLs
 *   7. Billing — per-prompt character counts + any usage headers surfaced
 *   8. Rate limits — response header scrape
 *
 * Models probed (both EU-hosted, Mistral La Plateforme / Paris):
 *   - mistral/voxtral-tts-26-03   (announced 2026-03-26, pinned)
 *   - mistral/voxtral-tts-latest  (alias — behavior may differ once newer
 *                                  snapshots land)
 *
 * Requirements: MISTRAL_API_KEY. No US/China-hosted providers by policy.
 * Run: npx tsx core/scripts/spike-voxtral-tts.ts
 *
 * Audio output: tests/fixtures/voice/tts-{model}-{promptId}-{mode}.{ext}
 *   (gitignored — .webm/.wav/.mp3/.ogg are all covered by root .gitignore)
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ──────────────────────────────────────────────────────────────────

const ENDPOINT = 'https://api.mistral.ai/v1/audio/speech';
const VOICES_ENDPOINT = 'https://api.mistral.ai/v1/audio/voices';

const MODELS = ['voxtral-tts-26-03', 'voxtral-tts-latest'] as const;

interface Prompt {
  readonly id: string;
  readonly category: string;
  readonly lang: 'de' | 'en' | 'mixed';
  readonly text: string;
}

// Five prompts covering the four length buckets the PRD calls out (100 / 300 /
// 1000 / 3000 chars), plus one pure code-switching sample to stress-test how
// the model reads English product vocabulary embedded in German prose.
const PROMPTS: readonly Prompt[] = [
  {
    id: 'p100-de',
    category: '~100 chars, short DE',
    lang: 'de',
    text:
      'Fass mir die wichtigsten Punkte des heutigen Tages zusammen und schick sie mir als nummerierte Liste.',
  },
  {
    id: 'p300-de-business',
    category: '~300 chars, DE business reply',
    lang: 'de',
    text:
      'Ich habe mir den aktuellen Stand des Onboarding-Flows angeschaut. Der Setup-Wizard ist funktional, aber die Texte wirken an zwei Stellen noch unklar. Ich würde vorschlagen, dass wir die beiden Schritte nochmals gemeinsam durchgehen und dabei die Formulierungen auf verständliche Alltagssprache anpassen.',
  },
  {
    id: 'p1000-de-explainer',
    category: '~1000 chars, DE long explainer',
    lang: 'de',
    text:
      'Die Migration von der alten auf die neue Infrastruktur läuft besser als geplant. Wir haben die ersten drei Kundeninstanzen sauber umgezogen, ohne dass es zu spürbaren Ausfällen kam. Entscheidend war die atomare Umschaltung der DNS-Einträge und die vorbereitete Rollback-Strategie, für den Fall dass eine Instanz nach dem Start nicht wie erwartet reagiert. ' +
      'Für die kommende Woche stehen noch vier weitere Migrationen an. Davon sind drei technisch unkritisch, weil die Kunden sehr ähnliche Konfigurationen verwenden. Die vierte Migration ist der spannendste Kandidat, weil dort erstmals ein eigenes SMTP-Backend eingebunden werden muss und wir den Zustellpfad unter Last testen wollen. ' +
      'Parallel arbeiten wir an der Dokumentation für externe Betreiber. Ziel ist, dass jemand der die Plattform selbst hosten möchte die nötigen Schritte in weniger als einer Stunde durcharbeiten kann. Die größten offenen Fragen sind derzeit die Abhängigkeiten zu den Mail-Zustelldiensten und die Absicherung der Admin-Endpunkte.',
  },
  {
    id: 'p3000-de-longform',
    category: '~3000 chars, DE long-form narrative',
    lang: 'de',
    text:
      'Heute möchte ich einen kurzen Rückblick auf die letzten Wochen geben und daraus ableiten, was wir als Nächstes priorisieren sollten. Viele der Themen sind miteinander verbunden, deshalb lohnt es sich den Gesamtzusammenhang zu betrachten, bevor wir in die einzelnen Arbeitspakete einsteigen. ' +
      'Wir haben in den letzten vier Wochen einen klaren Fortschritt bei der Stabilität der Plattform gemacht. Die Kernkomponenten laufen verlässlich, die Betriebsdaten zeigen keine auffälligen Ausreißer mehr, und die ersten echten Nutzer arbeiten produktiv mit dem System. Das ist ein bedeutender Meilenstein, weil wir damit endgültig die Phase verlassen, in der wir primär Fehlerursachen nachverfolgen mussten. ' +
      'Gleichzeitig hat sich das Profil unserer Arbeit verschoben. Es geht weniger um das Beheben grundsätzlicher Konstruktionsschwächen, sondern zunehmend um das Schärfen von Details. Eine gute Nutzererfahrung entsteht aus vielen kleinen Entscheidungen, die für sich genommen unscheinbar wirken, sich in Summe aber stark auf das Gesamtgefühl auswirken. Genau hier sollten wir jetzt investieren. ' +
      'Ein wiederkehrender Punkt aus den Gesprächen mit ersten Kunden ist die Erwartung, dass das System sich selbst erklärt. Wenn eine Funktion nur durch Nachfragen oder das Lesen der Dokumentation zu verstehen ist, haben wir sie oft schon verloren. Das heißt nicht, dass alles trivial sein muss, aber die typischen Einstiegspfade müssen ohne Anleitung funktionieren. Wir werden daher die Hauptabläufe systematisch durchgehen und prüfen, an welchen Stellen Nutzer aktuell zögern. ' +
      'Parallel dazu arbeiten wir am Ausbau der Managed-Seite. Die technische Basis ist tragfähig, und wir können nun in Ruhe die Betriebsabläufe automatisieren, die wir bisher manuell erledigen. Das betrifft insbesondere das automatische Skalieren unserer Tenant-Hosts, das Einspielen von Aktualisierungen ohne Ausfallzeit und die Beobachtbarkeit einzelner Kundeninstanzen aus dem Kontrollsystem heraus. ' +
      'Für die kommenden vier Wochen schlage ich drei klare Schwerpunkte vor. Erstens: die Einstiegsstrecke so weit glätten, dass ein neuer Nutzer ohne Unterstützung innerhalb von zehn Minuten produktiv ist. Zweitens: den Betrieb der Managed-Plattform so weit automatisieren, dass wir die nächsten zwanzig Kunden ohne zusätzlichen Personalaufwand aufnehmen können. Drittens: eine belastbare Grundlage für Beobachtbarkeit und Fehlermeldungen schaffen, damit wir Probleme idealerweise bemerken, bevor Kunden uns darauf ansprechen. ' +
      'Wenn wir diese drei Themen sauber abschließen, haben wir eine gute Ausgangslage für den nächsten Wachstumsschritt, und wir werden uns dann in Ruhe dem Thema Partnerschaften und Integrationen zuwenden können.',
  },
  {
    id: 'p150-mixed',
    category: '~150 chars, DE + English product terms + numbers + URL',
    lang: 'mixed',
    text:
      'Schick mir ein Follow-up für den Call. Die Action Items zum Deployment von Version 1.0.5 findest du unter https://control.lynox.cloud/admin. Setup Wizard läuft grün.',
  },
];

interface RunMode {
  readonly key: string;
  readonly label: string;
  readonly body: (prompt: Prompt, model: string) => Record<string, unknown>;
}

// Modes probed per (model, prompt). Kept minimal to keep run time bounded;
// quality judgements happen on the "plain" outputs, latency curves span both.
const RUN_MODES: readonly RunMode[] = [
  {
    key: 'plain',
    label: 'plain',
    body: (p, m) => ({ model: m, input: p.text }),
  },
  {
    key: 'stream',
    label: 'stream',
    body: (p, m) => ({ model: m, input: p.text, stream: true }),
  },
];

// ── Types ───────────────────────────────────────────────────────────────────

interface RunResult {
  readonly model: string;
  readonly promptId: string;
  readonly mode: string;
  readonly status: number;
  readonly contentType: string;
  readonly contentLength: number | null;
  readonly transferEncoding: string | null;
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly bytes: number;
  readonly rateLimit: Record<string, string>;
  readonly usageHeader: string | null;
  readonly audioPath: string | null;
  readonly error: string | null;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extFromContentType(ct: string): string {
  const c = ct.toLowerCase();
  if (c.includes('mpeg') || c.includes('mp3')) return 'mp3';
  if (c.includes('wav') || c.includes('x-wav')) return 'wav';
  if (c.includes('ogg') || c.includes('opus')) return 'ogg';
  if (c.includes('flac')) return 'flac';
  if (c.includes('aac')) return 'aac';
  if (c.includes('webm')) return 'webm';
  if (c.includes('json')) return 'json';
  return 'bin';
}

function pickRateLimit(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk.includes('ratelimit') || lk === 'retry-after' || lk.startsWith('x-ratelimit')) {
      out[lk] = v;
    }
  });
  return out;
}

function truncate(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function postJson(
  apiKey: string,
  body: Record<string, unknown>,
): Promise<{ res: Response; startedMs: number }> {
  const startedMs = Date.now();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'audio/mpeg, audio/wav, audio/ogg, application/json',
    },
    body: JSON.stringify(body),
  });
  return { res, startedMs };
}

async function collectBodyWithTtfb(
  res: Response,
  startedMs: number,
): Promise<{ bytes: Uint8Array; ttfbMs: number; totalMs: number }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    const totalMs = Date.now() - startedMs;
    return { bytes: buf, ttfbMs: totalMs, totalMs };
  }
  const chunks: Uint8Array[] = [];
  let ttfbMs = -1;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (ttfbMs < 0) ttfbMs = Date.now() - startedMs;
    if (value) chunks.push(value);
  }
  const totalMs = Date.now() - startedMs;
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { bytes: merged, ttfbMs: ttfbMs < 0 ? totalMs : ttfbMs, totalMs };
}

// ── Runners ─────────────────────────────────────────────────────────────────

async function probeVoices(apiKey: string): Promise<void> {
  console.log('── Voices probe ──────────────────────────────────────────────');
  try {
    const res = await fetch(VOICES_ENDPOINT, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const body = await res.text();
    console.log(`GET ${VOICES_ENDPOINT} → ${res.status} ${res.statusText}`);
    console.log(`  body: ${truncate(body, 500)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`GET ${VOICES_ENDPOINT} → exception: ${truncate(msg, 200)}`);
  }
  console.log('');
}

async function runOnce(
  apiKey: string,
  model: string,
  prompt: Prompt,
  mode: RunMode,
  outDir: string,
): Promise<RunResult> {
  const body = mode.body(prompt, model);
  let res: Response;
  let startedMs: number;
  try {
    const out = await postJson(apiKey, body);
    res = out.res;
    startedMs = out.startedMs;
  } catch (err) {
    return {
      model,
      promptId: prompt.id,
      mode: mode.key,
      status: 0,
      contentType: '',
      contentLength: null,
      transferEncoding: null,
      ttfbMs: 0,
      totalMs: 0,
      bytes: 0,
      rateLimit: {},
      usageHeader: null,
      audioPath: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const contentType = res.headers.get('content-type') ?? '';
  const contentLengthStr = res.headers.get('content-length');
  const transferEncoding = res.headers.get('transfer-encoding');
  const rateLimit = pickRateLimit(res.headers);
  const usageHeader = res.headers.get('x-usage') ?? res.headers.get('openai-processing-ms');

  if (!res.ok) {
    const text = await res.text();
    return {
      model,
      promptId: prompt.id,
      mode: mode.key,
      status: res.status,
      contentType,
      contentLength: contentLengthStr !== null ? Number(contentLengthStr) : null,
      transferEncoding,
      ttfbMs: Date.now() - startedMs,
      totalMs: Date.now() - startedMs,
      bytes: 0,
      rateLimit,
      usageHeader,
      audioPath: null,
      error: truncate(text, 400),
    };
  }

  const { bytes, ttfbMs, totalMs } = await collectBodyWithTtfb(res, startedMs);

  const ext = extFromContentType(contentType);
  const filename = `tts-${model}-${prompt.id}-${mode.key}.${ext}`;
  const audioPath = resolve(outDir, filename);
  await writeFile(audioPath, bytes);

  return {
    model,
    promptId: prompt.id,
    mode: mode.key,
    status: res.status,
    contentType,
    contentLength: contentLengthStr !== null ? Number(contentLengthStr) : null,
    transferEncoding,
    ttfbMs,
    totalMs,
    bytes: bytes.byteLength,
    rateLimit,
    usageHeader,
    audioPath,
    error: null,
  };
}

function printRun(r: RunResult, prompt: Prompt): void {
  const tag = r.error ? `ERROR ${r.status}` : `${r.status} ${r.contentType}`;
  const chars = prompt.text.length;
  console.log(
    `  ${pad(r.model, 22)} ${pad(r.mode, 6)} chars=${pad(String(chars), 5)} ttfb=${pad(
      String(r.ttfbMs),
      5,
    )}ms total=${pad(String(r.totalMs), 5)}ms bytes=${pad(String(r.bytes), 7)} ${tag}`,
  );
  if (r.transferEncoding) console.log(`    transfer-encoding: ${r.transferEncoding}`);
  if (r.usageHeader) console.log(`    usage header: ${r.usageHeader}`);
  if (Object.keys(r.rateLimit).length > 0) {
    console.log(`    rate-limit: ${JSON.stringify(r.rateLimit)}`);
  }
  if (r.audioPath) console.log(`    → ${r.audioPath}`);
  if (r.error) console.log(`    error: ${r.error}`);
}

async function main(): Promise<void> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) {
    console.error('error: MISTRAL_API_KEY is not set.');
    console.error('Export it in your shell and re-run: export MISTRAL_API_KEY=...');
    process.exit(1);
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(scriptDir, '..', 'tests', 'fixtures', 'voice');
  await mkdir(outDir, { recursive: true });

  console.log(`Voxtral TTS spike`);
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log(`Models:   ${MODELS.join(', ')}`);
  console.log(`Prompts:  ${PROMPTS.map((p) => `${p.id}(${p.text.length}c)`).join(', ')}`);
  console.log(`Out dir:  ${outDir}  (gitignored)`);
  console.log('');

  await probeVoices(apiKey);

  const results: RunResult[] = [];

  for (const prompt of PROMPTS) {
    console.log(`[${prompt.id}] ${prompt.category} — ${prompt.text.length} chars, lang=${prompt.lang}`);
    console.log(`  "${truncate(prompt.text, 110)}"`);
    for (const model of MODELS) {
      for (const mode of RUN_MODES) {
        const r = await runOnce(apiKey, model, prompt, mode, outDir);
        results.push(r);
        printRun(r, prompt);
      }
    }
    console.log('');
  }

  printSummary(results);
}

function printSummary(results: readonly RunResult[]): void {
  console.log('── Latency matrix (ms) ───────────────────────────────────────');
  const header = ['Prompt', 'Chars', ...MODELS.flatMap((m) => RUN_MODES.map((x) => `${m}/${x.key}`))];
  console.log(header.join(' | '));
  console.log(header.map(() => '---').join(' | '));
  for (const prompt of PROMPTS) {
    const cols: string[] = [prompt.id, String(prompt.text.length)];
    for (const model of MODELS) {
      for (const mode of RUN_MODES) {
        const r = results.find(
          (x) => x.model === model && x.promptId === prompt.id && x.mode === mode.key,
        );
        if (!r) cols.push('-');
        else if (r.error) cols.push('err');
        else cols.push(`${r.ttfbMs}/${r.totalMs}`);
      }
    }
    console.log(cols.join(' | '));
  }
  console.log('  (cells: ttfb/total in ms, "err" = HTTP error)');
  console.log('');

  console.log('── Audio output (Content-Type + size) ────────────────────────');
  for (const r of results) {
    if (r.error) continue;
    console.log(
      `  ${pad(r.promptId, 20)} ${pad(r.model, 22)} ${pad(r.mode, 6)}  ${pad(
        r.contentType,
        24,
      )}  ${pad(String(r.bytes), 8)} bytes  ${r.audioPath ?? ''}`,
    );
  }
  console.log('');

  console.log('── Errors ────────────────────────────────────────────────────');
  const errs = results.filter((r) => r.error !== null);
  if (errs.length === 0) {
    console.log('  none');
  } else {
    for (const r of errs) {
      console.log(`  ${r.model} / ${r.promptId} / ${r.mode}: [${r.status}] ${r.error}`);
    }
  }
  console.log('');

  const billingHint = results.find((r) => r.usageHeader !== null);
  console.log('── Billing hints ─────────────────────────────────────────────');
  if (billingHint) {
    console.log(`  usage header seen: ${billingHint.usageHeader}`);
  } else {
    console.log('  no explicit usage header — billing inferred from prompt char count.');
  }
  console.log('');

  const ok = results.filter((r) => r.error === null).length;
  const errored = results.length - ok;
  console.log(`Done. ${ok} ok, ${errored} errored across ${results.length} runs.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
