#!/usr/bin/env node
/**
 * setup-probe — does a configured model CARRY lynox's set-up flows?
 *
 * Runs each flow n times on a fresh engine in delivery form (see env.mjs) and judges
 * every run on the END STATE it leaves behind — rows in a table, requests at a shop
 * API, mail at a mail server — never on the model's own account of what it did.
 * A safety violation (a wrong number written, a write without the preview the task
 * demanded, mail sent without approval) is reported per run and never averaged into
 * a pass rate.
 *
 * Provider-neutral: the endpoint, model and prices are parameters. Secrets are read
 * from files (`--key-file`), never from argv.
 *
 *   node scripts/model-fitness/setup-probe/run.mjs --flow b --n 3 \
 *     --provider openai --base-url https://<host>/v1 --model <id> --key-file <path> \
 *     --accept-endpoint --price-in 0.20 --price-out 0.75 --currency CHF \
 *     --image ghcr.io/lynox-ai/lynox@sha256:<digest> --label <name> --out <dir>
 *
 *   node scripts/model-fitness/setup-probe/run.mjs --flow b --n 3 \
 *     --provider anthropic --key-file <path> \
 *     --price-in 3 --price-out 15 --price-cache-read 0.3 --price-cache-write 3.75 --currency USD \
 *     --image … --label control --out <dir>
 *
 * `--accept-endpoint` sets LYNOX_CUSTOM_ENDPOINT_ACCEPTED=true: an engine pointed at an
 * endpoint outside its vetted list refuses to boot without it (endpoint-allowlist.ts).
 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, appendFileSync, chmodSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { EngineClient, runUsage } from './engine-client.mjs';
import * as env from './env.mjs';
import { cost } from './accounting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const FLOWS = {
  a: () => import('./flows/a-inbox.mjs'),
  b: () => import('./flows/b-invoices.mjs'),
  c: () => import('./flows/c-shop.mjs'),
};

const { values: opt } = parseArgs({
  options: {
    flow: { type: 'string' },
    n: { type: 'string', default: '1' },
    provider: { type: 'string' },
    'base-url': { type: 'string' },
    model: { type: 'string' },
    'key-file': { type: 'string' },
    'accept-endpoint': { type: 'boolean', default: false },
    'price-in': { type: 'string' },
    'price-out': { type: 'string' },
    'price-cache-read': { type: 'string' },
    'price-cache-write': { type: 'string' },
    currency: { type: 'string', default: 'USD' },
    image: { type: 'string', default: 'ghcr.io/lynox-ai/lynox:latest' },
    label: { type: 'string' },
    out: { type: 'string' },
    // The only host port the probe binds (127.0.0.1). Not 13100: that is the fixed port
    // of src/server/http-api.test.ts, and a probe engine there answered that suite's
    // requests. Fixture services bind no host port.
    port: { type: 'string', default: '47310' },
    // Keep the containers and volume of the first run that does not pass, and stop there
    // (they hold the slot's fixed addresses, so no further run could start).
    'keep-failed': { type: 'boolean', default: false },
  },
});

function need(name) {
  const v = opt[name];
  if (v === undefined || v === '') { console.error(`missing --${name}`); process.exit(2); }
  return v;
}

const flowKey = need('flow');
if (!FLOWS[flowKey]) { console.error(`unknown --flow ${flowKey} (a|b|c)`); process.exit(2); }
const provider = need('provider');
const label = need('label');
const outDir = need('out');
const n = Number(opt.n);
if (!Number.isInteger(n) || n < 1) { console.error(`--n must be a positive integer, got ${opt.n}`); process.exit(2); }
const key = readFileSync(need('key-file'), 'utf8').trim();
const prices = {
  in: Number(need('price-in')),
  out: Number(need('price-out')),
  cacheRead: opt['price-cache-read'] !== undefined ? Number(opt['price-cache-read']) : null,
  cacheWrite: opt['price-cache-write'] !== undefined ? Number(opt['price-cache-write']) : null,
  currency: opt.currency,
};

function providerEnv() {
  if (provider === 'anthropic') {
    // The engine picks its own Anthropic model; a --model here would be silently ignored.
    if (opt.model) { console.error('--model is not supported with --provider anthropic'); process.exit(2); }
    return { ANTHROPIC_API_KEY: key };
  }
  if (provider === 'openai') {
    return {
      LYNOX_LLM_PROVIDER: 'openai',
      // The installer writes the base URL under this (legacy) name for both the
      // Mistral and the custom path; the probe configures the engine the same way.
      ANTHROPIC_BASE_URL: need('base-url'),
      OPENAI_MODEL_ID: need('model'),
      OPENAI_API_KEY: key,
      ...(opt['accept-endpoint'] ? { LYNOX_CUSTOM_ENDPOINT_ACCEPTED: 'true' } : {}),
    };
  }
  console.error(`unknown --provider ${provider} (anthropic|openai)`); process.exit(2);
}

/** Refuse to start when the host port is taken — never answer someone else's client. */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', e => reject(new Error(`instrument: host port ${port} is in use (${e.code}); pass --port`)));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
  });
}

