import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { TriggerStore, type TriggerRow } from './trigger-store.js';
import { OWNER_PRINCIPAL, ownerInstructionCounts, type RequestPrincipal } from './request-principal.js';

/**
 * A trigger's instruction counts as the owner's words only when the owner set it up, no turn that
 * had read outside content created or rewrote it, and no mandate ever changed it: a mark that
 * neither the owner's later edit nor a confirmation takes back.
 */

const MANDATE: RequestPrincipal = { kind: 'mandate', email: 'helper@example.invalid', mandateId: 'm-1' };

describe('ownerInstructionCounts', () => {
  const clean = { created_by: 'owner', created_untrusted: 'none', edited_by: 'owner', mandate_editor: undefined };

  it('counts for a trigger the owner set up and nobody else changed', () => {
    expect(ownerInstructionCounts(clean)).toBe(true);
    expect(ownerInstructionCounts({ created_by: 'owner' })).toBe(true);
  });

  it.each([
    ['created by a mandate', { ...clean, created_by: 'mandate:helper@example.invalid' }],
    ['created before creators were recorded', { ...clean, created_by: undefined }],
    ['created or rewritten after outside content', { ...clean, created_untrusted: 'marker' }],
    ['an unknown untrusted value', { ...clean, created_untrusted: 'something' }],
    ['changed by a mandate', { ...clean, mandate_editor: 'mandate:helper@example.invalid' }],
    ['last changed by someone else', { ...clean, edited_by: 'mandate:helper@example.invalid' }],
  ])('does not count when %s', (_why, t) => {
    expect(ownerInstructionCounts(t)).toBe(false);
  });
});

describe('the marks the rule reads survive the owner\'s edit and confirmation', () => {
  const dirs: string[] = [];
  const engines: EngineDb[] = [];
  afterEach(() => {
    for (const e of engines) { try { e.close(); } catch { /* closed */ } }
    engines.length = 0;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  function make(): TriggerStore {
    const dir = mkdtempSync(join(tmpdir(), 'lynox-owner-instr-'));
    dirs.push(dir);
    const engine = new EngineDb(join(dir, 'engine.db'), '');
    engines.push(engine);
    return new TriggerStore(engine);
  }

  const row = (over: Partial<TriggerRow> = {}): TriggerRow => ({
    id: 't1', title: 'Bericht', description: 'an buchhaltung@firma.ch', source: 'cron', effect: 'run_agent',
    conditionJson: JSON.stringify({ schedule_cron: '0 9 * * 1', watch_config: null }), paramsJson: '{}',
    status: 'open', enabled: true, retryCount: 0, createdBy: 'owner', ...over,
  });

  it('CONTROL: the owner\'s own trigger counts, and after the owner\'s edit and confirmation still does', () => {
    const store = make();
    store.upsert(row());
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(true);
    store.markEditedBy('t1', OWNER_PRINCIPAL, false);
    store.updateFields('t1', { description: 'an buchhaltung@firma.ch, montags' });
    store.setConfirmedAt('t1', '2026-11-18T08:00:00.000Z', 'owner');
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(true);
  });

  it('a mandate\'s edit stays a mark after the owner edits and confirms the trigger', () => {
    const store = make();
    store.upsert(row());
    store.markEditedBy('t1', MANDATE, true);
    store.updateFields('t1', { description: 'an x@evil.example' });
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(false);
    store.markEditedBy('t1', OWNER_PRINCIPAL, false);
    store.updateFields('t1', { title: 'Bericht neu' });
    store.setConfirmedAt('t1', '2026-11-18T08:00:00.000Z', 'owner');
    const after = store.getById('t1')!;
    expect(after.edited_by).toBe('owner');
    expect(after.mandate_editor).toBe('mandate:helper@example.invalid');
    expect(ownerInstructionCounts(after)).toBe(false);
  });

  it('an edit in a turn that had read outside content stays a mark after a clean edit', () => {
    const store = make();
    store.upsert(row());
    store.updateFields('t1', { description: 'an x@evil.example', editedUntrusted: 'marker' });
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(false);
    store.updateFields('t1', { description: 'an buchhaltung@firma.ch' });
    expect(store.getById('t1')!.created_untrusted).toBe('marker');
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(false);
  });

  it('an edit after outside content marks a trigger that was set up clean', () => {
    const store = make();
    store.upsert(row({ createdUntrusted: 'none' }));
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(true);
    store.updateFields('t1', { description: 'an x@evil.example', editedUntrusted: 'marker' });
    expect(store.getById('t1')!.created_untrusted).toBe('marker');
    expect(ownerInstructionCounts(store.getById('t1')!)).toBe(false);
  });
});
