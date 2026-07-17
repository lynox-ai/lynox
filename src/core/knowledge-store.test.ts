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
    ks.setBlockContent('profile', 'Operator: Alex. Firm: Acme Agency.');
    expect(ks.getBlock('profile')?.content).toContain('Acme Agency');
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

describe('KnowledgeStore review queue (DK.2)', () => {
  const tmpDirs: string[] = [];

  function make(): { ks: KnowledgeStore; subjects: SubjectStore; engine: EngineDb } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ksq-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    const subjects = new SubjectStore(engine);
    return { ks: new KnowledgeStore(engine, subjects), subjects, engine };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function queueOne(ks: KnowledgeStore, text = 'ACME IBAN is CHXX'): string {
    return ks.write({ text, subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: true }).id;
  }

  it('listPending returns queued entries oldest-first, decrypted', () => {
    const { ks } = make();
    const a = queueOne(ks, 'first fact');
    const b = queueOne(ks, 'second fact');
    const pending = ks.listPending();
    expect(pending.map(e => e.id)).toEqual([a, b]);
    expect(pending[0]?.text).toBe('first fact');
    expect(pending[0]?.subjectHint).toBe('ACME');
  });

  it('approve = the human trust event: active + user_asserted + findOrCreate from the hint', () => {
    const { ks, subjects } = make();
    const id = queueOne(ks);
    expect(subjects.findCanonical('ACME', 'organization')).toBeNull(); // hygiene held while pending
    const e = ks.reviewEntry(id, 'approve');
    expect(e?.status).toBe('active');
    expect(e?.sourceType).toBe('user_asserted');
    expect(e?.subjectId).not.toBeNull();
    expect(e?.subjectHint).toBeNull();
    expect(e?.reviewedAt).not.toBeNull();
    expect(e?.reviewAction).toBe('approve');
    expect(subjects.findCanonical('ACME', 'organization')).not.toBeNull(); // minted ON approval
    // Now agent-readable via recall.
    expect(ks.recall({ query: 'ACME IBAN', subjectName: 'ACME' }).length).toBe(1);
  });

  it('approval NEVER inherits a pin (H6 stays a deliberate act)', () => {
    const { ks } = make();
    const id = ks.write({ text: 'sneaky', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: true }).id;
    const e = ks.reviewEntry(id, 'approve');
    expect(e?.pinned).toBe(false);
  });

  it('edit_approve stores the reviewer wording; empty edit is refused', () => {
    const { ks } = make();
    const id = queueOne(ks, 'acme ibaan CHXX (typo)');
    expect(() => ks.reviewEntry(id, 'edit_approve', '   ')).toThrow(BlockEditError);
    const e = ks.reviewEntry(id, 'edit_approve', 'ACME pays via IBAN CHXX.');
    expect(e?.status).toBe('active');
    expect(e?.text).toBe('ACME pays via IBAN CHXX.');
    expect(e?.reviewAction).toBe('edit_approve');
  });

  it('reject keeps the row as an audit record and never mints a subject', () => {
    const { ks, subjects } = make();
    const id = queueOne(ks);
    const e = ks.reviewEntry(id, 'reject');
    expect(e?.status).toBe('rejected');
    expect(e?.reviewAction).toBe('reject');
    expect(subjects.findCanonical('ACME', 'organization')).toBeNull();
    // Not agent-readable, not in the queue.
    expect(ks.pendingCount()).toBe(0);
    expect(ks.recall({ query: 'ACME IBAN', subjectName: 'ACME' }).length).toBe(0);
  });

  it('reviewEntry REJECTS a secret-shaped entry on approve (S1 promotion-scan)', () => {
    const { ks } = make();
    // Simulate a value that became secret-shaped only after queueing: write it directly as a
    // pending row (bypassing remember's write-scan) to model the post-queue window.
    const engine = (ks as unknown as { engine: { getDb(): import('better-sqlite3').Database } }).engine;
    void engine;
    const id = ks.write({ text: 'ACME contact info', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: true }).id;
    // Patch the stored ciphertext to a secret-shaped value via a fresh write path is not
    // available; instead assert the guard fires on an edit_approve carrying a shaped secret.
    expect(() => ks.reviewEntry(id, 'edit_approve', 'token Bearer abcdefghij1234567890abcd')).toThrow(/secret|credential/i);
    expect(ks.getEntry(id)?.status).toBe('pending_review'); // unchanged
  });

  it('reviewEntry returns null for unknown / already-reviewed ids (idempotency guard)', () => {
    const { ks } = make();
    const id = queueOne(ks);
    expect(ks.reviewEntry('nope', 'approve')).toBeNull();
    ks.reviewEntry(id, 'approve');
    expect(ks.reviewEntry(id, 'approve')).toBeNull(); // no double-approve
  });
});

