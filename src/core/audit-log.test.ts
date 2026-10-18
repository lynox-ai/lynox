import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, OutwardReadUnrecorded, delegatedRedirects, httpTarget, namedTarget, outwardReadRecorder, requestOutcomePhase, requestPathTarget } from './audit-log.js';
import { OWNER_PRINCIPAL } from './request-principal.js';
import { createMailReadTool } from '../integrations/mail/tools/mail-read.js';
import { createMailSearchTool } from '../integrations/mail/tools/mail-search.js';
import { createMailTriageTool } from '../integrations/mail/tools/mail-triage.js';
import { createWebSearchTool } from '../integrations/search/web-search-tool.js';
import type { SearchProvider } from '../integrations/search/search-provider.js';
import { calendarReadTool } from '../tools/builtin/calendar.js';
import type { RequestPrincipal } from './request-principal.js';
import type { ToolEntry } from '../types/index.js';
import type { MailRegistry } from '../integrations/mail/tools/registry.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { apiSetupTool } from '../tools/builtin/api-setup.js';
import { spawnAgentTool } from '../tools/builtin/spawn.js';
import { createSheetsTool } from '../integrations/google/google-sheets.js';
import { createDocsTool } from '../integrations/google/google-docs.js';
import { createDriveTool } from '../integrations/google/google-drive.js';
import { createCalendarTool } from '../integrations/google/google-calendar.js';
import { createMailSendTool } from '../integrations/mail/tools/mail-send.js';
import { createMailReplyTool } from '../integrations/mail/tools/mail-reply.js';
import { createMailConnectTool } from '../integrations/mail/tools/mail-connect.js';

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'recipient@example.invalid', display: 'TEST-DISPLAY', mandateId: 'TEST-MANDATE-1' };

describe('audit_log in engine.db (v22)', () => {
  let dir = '';
  let db: EngineDb;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lynox-audit-store-')); db = new EngineDb(join(dir, 'engine.db')); });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const rows = (): Array<Record<string, unknown>> => db.getDb().prepare('SELECT * FROM audit_log ORDER BY id').all() as Array<Record<string, unknown>>;

  it('writes one row per step, with the mandate\'s identity and nothing else of the act', () => {
    new AuditLog(db.getDb()).record({ principal: MANDATE, action: 'mail_send:send', target: 'mail_send send', phase: 'attempt', correlationId: 'c-1', runId: 'r-1' });
    expect(rows()).toEqual([expect.objectContaining({
      actor_kind: 'mandate', actor_email: 'recipient@example.invalid', actor_display: 'TEST-DISPLAY', mandate_id: 'TEST-MANDATE-1',
      action: 'mail_send:send', target: 'mail_send send', phase: 'attempt', correlation_id: 'c-1', run_id: 'r-1', request_id: null,
    })]);
    expect(Date.parse(rows()[0]!['ts'] as string)).not.toBeNaN();
  });

  it('refuses to change a row once written', () => {
    new AuditLog(db.getDb()).record({ principal: MANDATE, action: 'a', phase: 'attempt', correlationId: 'c-1' });
    expect(() => db.getDb().prepare("UPDATE audit_log SET phase = 'done'").run()).toThrow(/never changed/);
    expect(rows()[0]!['phase']).toBe('attempt');
  });

  it('is emptied by the owner\'s erasure like every other table', () => {
    new AuditLog(db.getDb()).record({ principal: MANDATE, action: 'a', phase: 'attempt', correlationId: 'c-1' });
    db.deleteAllData();
    expect(rows()).toEqual([]);
  });

  it('bounds what a model-chosen value can put into a row, on one line', () => {
    new AuditLog(db.getDb()).record({ principal: MANDATE, action: `x\n${'a'.repeat(500)}`, target: 't'.repeat(2000), phase: 'attempt', correlationId: 'c-1' });
    const r = rows()[0]!;
    expect((r['action'] as string).length).toBeLessThanOrEqual(120);
    expect(r['action'] as string).not.toContain('\n');
    expect((r['target'] as string).length).toBeLessThanOrEqual(400);
  });

  it('throws when the row cannot be written, so a caller can refuse the act', () => {
    const log = new AuditLog(db.getDb());
    db.close();
    expect(() => log.record({ principal: MANDATE, action: 'a', phase: 'attempt', correlationId: 'c-1' })).toThrow();
    db = new EngineDb(join(dir, 'engine.db'));
  });

  it('has no way to read the trail back (D7: it never reaches a model\'s context)', () => {
    const methods = Object.getOwnPropertyNames(AuditLog.prototype).filter(n => n !== 'constructor');
    expect(methods).toEqual(['record']);
  });
});

