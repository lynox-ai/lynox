import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('node:dns/promises', () => ({
  default: { lookup: vi.fn() },
}));

import dns from 'node:dns/promises';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMailProviderTarget } from './bulk-mail-targets.js';
import { EngineDb } from './engine-db.js';
import { BulkLedger, contractWritesMail } from './bulk-ledger.js';
import { externalClient, externalWriter, mintBulkContract, planExternal, type ExternalPlanned } from './bulk-external.js';
import { BulkWriterHalt } from './bulk-apply.js';
import { setPinnedTransportForTests, type PinnedTransportInput } from './network-guard.js';
import { createToolContext } from './tool-context.js';
import { detectSecretInContent } from '../tools/builtin/http.js';

/**
 * A bulk run never writes to a mail provider's API: the predicate on its own, and each
 * place that acts on it — planning, approving and resuming, and the request itself.
 */

const GMAIL_VACATION = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/vacation';
const SHOP = 'shop.example.com';
const shopUrl = (i: number): string => `https://${SHOP}/products/${String(i)}`;

describe('isMailProviderTarget', () => {
  it.each([
    GMAIL_VACATION,
    'https://gmail.googleapis.com/gmail/v1/users/me/settings/forwardingAddresses/x',
    'https://www.googleapis.com/gmail/v1/users/me/settings/vacation',
    'https://www.googleapis.com/upload/gmail/v1/users/me/messages',
    'https://www.googleapis.com/batch/gmail/v1',
    'https://content-gmail.googleapis.com/gmail/v1/users/me/settings/vacation',
    'https://gmail.mtls.googleapis.com/gmail/v1/users/me/settings/vacation',
    'https://content.googleapis.com/gmail/v1/users/me/settings/vacation',
    'https://graph.microsoft.com/v1.0/me/events/1',
    'https://graph.microsoft.com/v1.0/me/calendars/abc/events/1',
    'https://graph.microsoft.com/v1.0/groups/g1/threads/t1',
    "https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messageRules",
    "https://graph.microsoft.com/v1.0/users('abc')/mailboxSettings",
    "https://graph.microsoft.com/v1.0/users('abc')/sendMail",
    "https://graph.microsoft.com/v1.0/users('abc')/messages/1",
    'https://graph.microsoft.com/v1.0/users/abc/microsoft.graph.user/mailboxSettings',
    'https://graph.microsoft.com/v1.0/users/abc/microsoft.graph.user/events/1',
    'https://graph.microsoft.com/v1.0/users/me/messages/1',
    'https://graph.microsoft.com/v1.0/$batch',
    'https://graph.microsoft.com/v1.0/me/microsoft.graph.sendMail',
    'https://graph.microsoft.com/v1.0/users/abc/microsoft.graph.sendMail',
    'https://graph.microsoft.com/v1.0/tenant.onmicrosoft.com/users/abc/messages/1',
    'https://graph.microsoft.com/v1.0/contoso.com/me/events/1',
    'https://graph.microsoft.com/v1.0/me/mailboxSettings',
    'https://graph.microsoft.com/v1.0/users/abc/messages/xyz',
    'https://graph.microsoft.com/beta/me/mailFolders/inbox/messageRules/1',
    'https://graph.microsoft.com/v1.0/me/sendMail',
    'https://graph.microsoft.us/v1.0/me/mailboxSettings',
    'https://outlook.office.com/api/v2.0/me/messages/1',
  ])('refuses %s', (url) => {
    expect(isMailProviderTarget(url)).toBe(true);
  });

  it('refuses every path on a host that is Gmail\'s own, not only the /gmail ones', () => {
    expect(isMailProviderTarget('https://gmail.googleapis.com/v2/users/me/settings/vacation')).toBe(true);
    expect(isMailProviderTarget('https://content-gmail.googleapis.com/users/me/settings/vacation')).toBe(true);
    // The /gmail prefix alone decides on a shared host: the same path there is not Gmail.
    expect(isMailProviderTarget('https://www.googleapis.com/v2/users/me/settings/vacation')).toBe(false);
  });

  it('reads a spelling of the same resource as that resource', () => {
    expect(isMailProviderTarget('https://GMAIL.googleapis.com./gmail/v1/users/me/settings/vacation')).toBe(true);
    expect(isMailProviderTarget('https://graph.microsoft.com/v1.0/me/MailboxSettings')).toBe(true);
    expect(isMailProviderTarget('https://graph.microsoft.com/v1.0/me/%6DailboxSettings')).toBe(true);
    expect(isMailProviderTarget('https://www.googleapis.com/GMAIL/v1/users/me/settings/vacation')).toBe(true);
    // An encoded slash is a separator: decoded before the path is split.
    expect(isMailProviderTarget('https://www.googleapis.com/gmail%2Fv1/users/me/settings/vacation')).toBe(true);
    expect(isMailProviderTarget('https://graph.microsoft.com/v1.0/me%2FmailboxSettings')).toBe(true);
    // A malformed escape spoils only its own segment, not the decoding of the others.
    expect(isMailProviderTarget('https://graph.microsoft.com/v1.0/me/%6DailboxSettings/x%ZZ')).toBe(true);
  });

  it.each([
    shopUrl(0),
    'https://www.googleapis.com/drive/v3/files/1',
    'https://www.googleapis.com/calendar/v3/calendars/primary',
    'https://graph.microsoft.com/v1.0/me/drive/items/1',
    'https://graph.microsoft.com/v1.0/me/drive/root:/messages/a.xlsx:',
    "https://graph.microsoft.com/v1.0/users('abc')/drive/items/1",
    'https://www.googleapis.com/batch/drive/v3',
    'https://storage.googleapis.com/batch/storage/v1',
    'https://graph.microsoft.com/v1.0/teams/t1/channels/c1/messages/m1',
    'https://graph.microsoft.com/v1.0/me',
    'https://api.example.com/gmail/settings',
    'not a url',
  ])('leaves %s alone', (url) => {
    expect(isMailProviderTarget(url)).toBe(false);
  });
});