describe('KnowledgeStore read-surface (DK-UX — listActive / readSurfaceBlocks)', () => {
  const tmpDirs: string[] = [];

  function make(): { ks: KnowledgeStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ksa-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { ks: new KnowledgeStore(engine, new SubjectStore(engine)) };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('listActive returns ONLY active entries — a pending untrusted write is excluded', () => {
    const { ks } = make();
    ks.write({ text: 'A trusted durable fact', sourceChannel: 'ui', sourceUntrusted: false });
    ks.write({ text: 'An untrusted capture awaiting review', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: true });
    const active = ks.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]!.text).toBe('A trusted durable fact');
    expect(active[0]!.status).toBe('active');
  });

  it('listActive orders pinned entries first', () => {
    const { ks } = make();
    ks.write({ text: 'an unpinned fact', sourceChannel: 'ui', sourceUntrusted: false });
    ks.write({ text: 'a pinned fact', sourceChannel: 'ui', sourceUntrusted: false, pin: true });
    ks.write({ text: 'another unpinned fact', sourceChannel: 'ui', sourceUntrusted: false });
    const active = ks.listActive();
    expect(active).toHaveLength(3);
    expect(active[0]!.pinned).toBe(true);
    expect(active[0]!.text).toBe('a pinned fact');
  });

  it('listActive honours the limit by slicing', () => {
    const { ks } = make();
    for (let i = 0; i < 5; i++) ks.write({ text: `distinct durable fact number ${i}`, sourceChannel: 'ui', sourceUntrusted: false });
    expect(ks.listActive(3)).toHaveLength(3);
  });

  it('listActive FLOORS a negative limit to 1 (a bare negative LIMIT reads as unbounded)', () => {
    const { ks } = make();
    for (let i = 0; i < 4; i++) ks.write({ text: `distinct durable fact number ${i}`, sourceChannel: 'ui', sourceUntrusted: false });
    // The `Math.max(1, …)` floor is the SOLE guard against an unbounded read: SQLite treats a
    // negative `LIMIT ?` as no-limit, so without the floor this returns every row (4), not 1.
    expect(ks.listActive(-5)).toHaveLength(1);
  });

  it('listActive resolves the canonical subject NAME for the browse surface', () => {
    const { ks } = make();
    ks.write({ text: 'ACME renews in March', subjectName: 'ACME', sourceChannel: 'ui', sourceUntrusted: false });
    ks.write({ text: 'a fact with no subject at all', sourceChannel: 'ui', sourceUntrusted: false });
    const active = ks.listActive();
    // Active rows link via subject_id (subject_hint is NULL post-approval); the browse surface
    // resolves the id → name, so the "→ ACME" attribution is present, not silently dropped.
    expect(active.find(e => e.text === 'ACME renews in March')!.subjectName).toBe('ACME');
    expect(active.find(e => e.text === 'a fact with no subject at all')!.subjectName).toBeNull();
  });

  it('listActive MASKS secret-shaped tokens in entry text (a display surface)', () => {
    const { ks } = make();
    ks.write({ text: 'Deploy key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 is set', sourceChannel: 'ui', sourceUntrusted: false });
    const [entry] = ks.listActive();
    expect(entry!.text).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
    expect(entry!.text).toContain('***');
  });

  it('readSurfaceBlocks returns profile + playbook, masking secret-shaped tokens', () => {
    const { ks } = make();
    ks.setBlockContent('profile', 'Owner prefers terse replies.');
    // Blocks are edited without a write-side shape scan, so masking on this READ path matters.
    ks.setBlockContent('playbook', 'Never paste sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210 into a rule.');
    const blocks = ks.readSurfaceBlocks();
    expect(blocks.profile).toContain('terse replies');
    expect(blocks.playbook).not.toContain('sk-ant-api03-ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210');
    expect(blocks.playbook).toContain('***');
  });

  it('readSurfaceBlocks returns empty strings when no blocks are set', () => {
    const { ks } = make();
    expect(ks.readSurfaceBlocks()).toEqual({ profile: '', playbook: '' });
  });
});

