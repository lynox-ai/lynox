import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore } from '../../core/data-store.js';
import { CRM } from '../../core/crm.js';
import { createToolContext } from '../../core/tool-context.js';
import { InboxContactResolver } from '../../integrations/inbox/contact-resolver.js';
import { contactsSaveTool, contactsSearchTool } from './contacts.js';
import type { IAgent } from '../../types/index.js';

const mockAgent = {
  toolContext: createToolContext({}),
} as unknown as IAgent;

describe('contacts tools', () => {
  let tmpDir: string;
  let ds: DataStore;
  let crm: CRM;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'lynox-contacts-tool-test-'));
    ds = new DataStore(join(tmpDir, 'datastore.db'));
    crm = new CRM(ds);
    crm.ensureSchema();
    mockAgent.toolContext.crm = crm;
  });

  afterEach(() => {
    mockAgent.toolContext.crm = null;
    try { ds.close(); } catch { /* ok */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── D4: saving a contact is NOT a confirmation-gated write ──
  it('contacts_save does not require confirmation (D4 — visible in transcript, no gate)', () => {
    expect(contactsSaveTool.requiresConfirmation).toBeFalsy();
    expect(contactsSearchTool.requiresConfirmation).toBeFalsy();
  });

  describe('contacts_save', () => {
    it('creates a new contact that the inbox resolver then finds (scope round-trip)', async () => {
      const result = await contactsSaveTool.handler(
        { name: 'Dana', email: 'dana@acme.com', company: 'Acme' },
        mockAgent,
      );
      expect(result).toContain('Saved contact');

      // The dedicated tool wrote into the global CRM scope — the inbox
      // reading-pane sidebar (contact-resolver) reads exactly that scope.
      const resolver = new InboxContactResolver(crm);
      const resolved = resolver.resolve('dana@acme.com');
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('Dana');
      expect(resolved!.company).toBe('Acme');
    });

    it('updates an existing email instead of duplicating (different display name)', async () => {
      await contactsSaveTool.handler({ name: 'Erin', email: 'erin@x.com' }, mockAgent);
      await contactsSaveTool.handler({ name: 'Erin Doe', email: 'erin@x.com', company: 'Globex' }, mockAgent);

      const rows = crm.listContacts({ email: 'erin@x.com' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Erin Doe');
      expect(rows[0]!.company).toBe('Globex');
    });

    it('normalises the email on write so the lower-cased resolver lookup hits', async () => {
      await contactsSaveTool.handler({ name: 'Frank', email: 'Frank@Example.COM' }, mockAgent);
      const resolved = new InboxContactResolver(crm).resolve('frank@example.com');
      expect(resolved).not.toBeNull();
      expect(resolved!.email).toBe('frank@example.com');
    });

    it('keeps same-name / different-email people distinct', async () => {
      await contactsSaveTool.handler({ name: 'Sam', email: 'sam1@x.com' }, mockAgent);
      await contactsSaveTool.handler({ name: 'Sam', email: 'sam2@x.com' }, mockAgent);
      expect(crm.listContacts({ name: 'Sam' })).toHaveLength(2);
    });

    it('rejects a missing name', async () => {
      const result = await contactsSaveTool.handler({ name: '   ' }, mockAgent);
      expect(result).toContain('error');
      expect(crm.listContacts()).toHaveLength(0);
    });

    it('degrades gracefully when no CRM is wired', async () => {
      mockAgent.toolContext.crm = null;
      const result = await contactsSaveTool.handler({ name: 'Nobody', email: 'n@x.com' }, mockAgent);
      expect(result).toContain('not available');
    });
  });

  describe('contacts_search', () => {
    beforeEach(async () => {
      await contactsSaveTool.handler({ name: 'Grace Hopper', email: 'grace@navy.mil', company: 'US Navy' }, mockAgent);
      await contactsSaveTool.handler({ name: 'Alan Turing', email: 'alan@bletchley.uk', company: 'GC&CS' }, mockAgent);
    });

    it('finds an exact email (the dedup-check path)', async () => {
      const result = await contactsSearchTool.handler({ email: 'grace@navy.mil' }, mockAgent);
      expect(result).toContain('Grace Hopper');
      expect(result).not.toContain('Alan Turing');
    });

    it('reports no match for an unknown email', async () => {
      const result = await contactsSearchTool.handler({ email: 'ghost@nowhere.io' }, mockAgent);
      expect(result.toLowerCase()).toContain('no contact');
    });

    it('free-text query matches across name, email, and company', async () => {
      const byName = await contactsSearchTool.handler({ query: 'Turing' }, mockAgent);
      expect(byName).toContain('Alan Turing');
      expect(byName).not.toContain('Grace Hopper');

      const byCompany = await contactsSearchTool.handler({ query: 'Navy' }, mockAgent);
      expect(byCompany).toContain('Grace Hopper');
    });

    it('returns recent contacts with no arguments', async () => {
      const result = await contactsSearchTool.handler({}, mockAgent);
      expect(result).toContain('Grace Hopper');
      expect(result).toContain('Alan Turing');
    });

    it('degrades gracefully when no CRM is wired', async () => {
      mockAgent.toolContext.crm = null;
      const result = await contactsSearchTool.handler({ query: 'anything' }, mockAgent);
      expect(result).toContain('not available');
    });
  });
});
