import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImapSmtpProvider, type CredentialsResolver } from './imap-smtp.js';
import type { MailAccountConfig } from '../provider.js';

// === F1 real-TLS E2E ========================================================
//
// The mocked imap-smtp.test.ts proves the provider PASSES `rejectUnauthorized`
// to nodemailer. This file proves the END-TO-END effect at the REAL TLS layer:
// it stands up a real SMTPS server presenting a SELF-SIGNED certificate, points
// the real ImapSmtpProvider at it, and asserts the handshake is rejected by
// default but accepted — mail delivered — when LYNOX_MAIL_INSECURE_TLS (or the
// construction option) is set. This is the live path the staging GreenMail
// fleet can't exercise (its SMTPS port 3465 is firewalled; STARTTLS on 3025 is
// unsupported), so we reproduce the self-signed-cert send here instead.
//
// The certificate is generated at RUNTIME (openssl, in a temp dir, deleted on
// teardown) so NO key material is committed — keeping the secret scanners clean.

let opensslOk = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  opensslOk = false;
}

function makeSelfSignedCert(dir: string): { cert: Buffer; key: Buffer } {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  );
  return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
}

/**
 * Minimal SMTPS server. The TLS handshake (where `rejectUnauthorized` bites)
 * happens before any SMTP byte; past it, we speak just enough SMTP for
 * nodemailer to complete a send and fire `onDelivered`.
 */
function startSmtpsServer(cert: Buffer, key: Buffer, onDelivered: () => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer({ cert, key, minVersion: 'TLSv1.2' }, (socket) => {
      let inData = false;
      let dataBuf = '';
      socket.setEncoding('utf8');
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        if (inData) {
          dataBuf += chunk;
          if (dataBuf.includes('\r\n.\r\n')) {
            inData = false;
            socket.write('250 2.0.0 OK queued\r\n');
            onDelivered();
          }
          return;
        }
        const cmd = chunk.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-test\r\n250 AUTH PLAIN\r\n');
        else if (cmd === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
        else if (cmd === 'MAIL') socket.write('250 2.1.0 OK\r\n');
        else if (cmd === 'RCPT') socket.write('250 2.1.5 OK\r\n');
        else if (cmd === 'DATA') { socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); inData = true; dataBuf = ''; }
        else if (cmd === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
        else socket.write('250 2.0.0 OK\r\n');
      });
      // The client aborts the socket when it rejects the self-signed cert —
      // that's the expected path for the default (secure) case, not an error.
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
    });
  });
}

describe.skipIf(!opensslOk)('ImapSmtpProvider — real self-signed SMTPS send (F1 insecureTls E2E)', () => {
  let dir: string;
  let server: Server;
  let port: number;
  let delivered = false;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-tls-'));
    const { cert, key } = makeSelfSignedCert(dir);
    ({ server, port } = await startSmtpsServer(cert, key, () => { delivered = true; }));
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => { delivered = false; });

  function provider(opts?: { insecureTls?: boolean }): ImapSmtpProvider {
    const account: MailAccountConfig = {
      id: 'tls-e2e', displayName: 'TLS E2E', address: 'me@localhost', preset: 'custom',
      imap: { host: '127.0.0.1', port: 1, secure: true }, // unused — only send() is exercised
      smtp: { host: '127.0.0.1', port, secure: true }, // implicit TLS (SMTPS)
      authType: 'imap', type: 'personal',
    };
    const cred: CredentialsResolver = () => ({ user: 'me@localhost', pass: 'pw' });
    return new ImapSmtpProvider(account, cred, opts);
  }

  const message = { to: [{ address: 'rcpt@localhost' }], subject: 's', text: 't' };

  it('REJECTS a self-signed cert by default — the send fails with tls_failed, nothing delivered', async () => {
    const p = provider(); // no option, no env → rejectUnauthorized stays ON
    await expect(p.send(message)).rejects.toMatchObject({ code: 'tls_failed' });
    expect(delivered).toBe(false);
    await p.close();
  });

  it('ACCEPTS the self-signed cert + DELIVERS when insecureTls is set (the F1 path)', async () => {
    const p = provider({ insecureTls: true });
    const result = await p.send(message);
    expect(result.accepted).toContain('rcpt@localhost');
    expect(delivered).toBe(true);
    await p.close();
  });

  it('the env flag LYNOX_MAIL_INSECURE_TLS=1 alone enables delivery (no construction option)', async () => {
    const prior = process.env['LYNOX_MAIL_INSECURE_TLS'];
    process.env['LYNOX_MAIL_INSECURE_TLS'] = '1';
    try {
      const result = await provider().send(message);
      expect(result.accepted).toContain('rcpt@localhost');
      expect(delivered).toBe(true);
    } finally {
      if (prior === undefined) delete process.env['LYNOX_MAIL_INSECURE_TLS'];
      else process.env['LYNOX_MAIL_INSECURE_TLS'] = prior;
    }
  });
});
