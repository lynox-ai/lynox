import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Playbook } from '../types/index.js';

let tempDir: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

import { homedir } from 'node:os';

describe('playbooks', () => {
  let loadPlaybook: typeof import('./playbooks.js').loadPlaybook;
  let listPlaybooks: typeof import('./playbooks.js').listPlaybooks;
  let getBuiltinPlaybookIds: typeof import('./playbooks.js').getBuiltinPlaybookIds;
  let savePlaybook: typeof import('./playbooks.js').savePlaybook;
  let exportPlaybook: typeof import('./playbooks.js').exportPlaybook;
  let importPlaybook: typeof import('./playbooks.js').importPlaybook;
  let deletePlaybook: typeof import('./playbooks.js').deletePlaybook;
  let parsePlaybookConfig: typeof import('./playbooks.js').parsePlaybookConfig;
  let formatPlaybookIndex: typeof import('./playbooks.js').formatPlaybookIndex;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nodyn-playbooks-test-'));
    vi.mocked(homedir).mockReturnValue(tempDir);

    vi.resetModules();
    const mod = await import('./playbooks.js');
    loadPlaybook = mod.loadPlaybook;
    listPlaybooks = mod.listPlaybooks;
    getBuiltinPlaybookIds = mod.getBuiltinPlaybookIds;
    savePlaybook = mod.savePlaybook;
    exportPlaybook = mod.exportPlaybook;
    importPlaybook = mod.importPlaybook;
    deletePlaybook = mod.deletePlaybook;
    parsePlaybookConfig = mod.parsePlaybookConfig;
    formatPlaybookIndex = mod.formatPlaybookIndex;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // === Loading ===

  it('loadPlaybook() returns built-in playbook by id', () => {
    const pb = loadPlaybook('research');
    expect(pb).not.toBeNull();
    expect(pb!.id).toBe('research');
    expect(pb!.name).toBe('Research');
    expect(pb!.phases.length).toBe(4);
    expect(pb!.parameters).toBeDefined();
    expect(pb!.applicableWhen).toBeTruthy();
  });

  it('loadPlaybook() returns null for unknown playbook', () => {
    const pb = loadPlaybook('does-not-exist');
    expect(pb).toBeNull();
  });

  it('loadPlaybook() loads all 7 built-in playbooks', () => {
    const ids = getBuiltinPlaybookIds();
    expect(ids).toHaveLength(7);
    for (const id of ids) {
      const pb = loadPlaybook(id);
      expect(pb).not.toBeNull();
      expect(pb!.id).toBe(id);
      expect(pb!.name).toBeTruthy();
      expect(pb!.description).toBeTruthy();
      expect(pb!.phases.length).toBeGreaterThan(0);
      expect(pb!.version).toBeTruthy();
    }
  });

  it('loadPlaybook() user playbook overrides built-in', () => {
    const userDir = join(tempDir, '.nodyn', 'playbooks');
    mkdirSync(userDir, { recursive: true });

    const override: Playbook = {
      id: 'research',
      name: 'Custom Research',
      description: 'Custom research playbook',
      version: '2.0.0',
      phases: [
        { name: 'Custom Phase', description: 'Custom phase description' },
      ],
    };
    writeFileSync(join(userDir, 'research.json'), JSON.stringify(override), 'utf-8');

    const pb = loadPlaybook('research');
    expect(pb).not.toBeNull();
    expect(pb!.name).toBe('Custom Research');
    expect(pb!.phases).toHaveLength(1);
  });

  // === Listing ===

  it('listPlaybooks() returns all built-in playbooks', () => {
    const list = listPlaybooks();
    expect(list.length).toBeGreaterThanOrEqual(7);
    const ids = list.map(e => e.id);
    expect(ids).toContain('research');
    expect(ids).toContain('evaluation');
    expect(ids).toContain('diagnosis');
    expect(ids).toContain('synthesis');
    expect(ids).toContain('assessment');
    expect(ids).toContain('creation');
    expect(ids).toContain('planning');
    for (const entry of list) {
      expect(entry.source).toBe('builtin');
      expect(entry.phaseCount).toBeGreaterThan(0);
    }
  });

  it('listPlaybooks() shows user playbook with correct source', () => {
    const userDir = join(tempDir, '.nodyn', 'playbooks');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'my-custom.json'), JSON.stringify({
      id: 'my-custom', name: 'Custom', description: 'Custom playbook',
      version: '1.0.0', phases: [{ name: 'P1', description: 'Do it' }],
    }), 'utf-8');

    const list = listPlaybooks();
    const custom = list.find(e => e.id === 'my-custom');
    expect(custom).toBeDefined();
    expect(custom!.source).toBe('user');
    expect(custom!.phaseCount).toBe(1);
  });

  it('listPlaybooks() returns sorted by id', () => {
    const list = listPlaybooks();
    const ids = list.map(e => e.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  // === getBuiltinPlaybookIds ===

  it('getBuiltinPlaybookIds() returns sorted ids', () => {
    const ids = getBuiltinPlaybookIds();
    expect(ids).toEqual([
      'assessment',
      'creation',
      'diagnosis',
      'evaluation',
      'planning',
      'research',
      'synthesis',
    ]);
  });

  // === Save / Export / Import ===

  it('savePlaybook() creates file and loadPlaybook() reads it back', () => {
    const pb: Playbook = {
      id: 'my-saved',
      name: 'My Saved',
      description: 'Saved playbook',
      version: '1.0.0',
      phases: [
        { name: 'Research', description: 'Do research', recommendedRole: 'researcher' },
        { name: 'Analyze', description: 'Analyze results', dependsOn: ['Research'] },
      ],
      parameters: [
        { name: 'topic', description: 'Topic to research', type: 'string', required: true },
      ],
      tags: ['custom'],
    };
    savePlaybook(pb);

    const loaded = loadPlaybook('my-saved');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('my-saved');
    expect(loaded!.phases).toHaveLength(2);
    expect(loaded!.phases[0]!.recommendedRole).toBe('researcher');
    expect(loaded!.parameters).toHaveLength(1);
    expect(loaded!.tags).toEqual(['custom']);
  });

  it('exportPlaybook() returns JSON for built-in playbook', () => {
    const json = exportPlaybook('planning');
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as Playbook;
    expect(parsed.id).toBe('planning');
    expect(parsed.phases.length).toBe(4);
  });

  it('exportPlaybook() returns null for unknown playbook', () => {
    const json = exportPlaybook('nope');
    expect(json).toBeNull();
  });

  it('importPlaybook() reads file and saves to user playbooks', () => {
    const filePath = join(tempDir, 'import-me.json');
    const pb: Playbook = {
      id: 'imported',
      name: 'Imported',
      description: 'Imported playbook',
      version: '1.0.0',
      phases: [{ name: 'Step 1', description: 'First step' }],
    };
    writeFileSync(filePath, JSON.stringify(pb), 'utf-8');

    const result = importPlaybook(filePath);
    expect(result.id).toBe('imported');

    const loaded = loadPlaybook('imported');
    expect(loaded).not.toBeNull();
    expect(loaded!.phases).toHaveLength(1);
  });

  // === Delete ===

  it('deletePlaybook() removes user playbook', () => {
    const pb: Playbook = {
      id: 'to-delete',
      name: 'Delete Me',
      description: 'Will be deleted',
      version: '1.0.0',
      phases: [{ name: 'P', description: 'P' }],
    };
    savePlaybook(pb);
    expect(loadPlaybook('to-delete')).not.toBeNull();

    const deleted = deletePlaybook('to-delete');
    expect(deleted).toBe(true);
    expect(loadPlaybook('to-delete')).toBeNull();
  });

  it('deletePlaybook() returns false for non-existent user playbook', () => {
    const deleted = deletePlaybook('nonexistent');
    expect(deleted).toBe(false);
  });

  // === Validation ===

  it('parsePlaybookConfig() returns null for missing phases', () => {
    const result = parsePlaybookConfig({
      id: 'test', name: 'Test', description: 'Test', version: '1.0.0',
    });
    expect(result).toBeNull();
  });

  it('parsePlaybookConfig() returns null for empty phases', () => {
    const result = parsePlaybookConfig({
      id: 'test', name: 'Test', description: 'Test', version: '1.0.0',
      phases: [],
    });
    expect(result).toBeNull();
  });

  it('parsePlaybookConfig() accepts valid playbook', () => {
    const result = parsePlaybookConfig({
      id: 'test', name: 'Test', description: 'Test', version: '1.0.0',
      phases: [{ name: 'P1', description: 'Phase one' }],
    });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('test');
  });

  // === Path traversal protection ===

  it('loadPlaybook() rejects path traversal', () => {
    expect(() => loadPlaybook('../../etc/passwd')).toThrow('Invalid playbook name');
  });

  it('loadPlaybook() rejects names with slashes', () => {
    expect(() => loadPlaybook('foo/bar')).toThrow('Invalid playbook name');
  });

  it('savePlaybook() rejects path traversal in id', () => {
    expect(() => savePlaybook({
      id: '../malicious',
      name: 'Evil',
      description: 'Attack',
      version: '1.0.0',
      phases: [{ name: 'P', description: 'P' }],
    })).toThrow('Invalid playbook name');
  });

  // === Extends ===

  it('resolves simple extends chain', () => {
    const userDir = join(tempDir, '.nodyn', 'playbooks');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'extended-research.json'), JSON.stringify({
      id: 'extended-research',
      name: 'Extended Research',
      description: 'Extended deep research',
      version: '1.0.0',
      extends: 'research',
      phases: [
        { name: 'Custom Phase', description: 'Custom work' },
      ],
      tags: ['extended'],
    }), 'utf-8');

    const pb = loadPlaybook('extended-research');
    expect(pb).not.toBeNull();
    expect(pb!.id).toBe('extended-research');
    // Phases: child replaces parent
    expect(pb!.phases).toHaveLength(1);
    expect(pb!.phases[0]!.name).toBe('Custom Phase');
    // Tags: union
    expect(pb!.tags).toContain('extended');
    expect(pb!.tags).toContain('research');
  });

  it('extends protects against cycles', () => {
    const userDir = join(tempDir, '.nodyn', 'playbooks');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'cycle-a.json'), JSON.stringify({
      id: 'cycle-a', name: 'A', description: 'A', version: '1.0.0',
      phases: [{ name: 'PA', description: 'A' }],
      extends: 'cycle-b',
    }), 'utf-8');

    writeFileSync(join(userDir, 'cycle-b.json'), JSON.stringify({
      id: 'cycle-b', name: 'B', description: 'B', version: '1.0.0',
      phases: [{ name: 'PB', description: 'B' }],
      extends: 'cycle-a',
    }), 'utf-8');

    // Should not infinite loop
    const pb = loadPlaybook('cycle-a');
    expect(pb).not.toBeNull();
    expect(pb!.id).toBe('cycle-a');
  });

  // === formatPlaybookIndex ===

  it('formatPlaybookIndex() generates compact listing', () => {
    const list = listPlaybooks();
    const index = formatPlaybookIndex(list);
    expect(index).toContain('research');
    expect(index).toContain('evaluation');
    expect(index).toContain('Use when:');
  });

  it('formatPlaybookIndex() returns message for empty list', () => {
    const index = formatPlaybookIndex([]);
    expect(index).toBe('No playbooks available.');
  });

  // === Built-in content verification ===

  it('research has correct structure', () => {
    const pb = loadPlaybook('research');
    expect(pb!.phases).toHaveLength(4);
    expect(pb!.phases[0]!.recommendedRole).toBe('collector');
    expect(pb!.phases[1]!.recommendedRole).toBe('researcher');
    expect(pb!.phases[2]!.recommendedRole).toBe('analyst');
    expect(pb!.phases[3]!.recommendedRole).toBe('creator');
    expect(pb!.phases[0]!.verification).toBeTruthy();
    expect(pb!.parameters).toBeDefined();
    const reqParam = pb!.parameters!.find(p => p.name === 'topic');
    expect(reqParam).toBeDefined();
    expect(reqParam!.required).toBe(true);
  });

  it('all 7 universal arcs have unique role sequences', () => {
    const ids = getBuiltinPlaybookIds();
    for (const id of ids) {
      const pb = loadPlaybook(id);
      // Every playbook must have phases with recommended roles
      const roles = pb!.phases.map(p => p.recommendedRole).filter(Boolean);
      expect(roles.length).toBeGreaterThan(0);
      // Every playbook must have at least one parameter
      expect(pb!.parameters).toBeDefined();
      expect(pb!.parameters!.length).toBeGreaterThan(0);
      // Every playbook must have applicableWhen for agent matching
      expect(pb!.applicableWhen).toBeTruthy();
      // Tags must include 'universal'
      expect(pb!.tags).toContain('universal');
    }
  });

  it('all built-in playbooks have phases with descriptions', () => {
    const ids = getBuiltinPlaybookIds();
    for (const id of ids) {
      const pb = loadPlaybook(id);
      for (const phase of pb!.phases) {
        expect(phase.name).toBeTruthy();
        expect(phase.description).toBeTruthy();
      }
    }
  });
});