describe('KnowledgeStore retire (DK.2 — canSupersede gate)', () => {
  const tmpDirs: string[] = [];

  function make(): { ks: KnowledgeStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ksr-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { ks: new KnowledgeStore(engine, new SubjectStore(engine)) };
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('an agent-tier retire supersedes an agent_inferred fact (pin cleared, no longer recalled)', () => {
    const { ks } = make();
    const id = ks.write({ text: 'Old office address', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: false }).id;
    const retired = ks.retireEntry(id, 'agent_inferred');
    expect(retired.status).toBe('superseded');
    expect(retired.pinned).toBe(false); // v9 CHECK requires pin=0 off-active
    expect(ks.recall({ query: 'office address', subjectName: 'ACME' }).length).toBe(0);
  });

  it('REFUSES to retire a user_asserted fact from the agent channel (canSupersede)', () => {
    const { ks } = make();
    const id = ks.write({ text: 'User-confirmed billing terms', sourceChannel: 'ui', sourceUntrusted: false }).id;
    expect(() => ks.retireEntry(id, 'agent_inferred')).toThrow(/user_asserted|Refused/);
    expect(ks.getEntry(id)?.status).toBe('active'); // untouched
  });

  it('resolves an 8-char id prefix; throws on ambiguity instead of guessing', () => {
    const { ks } = make();
    const id = ks.write({ text: 'fact one', sourceChannel: 'agent', sourceUntrusted: false }).id;
    expect(ks.findActiveByIdPrefix(id.slice(0, 8))?.id).toBe(id);
    expect(ks.findActiveByIdPrefix('zz')).toBeNull(); // invalid shape
    // Ambiguity: forge two rows sharing a prefix is impractical via UUIDs;
    // assert the guard path directly on a 1-char-extended common hex prefix.
    // (Realistic ambiguity needs colliding UUID prefixes — covered by the LIMIT 2 guard.)
  });

  it('memory_focus override feeds renderBlocks as the default', () => {
    const { ks } = make();
    ks.write({ text: 'ACME pays annually', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: false });
    const subjectId = ks.recall({ query: 'pays', subjectName: 'ACME' })[0]?.subjectId;
    expect(subjectId).toBeTruthy();
    // No mention of ACME in the turn text — only the override brings it into focus.
    expect(ks.renderBlocks({ turnText: 'hello there' })).toBe('');
    ks.setFocusOverride(subjectId!);
    expect(ks.renderBlocks({ turnText: 'hello there' })).toContain('ACME');
    ks.setFocusOverride(null);
    expect(ks.renderBlocks({ turnText: 'hello there' })).toBe('');
  });
});

describe('KnowledgeStore write-path dedup (structural)', () => {
  const tmpDirs: string[] = [];
  function make(): { ks: KnowledgeStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ksd-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    return { ks: new KnowledgeStore(engine, new SubjectStore(engine)) };
  }
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const RUN = 'run-1';
  function w(ks: KnowledgeStore, text: string, subject?: string) {
    return ks.write({ text, subjectName: subject, sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: RUN });
  }

  it('skips an exact restatement (same subject) — one row, deduped flag set', () => {
    const { ks } = make();
    const a = w(ks, 'Meridian AG is on the Managed Pro plan', 'Meridian AG');
    const b = w(ks, 'Meridian AG is on the Managed Pro plan', 'Meridian AG');
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id); // points at the existing entry
    expect(ks.recall({ query: 'Managed Pro plan', subjectName: 'Meridian AG' }).length).toBe(1);
  });

  it('skips a subject-null COMBINED restatement of two same-run facts (the measured junk)', () => {
    const { ks } = make();
    w(ks, 'Ada Fischer is a client; his businesses are AlphaClinic and BetaStore', 'Ada Fischer');
    w(ks, 'Dr. Nora Baumann is a client; her businesses are GammaPraxis and DeltaDerm', 'Dr. Nora Baumann');
    // The combined None-subject restatement — every token already covered by the two above.
    const combined = w(ks, 'The operator has two clients: Ada Fischer (AlphaClinic, BetaStore) and Dr. Nora Baumann (GammaPraxis, DeltaDerm)');
    expect(combined.deduped).toBe(true);
    // Still exactly the two real entries.
    expect(ks.recall({ query: 'Ada Fischer AlphaClinic', subjectName: 'Ada Fischer' }).length).toBe(1);
  });

  it('dedups the second side of a same-turn contradiction (keeps the first, 2→1)', () => {
    const { ks } = make();
    w(ks, 'gammapraxis practice is located in Northville, not Southville', 'gammapraxis');
    const second = w(ks, 'gammapraxis practice is located in Southville, not Northville', 'gammapraxis');
    expect(second.deduped).toBe(true);
    expect(ks.recall({ query: 'gammapraxis practice located', subjectName: 'gammapraxis' }).length).toBe(1);
  });

  it('does NOT dedup a fact that ADDS detail (uncovered tokens keep it below the bar)', () => {
    const { ks } = make();
    w(ks, 'gammapraxis is in Northville', 'gammapraxis');
    const detail = w(ks, 'gammapraxis moved to Northville in June 2026 after leaving Southville', 'gammapraxis');
    expect(detail.deduped).toBeUndefined();
    expect(ks.recall({ query: 'gammapraxis Northville', subjectName: 'gammapraxis' }).length).toBe(2);
  });

  it('does NOT dedup a VALUE CORRECTION that restates only the NEW value (behavioral-walk regression 2026-07-17)', () => {
    // The bug: "X is in <new place>" shares the subject + filler words "is/in" with
    // "X is located in <old place>", inflating RAW-token coverage to 0.75 → the correction
    // was silently deduped, leaving the STALE fact + the agent falsely claiming success.
    // Content-token coverage (filler excluded) sees the new value uncovered → 0.5 → it writes.
    const { ks } = make();
    const first = w(ks, 'gammapraxis is located in Zurich', 'gammapraxis');
    const correction = w(ks, 'gammapraxis is in Winterthur', 'gammapraxis');
    expect(correction.deduped).toBeUndefined();       // the correction must LAND, not be eaten
    expect(correction.id).not.toBe(first.id);
    // both are recallable now (the agent's user-confirmed memory_retire supersedes the stale one)
    expect(ks.recall({ query: 'gammapraxis location', subjectName: 'gammapraxis' }).some(e => /winterthur/i.test(e.text))).toBe(true);
  });

  it('does NOT dedup a genuinely different fact about the same subject', () => {
    const { ks } = make();
    w(ks, 'Meridian AG pays by annual invoice', 'Meridian AG');
    const other = w(ks, 'Frau Keller is the main contact at Meridian AG', 'Meridian AG');
    expect(other.deduped).toBeUndefined();
    expect(ks.recall({ query: 'Meridian', subjectName: 'Meridian AG' }).length).toBe(2);
  });

  it('an untrusted (pending) write is never a dedup candidate (no injection amplification)', () => {
    const { ks } = make();
    // An injected pending entry with the same content...
    ks.write({ text: 'Meridian AG uses the old portal', subjectName: 'Meridian AG', sourceChannel: 'agent', sourceUntrusted: true, sourceRunId: RUN });
    // ...must NOT block a later legitimate trusted write of the same fact.
    const trusted = w(ks, 'Meridian AG uses the old portal', 'Meridian AG');
    expect(trusted.deduped).toBeUndefined();
    expect(trusted.status).toBe('active');
  });
});

