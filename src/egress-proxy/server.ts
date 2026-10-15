/**
 * The two listeners of the egress proxy (PRD 152 v2 §4.2).
 *
 * The shell listener takes `CONNECT host:port` and absolute-form `http://` requests from the
 * shell sidecar, which has no other route out. The registration listener takes the engine's
 * `PUT /cred`, `DELETE /cred` and `GET /denials`. main.ts binds each to its own network, so
 * the sidecar cannot reach the second one at all; the Bearer secret is the second layer.
 *
 * Resolution and connection come in as dependencies, so the tests can show that a name
 * outside the set reaches no resolver and that the connection goes to the checked address.
 */

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { hostInSet, type CredentialRegistry, type TunnelHandle } from './registry.js';
import { ALLOWED_PORTS, credentialFromHeader, isCredential, parseAuthority, parseRegistration, pickAddress, type Target } from './policy.js';

export interface ProxyLimits {
  /** Request head of the shell side, request line and headers. */
  maxHeaderBytes: number;
  headerTimeoutMs: number;
  connectTimeoutMs: number;
  /** A tunnel with no bytes either way for this long is closed. */
  idleTimeoutMs: number;
  tunnelsPerCred: number;
  tunnelsTotal: number;
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

function reply(socket: Socket, code: number, extra = ''): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${String(code)} ${REASONS[code] ?? ''}\r\n${extra}Content-Length: 0\r\nConnection: close\r\n\r\n`);
}

interface RequestHead {
  method: string;
  target: Target;
  /** For absolute-form http: the path and query to send upstream. `null` for CONNECT. */
  path: string | null;
  /** Header lines as received, without the request line. */
  lines: string[];
  proxyAuthorization: string | undefined;
}

function parseHead(head: string): RequestHead | { error: number } {
  const lines = head.split('\r\n');
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(lines[0] ?? '');
  if (!m) return { error: 400 };
  const method = m[1]!;
  const rawTarget = m[2]!;
  const headerLines = lines.slice(1);
  let proxyAuthorization: string | undefined;
  for (const line of headerLines) {
    const c = line.indexOf(':');
    if (c <= 0) return { error: 400 };
    if (line.slice(0, c).trim().toLowerCase() === 'proxy-authorization') {
      if (proxyAuthorization !== undefined) return { error: 400 };
      proxyAuthorization = line.slice(c + 1).trim();
    }
  }
  if (method === 'CONNECT') {
    const t = parseAuthority(rawTarget);
    if (!t.ok) return { error: 400 };
    return { method, target: t.value, path: null, lines: headerLines, proxyAuthorization };
  }
  const abs = /^http:\/\/([^/?#@]+)([/?][^#]*)?$/i.exec(rawTarget);
  if (!abs) return { error: 405 };
  const t = parseAuthority(abs[1]!, 80);
  if (!t.ok) return { error: 400 };
  return { method, target: t.value, path: abs[2] && abs[2].startsWith('/') ? abs[2] : `/${abs[2] ?? ''}`, lines: headerLines, proxyAuthorization };
}

const HOP_HEADERS = new Set(['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive']);

/** The request as the origin server sees it: origin-form, no proxy headers, one request per connection. */
function upstreamHead(req: RequestHead): string {
  const kept = req.lines.filter((l) => !HOP_HEADERS.has(l.slice(0, l.indexOf(':')).trim().toLowerCase()));
  return `${req.method} ${req.path ?? '/'} HTTP/1.1\r\n${kept.map((l) => `${l}\r\n`).join('')}Connection: close\r\n\r\n`;
}

export class ShellProxy {
  readonly server: NetServer;
  private readonly limits: ProxyLimits;
  private open = 0;

  constructor(private readonly deps: ShellDeps) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.limits };
    this.server = createNetServer((socket) => { this.accept(socket); });
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
    if ('error' in req) { reply(socket, req.error); return; }
    const { host, port } = req.target;

    // 1. The credential.
    const cred = credentialFromHeader(req.proxyAuthorization);
    const entry = cred === null ? null : this.deps.registry.lookup(cred);
    if (cred === null || entry === null) {
      reply(socket, 407, 'Proxy-Authenticate: Basic realm="lynox-egress"\r\n');
      return;
    }
    const tag = credTag(cred);
    const deny = (why: string): void => {
      this.deps.registry.recordDenial(cred, host, port);
      this.deps.log(`deny cred=${tag} host=${host} port=${String(port)} why=${why}`);
      reply(socket, 403);
    };

    // 2. The port, 3. the name: both before anything is resolved.
    if (!ALLOWED_PORTS.has(port)) { deny('port'); return; }
    if (!hostInSet(entry.set, host)) { deny('not-in-set'); return; }

    if (this.open >= this.limits.tunnelsTotal || this.deps.registry.tunnelCount(cred) >= this.limits.tunnelsPerCred) {
      this.deps.log(`busy cred=${tag} host=${host}`);
      reply(socket, 503);
      return;
    }

    // 4. Resolve and check every address.
    let addresses: string[];
    if (isIPv4(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await this.deps.lookup(host);
      } catch {
        this.deps.log(`unresolved cred=${tag} host=${host}`);
        reply(socket, 502);
        return;
      }
    }
    const picked = pickAddress(addresses, this.deps.deny);
    if (!picked.ok) { deny(picked.error.replace(/ /g, '-')); return; }
    if (socket.destroyed) return;

    // 5. Connect to exactly that address.
    this.tunnel(socket, cred, tag, req, picked.value, rest);
  }

  private tunnel(client: Socket, cred: string, tag: string, req: RequestHead, ip: string, rest: Buffer): void {
    const { host, port } = req.target;
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
      reply(client, 407, 'Proxy-Authenticate: Basic realm="lynox-egress"\r\n');
      return;
    }
    this.open++;
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
      this.deps.log(`open cred=${tag} host=${host} ip=${ip} port=${String(port)}`);
      if (req.path === null) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else up.write(upstreamHead(req));
      if (rest.length > 0) up.write(rest);
      client.setTimeout(this.limits.idleTimeoutMs, () => { handle.close(); });
      up.setTimeout(this.limits.idleTimeoutMs, () => { handle.close(); });
      client.pipe(up);
      up.pipe(client);
      client.resume();
    });
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
