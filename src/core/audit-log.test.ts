import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineDb } from './engine-db.js';
import { AuditLog, httpTarget } from './audit-log.js';
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
    expect(label('http_request', { url: 'https://a.example.invalid/', method: 'GET', headers: { 'X-HTTP-Method-Override': 'BREW' } }), 'an override that is not a method counts as a write').toBe('OVERRIDE');
  });
});
