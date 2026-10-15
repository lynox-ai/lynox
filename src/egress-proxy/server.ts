/**
 * The two listeners of the egress proxy (PRD 152 v2 §4.2).
 *
 * The shell listener takes `CONNECT host:443` from the shell sidecar, which has no other
 * route out, and then reads the TLS client hello before it forwards a byte (policy.ts says
 * why). The registration listener takes the engine's `PUT /cred`, `DELETE /cred` and
 * `GET /denials`. main.ts binds each to its own network, so the sidecar cannot reach the
 * second one at all; the Bearer secret is the second layer.
 *
 * Resolution and connection come in as dependencies, so the tests can show that a name
 * outside the set reaches no resolver and that the connection goes to the checked address.
 */

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { hostInSet, type CredentialRegistry, type TunnelHandle } from './registry.js';
import { ALLOWED_PORTS, credentialFromHeader, isCredential, parseAuthority, parseClientHello, parseRegistration, pickAddress } from './policy.js';

export interface ProxyLimits {
  /** Request head of the shell side, request line and headers. */
  maxHeaderBytes: number;
  /** For the request head, and again for the TLS client hello. */
  headerTimeoutMs: number;
  connectTimeoutMs: number;
  /** A tunnel with no bytes either way for this long is closed. */
  idleTimeoutMs: number;
  /** Tunnels open or being opened (resolving, connecting, reading the hello). */
  tunnelsPerCred: number;
  tunnelsTotal: number;
  /** Connections to the shell listener at once, authenticated or not. */
  connectionsTotal: number;
  /** Body of a registration request. */
  maxBodyBytes: number;
}

export const DEFAULT_LIMITS: ProxyLimits = {
  maxHeaderBytes: 16 * 1024,
  headerTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 120_000,
  tunnelsPerCred: 32,
  tunnelsTotal: 256,
  connectionsTotal: 512,
  maxBodyBytes: 64 * 1024,
};

export interface ShellDeps {
  registry: CredentialRegistry;
  deny: ReadonlySet<string>;
  /** IPv4 addresses of a host name. Called only for a name the credential's set allows. */
  lookup(host: string): Promise<string[]>;
  /** Open a TCP connection to exactly this address. */
  connect(ip: string, port: number): Socket;
  log(line: string): void;
  limits?: Partial<ProxyLimits>;
}

/** Logs carry a short hash of the credential, never the credential. */
export function credTag(cred: string): string {
  return createHash('sha256').update(cred).digest('hex').slice(0, 12);
}