describe('planning, approving and writing a bulk run to a mail API', () => {
  let dir: string;
  let engineDb: EngineDb;
  let ledger: BulkLedger;
  let requests: { method: string; url: string }[];
  let restore: () => void;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bulk-mail-')));
    engineDb = new EngineDb(join(dir, 'engine.db'), 'test-vault-key');
    ledger = new BulkLedger(engineDb);
    requests = [];
    vi.mocked(dns.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    restore = setPinnedTransportForTests(async (input: PinnedTransportInput) => {
      requests.push({ method: input.method, url: input.url });
      return input.method === 'GET'
        ? new Response(JSON.stringify({ enableAutoReply: false, price: '1.00' }), { status: 200 })
        : new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    restore();
    engineDb.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const client = (host: string, keys: string[], method: 'PATCH' | 'PUT' = 'PATCH') => externalClient({
    contract: mintBulkContract(host, keys, method),
    hostPolicy: createToolContext({}),
    ackHosts: undefined,
    attach: async (_u, headers) => { headers['authorization'] = 'Bearer fixture'; return true; },
    rateLimit: () => null,
    scan: detectSecretInContent,
  });

  it('plans a mail API target as invalid, and a target on another host as a target', () => {
    const planned = planExternal([{ target: GMAIL_VACATION, after: { enableAutoReply: true } }], 'gmail.googleapis.com', detectSecretInContent);
    expect(planned).toEqual([{ key: GMAIL_VACATION, invalid: 'mail_api' }]);
    const shop = planExternal([{ target: shopUrl(0), after: { price: '2' } }], SHOP, detectSecretInContent);
    expect(shop).toEqual([{ key: shopUrl(0), after: { price: '2' } }]);
  });

  it('sends nothing to a mail API, even under a contract that grants it, and halts the writer', async () => {
    const c = client('gmail.googleapis.com', [GMAIL_VACATION], 'PUT');
    expect(await c.write(GMAIL_VACATION, 'PUT', { enableAutoReply: true })).toEqual({ kind: 'blocked' });
    expect(await c.get(GMAIL_VACATION)).toEqual({ kind: 'blocked' });
    const writer = externalWriter(c, { method: 'PUT', sleep: async () => {} });
    await expect(writer.write(GMAIL_VACATION, { absent: false, value: { enableAutoReply: true } })).rejects.toBeInstanceOf(BulkWriterHalt);
    expect(requests).toEqual([]);
  });

  it('still writes a non-mail path on the same Google host that serves Gmail', async () => {
    const drive = 'https://www.googleapis.com/drive/v3/files/1';
    const gmail = 'https://www.googleapis.com/gmail/v1/users/me/settings/vacation';
    const c = client('www.googleapis.com', [drive, gmail], 'PATCH');
    expect(await c.write(gmail, 'PATCH', { enableAutoReply: true })).toEqual({ kind: 'blocked' });
    expect(requests).toEqual([]);
    // The control: the same client, host and policy reach the transport for the drive file.
    expect(await c.write(drive, 'PATCH', { name: 'x' })).toEqual({ kind: 'ok', value: undefined });
    expect(requests).toEqual([{ method: 'PATCH', url: drive }]);
  });

  it('still writes to a host that is not a mail API', async () => {
    const c = client(SHOP, [shopUrl(0)]);
    expect(await c.write(shopUrl(0), 'PATCH', { price: '2' })).toEqual({ kind: 'ok', value: undefined });
    expect(requests).toEqual([{ method: 'PATCH', url: shopUrl(0) }]);
  });

  /** A run whose contract grants a write to a mail API (as only a stored run can carry it:
   *  planning now marks such a target invalid). Moved to `phase`. */
  function runWithMailContract(phase: 'previewed' | 'approved'): string {
    const targets: ExternalPlanned[] = [{ key: GMAIL_VACATION, after: { enableAutoReply: true } }];
    const out = ledger.recordExternalPlan({
      createdBy: 't', host: 'gmail.googleapis.com', targets, contract: mintBulkContract('gmail.googleapis.com', [GMAIL_VACATION], 'PUT'),
    });
    if (!out.ok) throw new Error(out.reason);
    const id = out.status.id;
    engineDb.getDb().prepare('UPDATE bulk_runs SET phase = ? WHERE id = ?').run(phase, id);
    if (phase === 'approved') {
      engineDb.getDb().prepare('UPDATE bulk_runs SET approval_checksum = ? WHERE id = ?').run(ledger.computeChecksum(id), id);
    }
    return id;
  }

  it('refuses to approve a run whose contract writes a mail API', () => {
    const id = runWithMailContract('previewed');
    expect(ledger.approve(id, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'mail_api' });
  });

  it('refuses to resume an approved run whose contract writes a mail API', () => {
    const id = runWithMailContract('approved');
    expect(ledger.resume(id, { checksum: ledger.computeChecksum(id)! })).toEqual({ ok: false, reason: 'mail_api' });
  });

  it('refuses to plan an undo of a run whose contract writes a mail API', () => {
    const id = runWithMailContract('approved');
    engineDb.getDb().prepare("UPDATE bulk_runs SET phase = 'done' WHERE id = ?").run(id);
    expect(ledger.planUndo(id)).toEqual({ ok: false, reason: 'mail_api' });
  });

  it('reads the contract, not the target list, so the check needs no decryption', () => {
    expect(contractWritesMail('http:gmail.googleapis.com', JSON.stringify({ pathPatterns: ['/gmail/v1/users/me/settings/vacation'] }))).toBe(true);
    expect(contractWritesMail('http:graph.microsoft.com', JSON.stringify({ pathPatterns: ['/v1.0/me/drive/items/1', '/v1.0/me/mailboxSettings'] }))).toBe(true);
    expect(contractWritesMail('http:graph.microsoft.com', JSON.stringify({ pathPatterns: ['/v1.0/me/drive/items/1'] }))).toBe(false);
    expect(contractWritesMail(`http:${SHOP}`, JSON.stringify({ pathPatterns: ['/products/0'] }))).toBe(false);
    expect(contractWritesMail('workspace', null)).toBe(false);
  });
});
