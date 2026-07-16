import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { SubjectStore } from './subject-store.js';
import { KnowledgeStore, BlockOverLimitError, BlockEditError, MAX_KNOWLEDGE_ENTRY_CHARS } from './knowledge-store.js';
import { channels } from './observability.js';
import { MEMORY_BLOCK_CHAR_LIMITS } from '../types/memory.js';

describe('KnowledgeStore (Durable Knowledge Substrate — DK.1)', () => {
  const tmpDirs: string[] = [];

  function make(): { ks: KnowledgeStore; subjects: SubjectStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ks-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const subjects = new SubjectStore(engine);
    return { ks: new KnowledgeStore(engine, subjects), subjects, engine };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // ── Tier derivation + routing (D-3/D-6, acceptance §7) ──

  it('a trusted agent write lands active + agent_inferred, subject-linked (H1)', () => {
    const { ks, subjects } = make();
    const r = ks.write({ text: 'ACME renews in March', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    expect(r.status).toBe('active');
    expect(r.tier).toBe('agent_inferred');
    expect(r.subjectId).not.toBeNull();
    // H1: findOrCreate ran deliberately — the subject exists.
    expect(subjects.findCanonical('ACME', 'organization')).not.toBeNull();
  });

  it('a ui write lands user_asserted', () => {
    const { ks } = make();
    const r = ks.write({ text: 'Prefers terse replies', sourceChannel: 'ui', sourceUntrusted: false });
    expect(r.status).toBe('active');
    expect(r.tier).toBe('user_asserted');
  });

  it('an untrusted write ROUTES to pending_review + external_unverified, never drops (H4)', () => {
    const { ks, subjects } = make();
    const r = ks.write({ text: 'ACME IBAN is CHXX', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: true });
    expect(r.status).toBe('pending_review');
    expect(r.tier).toBe('external_unverified');
    // pending_review links by hint, NOT findOrCreate — no minted subject for a maybe-rejected entry.
    expect(r.subjectId).toBeNull();
    expect(subjects.findCanonical('ACME', 'organization')).toBeNull();
    // The row landed (visible in the queue), it was not dropped.
    expect(ks.pendingCount()).toBe(1);
  });

  // ── Decoupling (req 2, acceptance §7): no mint-channel publish ──

  it('write() NEVER publishes channels.memoryStore (the extraction minting channel)', () => {
    const { ks } = make();
    let published = 0;
    const onMsg = (): void => { published++; };
    channels.memoryStore.subscribe(onMsg);
    try {
      ks.write({ text: 'A durable fact', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
      ks.write({ text: 'Another', sourceChannel: 'agent', sourceUntrusted: true });
    } finally {
      channels.memoryStore.unsubscribe(onMsg);
    }
    expect(published).toBe(0);
  });

  // ── Pin invariant (H6) ──

  it('an untrusted/external_unverified write cannot be pinned (H6) even with pin:true', () => {
    const { ks } = make();
    const r = ks.write({ text: 'x', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: true });
    expect(r.pinned).toBe(false);
  });

  it('a trusted write CAN pin', () => {
    const { ks } = make();
    const r = ks.write({ text: 'x', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: false });
    expect(r.pinned).toBe(true);
  });

  it('the v9 CHECK rejects a raw pinned=1 external_unverified row (store invariant, defense in depth)', () => {
    const { engine } = make();
    expect(() => {
      engine.getDb().prepare(`
        INSERT INTO knowledge_entries (id, kind, text, pinned, importance, status, source_type)
        VALUES ('x', 'fact', 'y', 1, 1, 'pending_review', 'external_unverified')
      `).run();
    }).toThrow();
  });

  // ── Read: pending never agent-readable; durability ──

  it('recall renders active only — a pending_review entry is never returned', () => {
    const { ks } = make();
    ks.write({ text: 'ACME secret pending fact', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: true });
    ks.write({ text: 'ACME public active fact', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    const hits = ks.recall({ query: 'ACME fact', subjectName: 'ACME' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toContain('active');
  });

  it('durability: a months-old active entry is never evicted (no trim/TTL path)', () => {
    const { ks, engine } = make();
    const r = ks.write({ text: 'ancient durable fact about ACME', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    engine.getDb().prepare("UPDATE knowledge_entries SET created_at = '2020-01-01T00:00:00Z' WHERE id = ?").run(r.id);
    const hits = ks.recall({ query: 'ancient durable ACME', subjectName: 'ACME' });
    expect(hits.map(h => h.id)).toContain(r.id);
  });

  // ── Retrieval: token overlap + ancestor walk-up (D-4, H3) ──

  it('recall ranks by token overlap and pins first', () => {
    const { ks } = make();
    ks.write({ text: 'ACME uses Stripe for billing', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    ks.write({ text: 'ACME office is in Zurich', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: false });
    const hits = ks.recall({ query: 'which billing provider does ACME use', subjectName: 'ACME' });
    // pinned Zurich entry ranks first (pinned DESC beats overlap), billing entry present.
    expect(hits[0]!.pinned).toBe(true);
    expect(hits.some(h => h.text.includes('Stripe'))).toBe(true);
  });

  it('German tokenization matches accented/compound forms (H3, not the ASCII splitter)', () => {
    const { ks } = make();
    ks.write({ text: 'Kündigung zum März bestätigt', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    const hits = ks.recall({ query: 'Kündigung', subjectName: 'ACME' });
    expect(hits.length).toBe(1);
    // The ASCII tokeniseForSupersede would split "Kündigung" → ["k","ndigung"] and miss.
    expect(KnowledgeStore.tokenize('Kündigung')).toContain('kundigung');
  });

  it('recall walks up the ancestor chain — a project query sees client-level knowledge', () => {
    const { ks, subjects } = make();
    const client = subjects.findOrCreate({ kind: 'organization', name: 'ClientCo' }).id;
    const project = subjects.findOrCreate({ kind: 'organization', name: 'ProjectX' }).id;
    subjects.setParent(project, client);
    // A client-level fact, linked to the parent.
    ks.write({ text: 'ClientCo pays net-30', subjectName: 'ClientCo', sourceChannel: 'agent', sourceUntrusted: false });
    const hits = ks.recall({ query: 'net-30 payment terms', subjectName: 'ProjectX' });
    expect(hits.some(h => h.text.includes('net-30'))).toBe(true);
  });

  // ── Focus derivation (H2-gated) ──

  it('focus is H2-gated: a ghost subject with no active entries renders nothing', () => {
    const { ks, subjects } = make();
    // A ghost subject exists but has NO authored entries.
    subjects.findOrCreate({ kind: 'organization', name: 'GhostCorp' });
    const blocks = ks.renderBlocks({ turnText: 'tell me about GhostCorp please' });
    expect(blocks).toBe('');
  });

  it('focus renders a card for a named subject that HAS a pinned active entry', () => {
    const { ks } = make();
    ks.write({ text: 'ACME renews in March', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: false });
    const blocks = ks.renderBlocks({ turnText: 'what is the status on ACME this quarter?' });
    expect(blocks).toContain('In focus');
    expect(blocks).toContain('ACME');
    expect(blocks).toContain('renews in March');
  });

  it('focus does not fire on a substring-only false match', () => {
    const { ks } = make();
    ks.write({ text: 'note', subjectName: 'AG', pin: true, sourceChannel: 'agent', sourceUntrusted: false });
    // "AGENCY" contains "ag" but must not match the subject "AG" (bounded occurrence).
    const blocks = ks.renderBlocks({ turnText: 'we run a marketing AGENCY' });
    expect(blocks).toBe('');
  });

  // ── Blocks: over-limit loud error + edit semantics ──

  it('profile/playbook blocks round-trip via setBlockContent/getBlock', () => {
    const { ks } = make();
    ks.setBlockContent('profile', 'Operator: Rafael. Firm: brandfusion.');
    expect(ks.getBlock('profile')?.content).toContain('brandfusion');
    const blocks = ks.renderBlocks({ turnText: 'hi' });
    expect(blocks).toContain('Your profile');
  });

  it('over-limit block edit throws a LOUD error, never a silent trim', () => {
    const { ks } = make();
    const tooBig = 'x'.repeat(MEMORY_BLOCK_CHAR_LIMITS.profile + 1);
    expect(() => ks.setBlockContent('profile', tooBig)).toThrow(BlockOverLimitError);
  });

  it('replace/remove refuse an empty old_text; append needs new_text', () => {
    const { ks } = make();
    ks.setBlockContent('playbook', 'Rule A\nRule B');
    expect(() => ks.editBlock('playbook', 'replace', '', 'new')).toThrow(BlockEditError);
    expect(() => ks.editBlock('playbook', 'append', undefined, '  ')).toThrow(BlockEditError);
    ks.editBlock('playbook', 'append', undefined, 'Rule C');
    expect(ks.getBlock('playbook')?.content).toBe('Rule A\nRule B\nRule C');
    ks.editBlock('playbook', 'replace', 'Rule A', 'Rule A+');
    expect(ks.getBlock('playbook')?.content).toContain('Rule A+');
    ks.editBlock('playbook', 'remove', 'Rule B\n', undefined);
    expect(ks.getBlock('playbook')?.content).not.toContain('Rule B');
  });

  it('editBlock refuses a substring that is not present', () => {
    const { ks } = make();
    ks.setBlockContent('profile', 'hello');
    expect(() => ks.editBlock('profile', 'replace', 'missing', 'x')).toThrow(BlockEditError);
  });

  // ── Cross-client isolation + render masking (review fixes) ──

  it('recall scoped to an UNKNOWN subject returns nothing — never a global cross-client scan', () => {
    const { ks } = make();
    ks.write({ text: 'ClientB pays via Stripe', subjectName: 'ClientB', sourceChannel: 'agent', sourceUntrusted: false });
    // A query the agent explicitly scoped to ClientA, which has no subject/entries.
    const hits = ks.recall({ query: 'how does the client pay', subjectName: 'ClientA' });
    expect(hits).toEqual([]); // must NOT leak ClientB's Stripe fact
  });

  it('renderBlocks masks a secret-shaped token in a block (H7 render, defense in depth)', () => {
    const { ks } = make();
    ks.setBlockContent('playbook', 'The deploy token is Bearer abcdefghij1234567890abcd');
    const blocks = ks.renderBlocks({ turnText: 'hi' });
    expect(blocks).not.toContain('abcdefghij1234567890abcd');
    expect(blocks).toContain('***');
  });

  it('write() throws on an over-limit entry (store-level size backstop)', () => {
    const { ks } = make();
    expect(() =>
      ks.write({ text: 'x'.repeat(MAX_KNOWLEDGE_ENTRY_CHARS + 1), sourceChannel: 'agent', sourceUntrusted: false }),
    ).toThrow();
  });
});