function chmodRecursive(dir) {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) chmodRecursive(p);
    else chmodSync(p, 0o644);
  }
}

let kept = false;

async function oneRun(flow, i, image) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${label}-${flowKey}-${String(i).padStart(2, '0')}-${stamp}`;
  const tag = `${process.pid}-${i}`;
  const name = `setup-probe-engine-${tag}`;
  const volume = `setup-probe-${runId}`.toLowerCase();
  const runDir = join(outDir, runId);
  mkdirSync(runDir, { recursive: true });
  const secret = env.freshSecret();
  const ctx = { runId, runDir, tag, name, volume, env, image, flowKey, label };
  const seedDir = mkdtempSync(join(process.env.SETUP_PROBE_TMP ?? tmpdir(), 'setup-probe-seed-'));
  let result;
  try {
    // 1. data volume, seeded through the image itself
    env.docker(['volume', 'create', volume]);
    if (flow.files) {
      for (const [rel, body] of Object.entries(flow.files())) {
        const p = join(seedDir, 'workspace', rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, body);
      }
    }
    if (flow.COLLECTIONS) writeFileSync(join(seedDir, 'collections.json'), JSON.stringify(flow.COLLECTIONS));
    // mkdtemp creates 0700. Under rootless Docker the host user is the container's
    // root, and the engine user must still read the seed — otherwise seeding sees
    // an empty directory (the silent failure seed.mjs now refuses).
    chmodRecursive(seedDir);
    const seeded = JSON.parse(env.seedVolume(image, volume, seedDir, join(HERE, 'seed.mjs')).split('\n').pop());
    const wantFiles = flow.files ? Object.keys(flow.files()).length : 0;
    const wantCollections = (flow.COLLECTIONS ?? []).map(c => c.name).sort();
    if (seeded.files !== wantFiles || JSON.stringify(seeded.collections) !== JSON.stringify(wantCollections)) {
      throw new Error(`instrument: seeding produced ${JSON.stringify(seeded)}, expected ${wantFiles} files and collections ${JSON.stringify(wantCollections)}`);
    }
    ctx.seeded = seeded;

    // 2. fixture services (mail server, shop API) before the engine, so the engine
    //    finds them on first use
    if (flow.startServices) await flow.startServices(ctx);

    // 3. the engine — on a host port nothing else holds, or not at all
    env.removeContainer(name);
    await assertPortFree(Number(opt.port));
    env.startEngine({
      name, image, volume, hostPort: Number(opt.port),
      env: { ...providerEnv(), LYNOX_HTTP_SECRET: secret, LYNOX_VAULT_KEY: env.freshSecret(), ORIGIN: 'http://localhost:3000' },
      extraArgs: flow.engineArgs ? flow.engineArgs(ctx) : [],
    });
    const client = new EngineClient({ base: `http://127.0.0.1:${opt.port}`, token: secret });
    ctx.client = client;
    if (!(await client.waitHealthy())) throw new Error(`instrument: engine not healthy\n${env.containerLogs(name).slice(-2000)}`);

    // 4. flow-specific preparation that needs the running engine (reachability checks,
    //    an account added through the API)
    if (flow.prepare) await flow.prepare(ctx);

    // 5. drive + judge
    const t0 = Date.now();
    const { records, end } = await flow.drive(ctx);
    const verdict = flow.check(end, ctx);
    const usage = records.map(runUsage).reduce((a, u) => ({
      tokensIn: a.tokensIn + u.tokensIn, tokensOut: a.tokensOut + u.tokensOut,
      cacheRead: a.cacheRead + u.cacheRead, cacheWrite: a.cacheWrite + u.cacheWrite,
      model: a.model ?? u.model, engineCostUsd: a.engineCostUsd + u.engineCostUsd,
    }), { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, model: null, engineCostUsd: 0 });
    const exported = [];
    for (const sid of new Set(records.map(r => r.sessionId))) exported.push(await client.debugExport(sid));
    writeFileSync(join(runDir, 'records.json'), JSON.stringify(records, null, 1));
    writeFileSync(join(runDir, 'end-state.json'), JSON.stringify(end, null, 1));
    writeFileSync(join(runDir, 'debug-export.json'), JSON.stringify(exported, null, 1));
    writeFileSync(join(runDir, 'engine.log'), env.containerLogs(name));
    result = {
      runId, flow: flowKey, label, i, image: env.imageInfo(image),
      servedModel: usage.model,
      pass: verdict.pass, safety: verdict.safety, problems: verdict.problems, detail: verdict.detail ?? null,
      usage, cost: Number(cost(usage, prices).toFixed(4)), currency: prices.currency,
      durationMs: Date.now() - t0,
      steps: records.reduce((s, r) => s + r.turns.length, 0),
      toolCalls: records.flatMap(r => r.toolCalls.map(c => c.name)),
      toolErrors: records.flatMap(r => r.toolResults.filter(x => x.isError).map(x => x.name)),
      prompts: records.flatMap(r => r.prompts.map(p => ({ q: p.question.slice(0, 160), a: p.answer }))),
      emptyFinal: records.some(r => !r.done || r.done.result.trim() === ''),
      timedOut: records.some(r => r.timedOut),
      runErrors: records.map(r => r.error).filter(Boolean),
      finalText: records.map(r => r.done?.result ?? '').join('\n---\n').slice(0, 2000),
    };
  } catch (err) {
    result = { runId, flow: flowKey, label, i, instrumentError: String(err instanceof Error ? err.message : err) };
    try { writeFileSync(join(runDir, 'engine.log'), env.containerLogs(name)); } catch { /* none */ }
  } finally {
    rmSync(seedDir, { recursive: true, force: true });
    kept = opt['keep-failed'] && !(result?.pass);
    if (!kept) {
      env.removeContainer(name);
      if (flow.stopServices) await flow.stopServices(ctx);
      env.removeVolume(volume);
    }
  }
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 1));
  appendFileSync(join(outDir, 'results.jsonl'), JSON.stringify(result) + '\n');
  return result;
}

// Validate the provider settings once, before any container exists: a refusal inside a
// run would exit past its cleanup and leave the slot's fixed addresses taken.
providerEnv();

const flow = await FLOWS[flowKey]();
mkdirSync(outDir, { recursive: true });
env.ensureNetwork();
for (let i = 1; i <= n; i++) {
  const r = await oneRun(flow, i, opt.image);
  const line = r.instrumentError
    ? `#${i} INSTRUMENT ERROR: ${r.instrumentError.slice(0, 300)}`
    : `#${i} ${r.pass ? 'PASS' : 'FAIL'}${r.safety.length ? ` SAFETY(${r.safety.length})` : ''} steps=${r.steps} in=${r.usage.tokensIn} out=${r.usage.tokensOut} cost=${r.cost} ${r.currency} ${Math.round(r.durationMs / 1000)}s model=${r.servedModel}${r.problems.length ? `\n   - ${r.problems.slice(0, 6).join('\n   - ')}` : ''}`;
  console.log(line);
  if (kept) { console.log(`kept the containers and volume of run #${i} for inspection; stopping.`); break; }
}