describe('httpTarget', () => {
  it('names method, host and path — no userinfo, no query, no fragment', () => {
    expect(httpTarget('POST', 'https://user:pw@api.example.invalid:8443/v1/items?token=abc#frag')).toBe('POST api.example.invalid:8443/v1/items');
  });
  it('replaces a path segment that reads as a key, and keeps names and plain ids', () => {
    // Webhook-shaped paths, built at run time so no key-shaped literal sits in the file.
    const key24 = ['k9m', 'Q2x', 'W7p', 'Lr4', 'Zt8', 'Vb3', 'Nc6', 'Hd1'].join('');
    expect(httpTarget('POST', `https://hooks.example.invalid/services/T0AB12CD3/B0EF45GH6/${key24}`))
      .toBe('POST hooks.example.invalid/services/T0AB12CD3/B0EF45GH6/<key>');
    expect(httpTarget('POST', `https://api.example.invalid/bot123456789:${key24}/sendMessage`))
      .toBe('POST api.example.invalid/<key>/sendMessage');
    expect(httpTarget('DELETE', 'https://api.example.invalid/v1/customers/123456789012345678/notes'))
      .toBe('DELETE api.example.invalid/v1/customers/123456789012345678/notes');
  });
  it('never masks the host, however long its labels are', () => {
    const label = 'a'.repeat(30) + 'b'.repeat(15);
    expect(httpTarget('POST', `https://${label}.example.invalid/v1/upload`)).toBe(`POST ${label}.example.invalid/v1/upload`);
  });
  it('does not echo a URL it cannot parse', () => {
    expect(httpTarget('POST', 'not a url ?token=abc')).toBe('POST <unparsed url>');
  });
});