const REASONS: Record<number, string> = {
  400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 407: 'Proxy Authentication Required',
  431: 'Request Header Fields Too Large', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const AUTHENTICATE = 'Proxy-Authenticate: Basic realm="lynox-egress"\r\n';
/** How much of a refused target a denial keeps. */
const MAX_DENIED_HOST_CHARS = 255;

function reply(socket: Socket, code: number, extra = ''): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${String(code)} ${REASONS[code] ?? ''}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

interface RequestHead {
  method: string;
  target: string;
  proxyAuthorization: string | undefined;
}

function parseHead(head: string): RequestHead | null {
  const lines = head.split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  if (!m) return null;
  let proxyAuthorization: string | undefined;
  for (const line of lines.slice(1)) {
    const c = line.indexOf(':');
    if (c <= 0) return null;
    if (line.slice(0, c).trim().toLowerCase() === 'proxy-authorization') {
      if (proxyAuthorization !== undefined) return null;
      proxyAuthorization = line.slice(c + 1).trim();
    }
  }
  return { method: m[1]!, target: m[2]!, proxyAuthorization };
}

export class ShellProxy {
  readonly server: NetServer;
  private readonly limits: ProxyLimits;
  /** Tunnels open or being opened, all credentials. */
  private open = 0;
  /** Tunnels being opened per credential, before the registry holds them. */
  private readonly opening = new Map<string, number>();

  constructor(private readonly deps: ShellDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.server = createNetServer((socket) => { this.accept(socket); });
    this.server.maxConnections = this.limits.connectionsTotal;
  }

  get openTunnels(): number {
    return this.open;
  }

  private accept(socket: Socket): void {
    let buf = Buffer.alloc(0);
    socket.on('error', () => { /* the client went away; nothing to report */ });
    const deadline = setTimeout(() => { socket.destroy(); }, this.limits.headerTimeoutMs);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buf.length > this.limits.maxHeaderBytes) { clearTimeout(deadline); socket.off('data', onData); reply(socket, 431); }
        return;
      }
      if (end > this.limits.maxHeaderBytes) { clearTimeout(deadline); socket.off('data', onData); reply(socket, 431); return; }
      clearTimeout(deadline);
      socket.off('data', onData);
      socket.pause();
      const head = buf.subarray(0, end).toString('latin1');
      const rest = buf.subarray(end + 4);
      void this.handle(socket, head, rest);
    };
    socket.on('data', onData);
    socket.on('close', () => { clearTimeout(deadline); });
  }

  private async handle(socket: Socket, rawHead: string, rest: Buffer): Promise<void> {
    const req = parseHead(rawHead);
    if (req === null) { reply(socket, 400); return; }

    // 1. The credential, before anything about the request is looked at.
    const cred = credentialFromHeader(req.proxyAuthorization);
    const entry = cred === null ? null : this.deps.registry.lookup(cred);
    if (cred === null || entry === null) { reply(socket, 407, AUTHENTICATE); return; }
    const tag = credTag(cred);
    const deny = (host: string, port: number, why: string): void => {
      this.deps.registry.recordDenial(cred, host, port);
      this.deps.log(`deny cred=${tag} host=${JSON.stringify(host)} port=${String(port)} why=${why}`);
      reply(socket, 403);
    };

    if (req.method !== 'CONNECT') { deny(req.target.slice(0, MAX_DENIED_HOST_CHARS), 0, 'not-connect'); return; }
    const target = parseAuthority(req.target);
    if (!target.ok) { deny(req.target.slice(0, MAX_DENIED_HOST_CHARS), 0, 'bad-target'); return; }
    const { host, port } = target.value;

    // 2. The port, 3. the name: both before anything is resolved.
    if (!ALLOWED_PORTS.has(port)) { deny(host, port, 'port'); return; }
    if (!hostInSet(entry.set, host)) { deny(host, port, 'not-in-set'); return; }

    // The slot is taken now, before resolving, so parallel requests cannot all pass the cap.
    const opening = this.opening.get(cred) ?? 0;
    if (this.open >= this.limits.tunnelsTotal || this.deps.registry.tunnelCount(cred) + opening >= this.limits.tunnelsPerCred) {
      this.deps.log(`busy cred=${tag} host=${host}`);
      reply(socket, 503);
      return;
    }
    this.open++;
    this.opening.set(cred, opening + 1);
    let reserved = true;
    const release = (): void => {
      if (!reserved) return;
      reserved = false;
      const n = (this.opening.get(cred) ?? 1) - 1;
      if (n === 0) this.opening.delete(cred); else this.opening.set(cred, n);
    };

    try {
      // 4. Resolve and check every address.
      let addresses: string[];
      if (isIPv4(host)) {
        addresses = [host];
      } else {
        try {
          addresses = await this.deps.lookup(host);
        } catch {
          this.deps.log(`unresolved cred=${tag} host=${host}`);
          this.open--;
          reply(socket, 502);
          return;
        }
      }
      const picked = pickAddress(addresses, this.deps.deny);
      if (!picked.ok) { this.open--; deny(host, port, picked.error.replace(/ /g, '-')); return; }
      if (socket.destroyed) { this.open--; return; }

      // 5. Connect to exactly that address.
      this.tunnel(socket, cred, tag, host, port, entry.set !== '*', picked.value, rest);
    } finally {
      release();
    }
  }

  /** Called with a slot already counted in `open`; every path out of here gives it back once. */
  private tunnel(client: Socket, cred: string, tag: string, host: string, port: number, checkName: boolean, ip: string, rest: Buffer): void {
    let upstream: Socket | null = null;
    let closed = false;
    const handle: TunnelHandle = {
      host,
      close: () => {
        if (closed) return;
        closed = true;
        this.open--;
        this.deps.registry.detach(cred, handle);
        client.destroy();
        upstream?.destroy();
      },
    };
    // The credential may have been revoked while the name was resolving.
    if (!this.deps.registry.attach(cred, handle)) {
      this.open--;
      reply(client, 407, AUTHENTICATE);
      return;
    }
    let established = false;
    const up = this.deps.connect(ip, port);
    upstream = up;
    const connectTimer = setTimeout(() => {
      if (!established) { reply(client, 504); handle.close(); }
    }, this.limits.connectTimeoutMs);
    up.on('error', () => {
      clearTimeout(connectTimer);
      if (!established) reply(client, 502);
      handle.close();
    });
    client.on('close', () => { handle.close(); });
    up.on('close', () => { handle.close(); });
    up.once('connect', () => {
      clearTimeout(connectTimer);
      if (closed) { up.destroy(); return; }
      established = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const start = (first: Buffer): void => {
        this.deps.log(`open cred=${tag} host=${host} ip=${ip} port=${String(port)}`);
        if (first.length > 0) up.write(first);
        client.setTimeout(this.limits.idleTimeoutMs, () => { handle.close(); });
        up.setTimeout(this.limits.idleTimeoutMs, () => { handle.close(); });
        client.pipe(up);
        up.pipe(client);
        client.resume();
      };
      if (!checkName) { start(rest); return; }
      this.readHello(client, host, rest, (verdict, hello) => {
        if (closed) return;
        if (verdict === null) { start(hello); return; }
        this.deps.registry.recordDenial(cred, verdict.name ?? host, port);
        this.deps.log(`deny cred=${tag} host=${host} port=${String(port)} why=${verdict.why}`);
        handle.close();
      });
    });
  }

  /**
   * Read the client hello and hold it to the tunnel's name. Nothing reaches the upstream
   * before the verdict. `done(null, bytes)` passes the bytes read so far on.
   */
  private readHello(client: Socket, host: string, first: Buffer, done: (refused: { why: string; name?: string } | null, bytes: Buffer) => void): void {
    let buf = first;
    let finished = false;
    const finish = (refused: { why: string; name?: string } | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.off('data', onData);
      client.pause();
      done(refused, buf);
    };
    const timer = setTimeout(() => { finish({ why: 'no-hello' }); }, this.limits.headerTimeoutMs);
    const check = (): void => {
      const r = parseClientHello(buf);
      if (r.state === 'more') return;
      if (r.state === 'bad') { finish({ why: 'bad-hello' }); return; }
      if (r.sni === null) { finish({ why: 'no-server-name' }); return; }
      if (r.sni !== host) { finish({ why: 'server-name-differs', name: r.sni.slice(0, MAX_DENIED_HOST_CHARS) }); return; }
      finish(null);
    };
    const onData = (chunk: Buffer): void => { buf = Buffer.concat([buf, chunk]); check(); };
    client.on('data', onData);
    client.resume();
    check();
  }
}

