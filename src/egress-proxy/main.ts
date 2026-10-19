/**
 * Entry point of the egress proxy: `node /app/dist/egress-proxy/main.js` in the lynox image,
 * as its own service next to the engine (PRD 152 v2 §4.2).
 *
 * Each listener binds to the address of one interface, never to all of them: the shell
 * listener to `shell0` (the internal network the sidecar sits on), the registration
 * listener to `admin0` (the network the engine sits on). The compose template names the
 * interfaces per network. If either interface is missing the proxy does not start, so a
 * wiring mistake leaves the sidecar with no way out rather than with the registration port.
 */

import { networkInterfaces } from 'node:os';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { CredentialRegistry } from './registry.js';
import { parseDenyIps } from './policy.js';
import { ShellProxy, createAdminServer } from './server.js';

export const SHELL_INTERFACE = 'shell0';
export const ADMIN_INTERFACE = 'admin0';
export const SHELL_PORT = 3128;
export const ADMIN_PORT = 3129;
/** The registration secret is generated per tenant; anything this short is a wiring mistake. */
export const MIN_SECRET_LENGTH = 32;

export type InterfaceTable = ReturnType<typeof networkInterfaces>;

/** The single IPv4 address of an interface; a missing interface or address is a startup error. */
export function interfaceAddress(table: InterfaceTable, name: string): string {
  const v4 = (table[name] ?? []).filter((a) => a.family === 'IPv4' && !a.internal);
  if (v4.length !== 1) throw new Error(`interface ${name} must have exactly one IPv4 address (found ${String(v4.length)})`);
  return v4[0]!.address;
}

export function secretFromEnv(raw: string | undefined): string {
  if (raw === undefined || raw.length < MIN_SECRET_LENGTH) {
    throw new Error(`LYNOX_EGRESS_PROXY_SECRET must be set, at least ${String(MIN_SECRET_LENGTH)} characters`);
  }
  return raw;
}

const log = (line: string): void => { process.stderr.write(`[egress-proxy] ${line}\n`); };

export async function main(): Promise<void> {
  const secret = secretFromEnv(process.env['LYNOX_EGRESS_PROXY_SECRET']);
  const deny = parseDenyIps(process.env['LYNOX_EGRESS_PROXY_DENY_IPS']);
  const table = networkInterfaces();
  const shellIp = interfaceAddress(table, SHELL_INTERFACE);
  const adminIp = interfaceAddress(table, ADMIN_INTERFACE);

  const registry = new CredentialRegistry();
  const shell = new ShellProxy({
    registry,
    deny,
    lookup: async (host) => (await lookup(host, { all: true, family: 4 })).map((a) => a.address),
    connect: (ip, port) => connect({ host: ip, port }),
    log,
  });
  const admin = createAdminServer({ registry, secret, log });
  setInterval(() => { registry.sweep(); }, 1000).unref();

  await new Promise<void>((resolve, reject) => { shell.server.once('error', reject).listen(SHELL_PORT, shellIp, resolve); });
  await new Promise<void>((resolve, reject) => { admin.once('error', reject).listen(ADMIN_PORT, adminIp, resolve); });
  log(`listening shell=${shellIp}:${String(SHELL_PORT)} admin=${adminIp}:${String(ADMIN_PORT)} deny=${String(deny.size)}`);
}

if (process.argv[1] && /egress-proxy\/main\.js$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`[egress-proxy] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
