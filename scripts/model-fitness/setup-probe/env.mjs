/**
 * env — the containers of one probe run, in DELIVERY FORM.
 *
 * The engine runs from the released image with the flags of the self-host compose
 * template (`buildComposeFile` in src/cli/docker-installer.ts): read-only root,
 * tmpfs for /tmp, /workspace and the model cache, all capabilities dropped,
 * no-new-privileges, a pids limit, and one data volume. Every run gets a FRESH data
 * volume, so no state — memory, tables, threads — leaks from one run into the next.
 *
 * Fixtures that the engine must reach over the network (a mail server, a shop API)
 * run as containers on one bridge network whose subnet is a documentation range
 * (TEST-NET-3, 203.0.113.0/24). The engine's egress guard refuses loopback and the
 * private ranges without an override; the documentation ranges are not on that list,
 * which is what makes a local fixture reachable at all. `assertReachable` checks
 * that before every run — if the guard ever closes that gap, the probe must stop
 * with an instrument error instead of scoring the model for a refused request.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const NET = { name: 'setup-probe-net', subnet: '203.0.113.0/24', gateway: '203.0.113.1' };
/**
 * Fixture addresses. `SETUP_PROBE_SLOT` (0-4) shifts them by 50 per slot so that
 * several runners can share the network at once; one runner per slot.
 */
const SLOT = Number(process.env.SETUP_PROBE_SLOT ?? 0);
if (!Number.isInteger(SLOT) || SLOT < 0 || SLOT > 4) throw new Error(`SETUP_PROBE_SLOT must be 0-4, got ${process.env.SETUP_PROBE_SLOT}`);
const ip = n => `203.0.113.${n + SLOT * 50}`;
export const IPS = { engine: ip(30), shop: ip(40), mail: ip(20) };

export function docker(args, { input, allowFail = false, env } = {}) {
  const r = spawnSync('docker', args, { input, env: env ?? process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 3).join(' ')} … failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function ensureNetwork() {
  const r = docker(['network', 'inspect', NET.name], { allowFail: true });
  if (r.status === 0) return;
  docker(['network', 'create', '--subnet', NET.subnet, '--gateway', NET.gateway, NET.name]);
}

export function imageInfo(image) {
  const out = docker(['image', 'inspect', image, '--format', '{{json .}}']).stdout;
  const info = JSON.parse(out);
  const labels = info.Config?.Labels ?? {};
  return {
    image,
    digest: (info.RepoDigests ?? [])[0] ?? null,
    version: labels['org.opencontainers.image.version'] ?? null,
    revision: labels['org.opencontainers.image.revision'] ?? null,
  };
}

/**
 * Seed a fresh data volume through the engine image itself (see seed.mjs).
 * @param {string} image
 * @param {string} volume
 * @param {string} seedDir  host dir with optional `workspace/` and `collections.json`
 * @param {string} seedScript host path of seed.mjs
 */
export function seedVolume(image, volume, seedDir, seedScript) {
  return docker([
    'run', '--rm', '--network', 'none',
    '--entrypoint', 'node',
    '-v', `${volume}:/home/lynox/.lynox`,
    '-v', `${seedDir}:/seed-in:ro`,
    '-v', `${seedScript}:/seed.mjs:ro`,
    image, '/seed.mjs',
  ]).stdout.trim();
}

/**
 * Start one engine. Every variable is passed as `-e NAME` — the value travels in the
 * environment of the `docker` process, never on a command line (where `ps` would show
 * it) and never in a file (which a killed run would leave behind).
 *
 * @param {{ name: string, image: string, volume: string, env: Record<string,string>,
 *           hostPort: number, extraArgs?: string[] }} o
 */
export function startEngine(o) {
  docker([
    'run', '-d', '--name', o.name,
    '--network', NET.name, '--ip', IPS.engine,
    '--read-only',
    '--tmpfs', '/tmp:size=512M',
    '--tmpfs', '/workspace:size=256M,uid=1001,gid=1001',
    '--tmpfs', '/home/lynox/.cache:size=512M,uid=1001,gid=1001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '512',
    ...Object.keys(o.env).flatMap(k => ['-e', k]),
    '-v', `${o.volume}:/home/lynox/.lynox`,
    '-p', `127.0.0.1:${o.hostPort}:3000`,
    ...(o.extraArgs ?? []),
    o.image,
  ], { env: { ...process.env, ...o.env } });
}

export function removeContainer(name) {
  docker(['rm', '-f', name], { allowFail: true });
}

export function removeVolume(volume) {
  docker(['volume', 'rm', '-f', volume], { allowFail: true });
}

export function containerLogs(name) {
  const r = docker(['logs', name], { allowFail: true });
  return `${r.stdout}${r.stderr}`;
}

export function freshSecret() {
  return randomBytes(32).toString('hex');
}

/**
 * Can the ENGINE container reach `url`? Asked from inside the engine container with
 * the engine's own runtime, so it measures the same network path the agent's HTTP
 * tool will take (not the host's). This deliberately does NOT go through the egress
 * guard — it separates "the network is broken" from "the guard refused", and the
 * guard half is asserted by `assertGuardAdmits`.
 */
export function assertReachable(engineName, url) {
  const script = `fetch(${JSON.stringify(url)}).then(r=>{process.stdout.write(String(r.status))}).catch(e=>{process.stdout.write('ERR '+e.message);process.exitCode=1})`;
  const r = docker(['exec', engineName, 'node', '-e', script], { allowFail: true });
  if (r.status !== 0) throw new Error(`instrument: engine cannot reach ${url}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/**
 * Does the engine's egress guard admit this host? Runs the image's own
 * `assertPublicUrl` inside the engine container. A refusal here is an INSTRUMENT
 * error (the probe's fixture sits behind a guard change), never a model failure.
 */
export function assertGuardAdmits(engineName, url) {
  const script = `import('/app/dist/core/network-guard.js').then(m=>m.assertPublicUrl(${JSON.stringify(url)})).then(()=>process.stdout.write('admitted')).catch(e=>{process.stdout.write('REFUSED '+e.message);process.exitCode=1})`;
  const r = docker(['exec', engineName, 'node', '-e', script], { allowFail: true });
  if (r.status !== 0) throw new Error(`instrument: egress guard refuses ${url}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}