/** Constant-time comparison of a presented Bearer token with the secret. */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const m = header ? /^Bearer (\S+)$/.exec(header) : null;
  const presented = createHash('sha256').update(m ? m[1]! : '').digest();
  const expected = createHash('sha256').update(secret).digest();
  return timingSafeEqual(presented, expected) && m !== null;
}

function send(res: ServerResponse, code: number, body?: unknown): void {
  if (body === undefined) { res.writeHead(code).end(); return; }
  const json = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }).end(json);
}

function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { resolve(null); });
  });
}

export interface AdminDeps {
  registry: CredentialRegistry;
  secret: string;
  log(line: string): void;
  limits?: Partial<ProxyLimits>;
}

/** The registration listener. The secret is checked before anything else, including the path. */
export function createAdminServer(deps: AdminDeps): HttpServer {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const server = createHttpServer((req, res) => { void route(req, res); });
  server.headersTimeout = limits.headerTimeoutMs;
  server.requestTimeout = limits.headerTimeoutMs * 2;

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!bearerMatches(req.headers.authorization, deps.secret)) { send(res, 401); return; }
    const m = /^\/(cred|denials)\/([^/?#]*)$/.exec(req.url ?? '');
    if (!m) { send(res, 404); return; }
    const kind = m[1]!;
    const cred = m[2]!;
    if (!isCredential(cred)) { send(res, 400, { error: 'bad credential' }); return; }
    if (kind === 'denials') {
      if (req.method !== 'GET') { send(res, 405); return; }
      const denials = deps.registry.denials(cred);
      if (denials === null) { send(res, 404); return; }
      send(res, 200, denials);
      return;
    }
    if (req.method === 'DELETE') {
      deps.registry.delete(cred);
      deps.log(`revoke cred=${credTag(cred)}`);
      send(res, 204);
      return;
    }
    if (req.method !== 'PUT') { send(res, 405); return; }
    // A declared length over the cap is answered without reading; an undeclared one is cut off.
    if (Number(req.headers['content-length'] ?? 0) > limits.maxBodyBytes) {
      res.setHeader('connection', 'close');
      send(res, 400, { error: 'body too large' });
      return;
    }
    const raw = await readBody(req, limits.maxBodyBytes);
    if (raw === null) { send(res, 400, { error: 'body too large' }); return; }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { send(res, 400, { error: 'body is not JSON' }); return; }
    const reg = parseRegistration(body);
    if (!reg.ok) { send(res, 400, { error: reg.error }); return; }
    if (!deps.registry.put(cred, reg.value)) { send(res, 503, { error: 'too many credentials' }); return; }
    deps.log(`register cred=${credTag(cred)} hosts=${reg.value.set === '*' ? '*' : String(reg.value.set.size)} ttl=${String(reg.value.ttlS)}`);
    send(res, 204);
  }

  return server;
}