describe('which tool calls write outside the instance (ToolEntry.outwardWrite)', () => {
  const noAuth = (): null => null;
  const mail = {} as MailRegistry;
  const tools: Array<ToolEntry<never>> = [
    httpRequestTool, apiSetupTool, spawnAgentTool,
    createSheetsTool(noAuth), createDocsTool(noAuth), createDriveTool(noAuth), createCalendarTool(noAuth),
    createMailSendTool(mail), createMailReplyTool(mail), createMailConnectTool(),
  ] as unknown as Array<ToolEntry<never>>;
  const byName = (name: string): ToolEntry<never> => tools.find(t => t.definition.name === name)!;
  const label = (name: string, input: Record<string, unknown>): string | null => byName(name).outwardWrite!(input as never);

  it('is declared by every tool that changes data outside, and by the mail writers', () => {
    const external = tools.filter(t => t.destructive?.mode === 'external').map(t => t.definition.name);
    // The set this check stands on is the real one, not an empty filter.
    expect(external).toEqual(expect.arrayContaining(['google_sheets', 'google_docs', 'google_drive', 'google_calendar', 'spawn_agent']));
    for (const t of tools) expect(typeof t.outwardWrite, t.definition.name).toBe('function');
  });

  it('labels a write and leaves a read unlabelled', () => {
    expect(label('google_sheets', { action: 'read' })).toBeNull();
    expect(label('google_sheets', { action: 'write' })).toBe('write');
    expect(label('google_sheets', { action: 'create' }), 'creating a spreadsheet writes at Google too').toBe('create');
    expect(label('google_docs', { action: 'read' })).toBeNull();
    expect(label('google_docs', { action: 'append' })).toBe('append');
    expect(label('google_drive', { action: 'search' })).toBeNull();
    expect(label('google_drive', { action: 'share' })).toBe('share');
    expect(label('google_calendar', { action: 'list_events' })).toBeNull();
    expect(label('google_calendar', { action: 'delete_event' })).toBe('delete_event');
    expect(label('mail_send', {})).toBe('send');
    expect(label('mail_reply', {})).toBe('reply');
    expect(label('mail_connect', {})).toBe('connect');
    expect(label('api_setup', { action: 'fetch_token' })).toBe('fetch_token');
    expect(label('api_setup', { action: 'list' })).toBeNull();
    expect(label('spawn_agent', { agents: [] }), 'each call a child makes is classified on its own').toBeNull();
  });

  it('reads http_request\'s effective method, overrides included', () => {
    expect(label('http_request', { url: 'https://a.example.invalid/' })).toBeNull();
    expect(label('http_request', { url: 'https://a.example.invalid/', method: 'HEAD' })).toBeNull();
    expect(label('http_request', { url: 'https://a.example.invalid/', method: 'POST' })).toBe('POST');
    expect(label('http_request', { url: 'https://a.example.invalid/', method: 'GET', headers: { 'X-HTTP-Method-Override': 'DELETE' } })).toBe('DELETE');
    expect(label('http_request', { url: 'https://a.example.invalid/?_method=PUT', method: 'GET' })).toBe('PUT');
    expect(label('http_request', { url: 'https://a.example.invalid/', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"_method":"DELETE"}' }), 'a body field').toBe('DELETE');
    expect(label('http_request', { url: 'https://a.example.invalid/', method: 'GET', headers: { 'X-HTTP-Method-Override': 'BREW' } }), 'an override that is not a method counts as a write').toBe('OVERRIDE');
  });
});

describe('requestPathTarget: no secret shape survives into a read row', () => {
  // Every shape is built at RUNTIME: this repo is public, and the commit-time scan looks for
  // key-shaped literals. `tell` is a run of the secret that masking must not leave behind.
  const body = (n: number): string => Array.from({ length: n }, (_, i) => 'Q7x9Kp2Lm4Nz8Rt6'[i % 16]).join('');
  const SAMPLES: ReadonlyArray<{ shape: string; secret: string; tell: string }> = [
    { shape: 'Anthropic', secret: `sk-ant-${body(24)}`, tell: body(24).slice(4, 14) },
    { shape: 'Anthropic, no early digit', secret: `sk-ant-abcdefghij${body(14)}`, tell: 'abcdefghij' },
    { shape: 'OpenAI project', secret: `sk-proj-${body(24)}`, tell: body(24).slice(4, 14) },
    { shape: 'OpenAI-style', secret: `sk-${body(24)}`, tell: body(24).slice(4, 14) },
    { shape: 'Stripe', secret: `sk_live_${body(20)}`, tell: body(20).slice(4, 14) },
    { shape: 'GitHub', secret: `ghp_${body(36)}`, tell: body(36).slice(4, 14) },
    { shape: 'AWS', secret: `AKIA${body(16).toUpperCase()}`, tell: body(16).toUpperCase().slice(2, 12) },
    { shape: 'Google API', secret: `AIza${body(35)}`, tell: body(35).slice(4, 14) },
    { shape: 'Slack', secret: `${['xo', 'xb-'].join('')}${body(20)}`, tell: body(20).slice(4, 14) },
    { shape: 'Google OAuth', secret: `ya29.${body(24)}`, tell: body(24).slice(4, 14) },
    { shape: 'JWT', secret: `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${body(24)}`, tell: 'eyJzdWIiOiIxMjM0' },
    { shape: 'Bearer', secret: `Bearer ${body(26)}`, tell: body(26).slice(4, 14) },
    { shape: 'credential in URL', secret: `postgres://admin:${body(16)}@db`, tell: body(16).slice(2, 12) },
    { shape: 'long token', secret: `${body(44)}`, tell: body(44).slice(4, 14) },
  ];
  const escapeAll = (s: string): string => [...new TextEncoder().encode(s)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  /** How a path may carry the secret: as the URL parser hands the path to the dispatcher. */
  const WRAPS: ReadonlyArray<[string, (s: string) => string]> = [
    ['as typed', (s) => `/api/files/x/${encodeURI(s)}`],
    ['every byte escaped', (s) => `/api/files/${escapeAll(s)}`],
    ['separators escaped', (s) => `/api/files/${encodeURIComponent(s)}`],
    ['behind an encoded slash', (s) => `/api/files/inbox%2F${encodeURIComponent(s)}`],
    ['behind a lowercase encoded slash', (s) => `/api/files/inbox%2f${encodeURIComponent(s)}`],
    ['behind a byte that is not UTF-8', (s) => `/api/files/x%FF${encodeURIComponent(s)}`],
    ['behind an escaped question mark', (s) => `/api/files/x%3F${encodeURIComponent(s)}`],
    ['behind an escaped space', (s) => `/api/files/x%20${encodeURIComponent(s)}`],
  ];
  const asParsed = (path: string): string => new URL(`http://h${path}`).pathname;

  for (const { shape, secret, tell } of SAMPLES) {
    it(`masks ${shape} in every way a path or a value carries it`, () => {
      const leaked: string[] = [];
      for (const [how, wrap] of WRAPS) {
        const out = requestPathTarget(asParsed(wrap(secret)));
        if (out.includes(tell)) leaked.push(`${how}: ${out}`);
      }
      for (const value of [secret, `x/${secret}`, `x?${secret}`, `x&${secret}`]) {
        const out = requestPathTarget('/api/files/read', [['path', value]]);
        if (out.includes(tell)) leaked.push(`value ${JSON.stringify(value)}: ${out}`);
      }
      expect(leaked).toEqual([]);
    });
  }

  it('keeps apart what the handler tells apart, when no secret is there', () => {
    const t = (p: string): string => requestPathTarget(asParsed(p));
    expect(t('/api/files/a%2Fb')).toBe('/api/files/a%2Fb');
    expect(t('/api/files/a%252Fb')).toBe('/api/files/a%252Fb');
    expect(t('/api/files/%FF')).toBe('/api/files/%FF');
    expect(t('/api/files/%25FF')).toBe('/api/files/%25FF');
    expect(t('/api/files/a/b')).toBe('/api/files/a/b');
  });

  it('writes a path that cannot pose as a query and a value that cannot add a pair', () => {
    const t = (p: string, ids: Array<[string, string]> = []): string => requestPathTarget(asParsed(p), ids);
    expect(t('/api/files/x%3Fpath%3D%2Fetc%26threadId%3D1')).toBe('/api/files/x%3Fpath%3D%2Fetc%26threadId%3D1');
    expect(t('/api/files/a%E2%80%AEb')).toBe('/api/files/a%E2%80%AEb');
    expect(t('/api/files/read', [['path', 'a&hidden=1\n']])).toBe('/api/files/read?path=a%26hidden%3D1%0A');
    // Also when a secret is there and the row is the masked view: its marks stay escaped.
    const key = `sk-ant-${'Q7x9Kp2L'.repeat(3)}`;
    expect(t(`/api/files/x%3Fpath%3D1%E2%80%AE${encodeURIComponent(key)}`)).toBe('/api/files/x%3Fpath%3D1%E2%80%AE***Kp2L');
  });

  it('keeps an id readable', () => {
    expect(requestPathTarget(new URL('http://h/api/files/M%C3%A4rz%20Bericht.pdf').pathname)).toBe('/api/files/März Bericht.pdf');
    expect(requestPathTarget('/api/files/read', [['path', 'notes/März Bericht.pdf']])).toBe('/api/files/read?path=notes/März Bericht.pdf');
  });
});


describe('requestOutcomePhase', () => {
  it('reads a request\'s outcome from its status: 2xx done, other answers below 500 refused, 5xx or none failed', () => {
    const cases: Array<[number, string]> = [
      [200, 'done'], [204, 'done'], [299, 'done'],
      [101, 'refused'], [199, 'refused'], [300, 'refused'], [302, 'refused'], [400, 'refused'], [404, 'refused'], [499, 'refused'],
      [500, 'failed'], [503, 'failed'], [0, 'failed'],
    ];
    expect(cases.map(([status]) => [status, requestOutcomePhase(status)])).toEqual(cases);
  });
});

describe('what a tool call reads outside the instance (ToolEntry.outwardRead)', () => {
  const noAuth = (): null => null;
  const mail = {} as MailRegistry;
  const provider = { name: 'test', search: async () => [] } as unknown as SearchProvider;
  const tools: Array<ToolEntry<never>> = [
    httpRequestTool, apiSetupTool, createWebSearchTool(provider), calendarReadTool,
    createSheetsTool(noAuth), createDocsTool(noAuth), createDriveTool(noAuth), createCalendarTool(noAuth),
    createMailReadTool(mail), createMailSearchTool(mail), createMailTriageTool(mail), createMailReplyTool(mail), createMailSendTool(mail),
  ] as unknown as Array<ToolEntry<never>>;
  const target = (name: string, input: Record<string, unknown>): string | null => {
    const t = tools.find(x => x.definition.name === name)!;
    return t.outwardRead ? t.outwardRead(input as never) : null;
  };
  const SECRET_TEXT = 'Customer Muster AG';

  it('names an http read by method, host and path, and leaves a write to its own row', () => {
    expect(target('http_request', { url: 'https://u:p@api.example.invalid/v1/a?q=x#f' })).toBe('GET api.example.invalid/v1/a');
    expect(target('http_request', { url: 'https://api.example.invalid/v1/a', method: 'HEAD' })).toBe('HEAD api.example.invalid/v1/a');
    expect(target('http_request', { url: 'https://api.example.invalid/v1/a', method: 'POST' })).toBeNull();
    expect(target('http_request', { url: 'https://api.example.invalid/?_method=PUT' }), 'a GET that names a write is a write').toBeNull();
  });

  it('names the page api_setup bootstraps from, and nothing for its other actions', () => {
    expect(target('api_setup', { action: 'bootstrap', docs_url: 'https://docs.example.invalid/api?x=1' })).toBe('GET docs.example.invalid/api');
    expect(target('api_setup', { action: 'bootstrap', openapi_url: 'https://docs.example.invalid/openapi.json' })).toBe('GET docs.example.invalid/openapi.json');
    expect(target('api_setup', { action: 'bootstrap', docs_url: 'https://a.example.invalid/d', openapi_url: 'https://b.example.invalid/o' }), 'the docs page first, as the handler').toBe('GET a.example.invalid/d');
    expect(target('api_setup', { action: 'list' })).toBeNull();
    expect(target('api_setup', { action: 'fetch_token' })).toBeNull();
  });

  it('names a page web_research reads, and only that it searched — never the search text', () => {
    expect(target('web_research', { action: 'read', url: 'https://news.example.invalid/a?ref=x' })).toBe('GET news.example.invalid/a');
    expect(target('web_research', { action: 'search', query: SECRET_TEXT })).toBe('search');
  });

  it('names mailboxes and messages, never what was searched for', () => {
    expect(target('mail_read', { account: 'work', folder: 'INBOX', uid: 7 })).toBe('account=work folder=INBOX uid=7');
    expect(target('mail_reply', { uid: 7, body: SECRET_TEXT })).toBe('uid=7');
    expect(target('mail_search', { account: 'work', text: SECRET_TEXT, from: SECRET_TEXT, subject: SECRET_TEXT })).toBe('search account=work');
    expect(target('mail_search', { text: SECRET_TEXT })).toBe('search');
    expect(target('mail_triage', { account: 'work', folder: 'INBOX' })).toBe('list account=work folder=INBOX');
    expect(target('mail_send', { to: 'x@example.invalid' }), 'a send reads no third party\'s data').toBeNull();
  });

  it('names Google reads by action and id — a drive search without its query — and leaves writes to their rows', () => {
    expect(target('google_calendar', { action: 'list_events' })).toBe('list_events calendar=primary');
    expect(target('google_calendar', { action: 'free_busy', calendars: ['a@example.invalid', 'b@example.invalid'] })).toBe('free_busy calendars=a@example.invalid,b@example.invalid');
    expect(target('google_calendar', { action: 'create_event' })).toBeNull();
    expect(target('google_docs', { action: 'read', document_id: 'd1' })).toBe('read document=d1');
    expect(target('google_docs', { action: 'append', document_id: 'd1', content: SECRET_TEXT }), 'append reads the document first').toBe('append document=d1');
    expect(target('google_docs', { action: 'replace', document_id: 'd1' })).toBeNull();
    expect(target('google_drive', { action: 'search', query: SECRET_TEXT })).toBe('search');
    expect(target('google_drive', { action: 'read', file_id: 'f1' })).toBe('read file=f1');
    expect(target('google_drive', { action: 'list', folder_id: 'p1' })).toBe('list folder=p1');
    expect(target('google_drive', { action: 'move', file_id: 'f1' }), 'move reads the folders first').toBe('move file=f1');
    expect(target('google_drive', { action: 'share', file_id: 'f1' })).toBeNull();
    expect(target('google_sheets', { action: 'read', spreadsheet_id: 's1', range: 'A1:B2' })).toBe('read spreadsheet=s1 range=A1:B2');
    expect(target('google_sheets', { action: 'list' })).toBe('list');
    expect(target('google_sheets', { action: 'write' })).toBeNull();
  });

  it('names a subscribed calendar by its label, never its address', () => {
    expect(target('calendar_read', { calendar: 'work' })).toBe('calendar=work');
    expect(target('calendar_read', {})).toBe('calendar=all');
  });
});

describe('namedTarget', () => {
  it('writes name=value pairs, leaves an absent value out, and lets no value add a pair or pose as a query', () => {
    expect(namedTarget([['a', 'x'], ['b', undefined], ['c', 3]])).toBe('a=x c=3');
    expect(namedTarget([['folder', 'In box?x=1&y=2\n#z']])).toBe('folder=In box%3Fx%3D1%26y%3D2%0A%23z');
    expect(namedTarget([['folder', 'x uid=9']]), 'a space does not start a pair').toBe('folder=x uid%3D9');
  });
});

describe('outwardReadRecorder and delegatedRedirects', () => {
  const MANDATE_P: RequestPrincipal = { kind: 'mandate', email: 'r@example.invalid', mandateId: 'M1' };
  type Rec = { principal: unknown; action: string; target?: string; phase: string; runId?: string };
  const log = (recs: Rec[]): AuditLog => ({ record: (e: Rec) => { recs.push(e); } }) as unknown as AuditLog;

  it('records a read under the principal and run it was made for, and nothing for the owner', () => {
    const recs: Rec[] = [];
    outwardReadRecorder({ principal: MANDATE_P, currentRunId: 'run-1', toolContext: { auditLog: log(recs) } }, 'x:read')!('GET h/p');
    expect(recs).toEqual([expect.objectContaining({ principal: MANDATE_P, action: 'x:read', target: 'GET h/p', phase: 'read', runId: 'run-1' })]);
    expect(outwardReadRecorder({ principal: OWNER_PRINCIPAL, toolContext: { auditLog: log(recs) } }, 'x:read')).toBeNull();
  });

  it('throws when the row cannot be written: no log, or one that throws', () => {
    const none = outwardReadRecorder({ principal: MANDATE_P, toolContext: { auditLog: null } }, 'x:read')!;
    expect(() => none('t')).toThrow(OutwardReadUnrecorded);
    const broken = outwardReadRecorder({ principal: MANDATE_P, toolContext: { auditLog: { record: () => { throw new Error('disk'); } } as unknown as AuditLog } }, 'x:read')!;
    expect(() => broken('t')).toThrow(OutwardReadUnrecorded);
  });

  it('records each redirect hop as a read, refuses one that keeps a write, and is nothing for the owner', () => {
    const seen: string[] = [];
    const hop = delegatedRedirects((t) => { seen.push(t); })!;
    hop('https://other.example.invalid/next?q=1', 'GET');
    expect(seen).toEqual(['GET other.example.invalid/next']);
    expect(() => hop('https://other.example.invalid/x', 'PUT')).toThrow(/not followed in a delegated session/);
    expect(seen, 'the refused hop wrote no row').toHaveLength(1);
    expect(delegatedRedirects(null)).toBeUndefined();
  });
});