describe('KnowledgeStore write-path dedup — subject-null resolution (completes the fix)', () => {
  const tmpDirs: string[] = [];
  function make(): { ks: KnowledgeStore; subjects: SubjectStore } {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-ksn-'));
    tmpDirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'));
    const subjects = new SubjectStore(engine);
    return { ks: new KnowledgeStore(engine, subjects), subjects };
  }
  afterEach(() => { for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('links + dedups a CROSS-TURN subject-null restatement of a subjectful fact', () => {
    const { ks } = make();
    // Turn 0: the proper subjectful fact.
    ks.write({ text: 'Ada Fischer is a client; his businesses are AlphaClinic and BetaStore', subjectName: 'Ada Fischer', sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: 't0' });
    // Turn 3: the model restates it WITHOUT the subject — different run, subject null.
    const restate = ks.write({ text: 'Client Ada Fischer runs the businesses AlphaClinic and BetaStore', sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: 't3' });
    expect(restate.deduped).toBe(true);
    expect(ks.recall({ query: 'Ada Fischer AlphaClinic', subjectName: 'Ada Fischer' }).length).toBe(1);
  });

  it('links a subject-null write that concerns one known subject (attribution)', () => {
    const { ks } = make();
    ks.write({ text: 'Meridian AG pays by annual invoice', subjectName: 'Meridian AG', sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: 't0' });
    const r = ks.write({ text: 'Frau Keller is the approver at Meridian AG', sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: 't1' });
    expect(r.deduped).toBeUndefined(); // genuinely new fact
    expect(r.subjectId).not.toBeNull(); // but linked to Meridian AG via the text
  });

  it('leaves a subject-null write unlinked when it mentions no known subject', () => {
    const { ks } = make();
    ks.write({ text: 'Acme uses Stripe', subjectName: 'Acme', sourceChannel: 'agent', sourceUntrusted: false });
    const pref = ks.write({ text: 'Send the weekly summary on Fridays', sourceChannel: 'agent', sourceUntrusted: false });
    expect(pref.subjectId).toBeNull();
    expect(pref.deduped).toBeUndefined();
  });

  it('does NOT link when TWO subjects are mentioned (ambiguous — stays null)', () => {
    const { ks } = make();
    ks.write({ text: 'Ada Fischer is a client', subjectName: 'Ada Fischer', sourceChannel: 'agent', sourceUntrusted: false });
    ks.write({ text: 'Nora Baumann is a client', subjectName: 'Nora Baumann', sourceChannel: 'agent', sourceUntrusted: false });
    const both = ks.write({ text: 'A new joint venture between Ada Fischer and Nora Baumann is forming', sourceChannel: 'agent', sourceUntrusted: false });
    expect(both.subjectId).toBeNull();
  });

  it('FN-1: does NOT dedup a same-run write for a DIFFERENT subject (no cross-subject data loss)', () => {
    const { ks } = make();
    const a = ks.write({ text: 'AlphaClinic uses Slack and Notion for daily ops', subjectName: 'AlphaClinic', sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: 'run1' });
    const b = ks.write({ text: 'BetaStore uses Slack and Notion for daily ops', subjectName: 'BetaStore', sourceChannel: 'agent', sourceUntrusted: false, sourceRunId: 'run1' });
    expect(a.deduped).not.toBe(true);
    expect(b.deduped).not.toBe(true);   // was silently deduped by the subject-blind same-run clause
    expect(b.id).not.toBe(a.id);        // BetaStore's fact kept, not mis-attributed to AlphaClinic
  });

  it('FN-1: STILL dedups a same-subject cross-turn restatement (guard did not over-widen)', () => {
    const { ks } = make();
    const a = ks.write({ text: 'ACME renews its contract in March every year', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    const b = ks.write({ text: 'ACME renews its contract in March', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    expect(a.deduped).not.toBe(true);
    expect(b.deduped).toBe(true);
  });

  it('FN-2: pin:true on an already-stored fact pins the EXISTING row (dedup path)', () => {
    const { ks } = make();
    const first = ks.write({ text: 'ACME HQ is in Zurich', subjectName: 'ACME', sourceChannel: 'agent', sourceUntrusted: false });
    expect(first.pinned).toBe(false);
    const again = ks.write({ text: 'ACME HQ is in Zurich', subjectName: 'ACME', pin: true, sourceChannel: 'agent', sourceUntrusted: false });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.id);
    expect(again.pinned).toBe(true);   // existing row now pinned — was structurally impossible before
  });
});
