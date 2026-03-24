import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Role } from '../types/index.js';

let tempDir: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

import { homedir } from 'node:os';

describe('roles', () => {
  let loadRole: typeof import('./roles.js').loadRole;
  let listRoles: typeof import('./roles.js').listRoles;
  let getBuiltinRoleIds: typeof import('./roles.js').getBuiltinRoleIds;
  let saveRole: typeof import('./roles.js').saveRole;
  let exportRole: typeof import('./roles.js').exportRole;
  let importRole: typeof import('./roles.js').importRole;
  let deleteRole: typeof import('./roles.js').deleteRole;
  let warnModelMismatch: typeof import('./roles.js').warnModelMismatch;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'nodyn-roles-test-'));
    vi.mocked(homedir).mockReturnValue(tempDir);

    vi.resetModules();
    const mod = await import('./roles.js');
    loadRole = mod.loadRole;
    listRoles = mod.listRoles;
    getBuiltinRoleIds = mod.getBuiltinRoleIds;
    saveRole = mod.saveRole;
    exportRole = mod.exportRole;
    importRole = mod.importRole;
    deleteRole = mod.deleteRole;
    warnModelMismatch = mod.warnModelMismatch;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // === Loading ===

  it('loadRole() returns built-in role by id', () => {
    const role = loadRole('researcher');
    expect(role).not.toBeNull();
    expect(role!.id).toBe('researcher');
    expect(role!.name).toBe('Researcher');
    expect(role!.model).toBe('opus');
    expect(role!.deniedTools).toContain('write_file');
    expect(role!.deniedTools).toContain('bash');
  });

  it('loadRole() returns null for unknown role', () => {
    const role = loadRole('does-not-exist');
    expect(role).toBeNull();
  });

  it('loadRole() loads all 8 built-in roles', () => {
    const ids = getBuiltinRoleIds();
    expect(ids).toHaveLength(8);
    for (const id of ids) {
      const role = loadRole(id);
      expect(role).not.toBeNull();
      expect(role!.id).toBe(id);
      expect(role!.name).toBeTruthy();
      expect(role!.description).toBeTruthy();
      expect(role!.systemPrompt).toBeTruthy();
      expect(role!.version).toBeTruthy();
    }
  });

  it('loadRole() user role overrides built-in', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });

    const override: Role = {
      id: 'researcher',
      name: 'Custom Researcher',
      description: 'Custom researcher role',
      version: '2.0.0',
      systemPrompt: 'Custom prompt.',
      model: 'sonnet',
    };
    writeFileSync(join(userDir, 'researcher.json'), JSON.stringify(override), 'utf-8');

    const role = loadRole('researcher');
    expect(role).not.toBeNull();
    expect(role!.name).toBe('Custom Researcher');
    expect(role!.description).toBe('Custom researcher role');
    expect(role!.model).toBe('sonnet');
  });

  it('loadRole() project role overrides user role', () => {
    // Create user role
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'strategist.json'), JSON.stringify({
      id: 'strategist', name: 'User Strategist', description: 'User strategist',
      version: '1.0.0', systemPrompt: 'User.',
    }), 'utf-8');

    // Create project role (cwd/.nodyn/roles/)
    const projectDir = join(process.cwd(), '.nodyn', 'roles');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'strategist.json'), JSON.stringify({
      id: 'strategist', name: 'Project Strategist', description: 'Project strategist',
      version: '1.0.0', systemPrompt: 'Project.',
    }), 'utf-8');

    try {
      const role = loadRole('strategist');
      expect(role).not.toBeNull();
      expect(role!.name).toBe('Project Strategist');
      expect(role!.description).toBe('Project strategist');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      try { rmSync(join(process.cwd(), '.nodyn', 'roles'), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // === Listing ===

  it('listRoles() returns all built-in roles', () => {
    const list = listRoles();
    expect(list.length).toBeGreaterThanOrEqual(8);
    const ids = list.map(e => e.id);
    expect(ids).toContain('researcher');
    expect(ids).toContain('analyst');
    expect(ids).toContain('executor');
    expect(ids).toContain('operator');
    expect(ids).toContain('strategist');
    expect(ids).toContain('creator');
    expect(ids).toContain('collector');
    expect(ids).toContain('communicator');
    for (const entry of list) {
      if (['researcher', 'analyst', 'executor', 'operator', 'strategist', 'creator', 'collector', 'communicator'].includes(entry.id)) {
        expect(entry.source).toBe('builtin');
      }
    }
  });

  it('listRoles() shows user role with correct source', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'my-custom.json'), JSON.stringify({
      id: 'my-custom', name: 'Custom', description: 'Custom role',
      version: '1.0.0', systemPrompt: 'Custom.',
    }), 'utf-8');

    const list = listRoles();
    const custom = list.find(e => e.id === 'my-custom');
    expect(custom).toBeDefined();
    expect(custom!.source).toBe('user');
    expect(custom!.description).toBe('Custom role');
  });

  it('listRoles() user override shows source as user', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'researcher.json'), JSON.stringify({
      id: 'researcher', name: 'Override', description: 'Overridden',
      version: '1.0.0', systemPrompt: 'Override.',
    }), 'utf-8');

    const list = listRoles();
    const researcher = list.find(e => e.id === 'researcher');
    expect(researcher).toBeDefined();
    expect(researcher!.source).toBe('user');
    expect(researcher!.description).toBe('Overridden');
  });

  it('listRoles() returns sorted by id', () => {
    const list = listRoles();
    const ids = list.map(e => e.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  // === getBuiltinRoleIds ===

  it('getBuiltinRoleIds() returns sorted ids', () => {
    const ids = getBuiltinRoleIds();
    expect(ids).toEqual(['analyst', 'collector', 'communicator', 'creator', 'executor', 'operator', 'researcher', 'strategist']);
  });

  // === Save / Export / Import ===

  it('saveRole() creates file in user roles dir', () => {
    const role: Role = {
      id: 'my-saved',
      name: 'My Saved',
      description: 'Saved role',
      version: '1.0.0',
      systemPrompt: 'Do stuff.',
      effort: 'max',
    };
    saveRole(role);

    const loaded = loadRole('my-saved');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('my-saved');
    expect(loaded!.effort).toBe('max');
  });

  it('exportRole() returns JSON for built-in role', () => {
    const json = exportRole('operator');
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!) as Role;
    expect(parsed.id).toBe('operator');
    expect(parsed.model).toBe('haiku');
  });

  it('exportRole() returns null for unknown role', () => {
    const json = exportRole('nope');
    expect(json).toBeNull();
  });

  it('importRole() reads file and saves to user roles', () => {
    const filePath = join(tempDir, 'import-me.json');
    const role: Role = {
      id: 'imported',
      name: 'Imported',
      description: 'Imported role',
      version: '1.0.0',
      systemPrompt: 'Imported prompt.',
      model: 'haiku',
    };
    writeFileSync(filePath, JSON.stringify(role), 'utf-8');

    const result = importRole(filePath);
    expect(result.id).toBe('imported');

    const loaded = loadRole('imported');
    expect(loaded).not.toBeNull();
    expect(loaded!.model).toBe('haiku');
  });

  // === Delete ===

  it('deleteRole() removes user role', () => {
    const role: Role = {
      id: 'to-delete',
      name: 'Delete Me',
      description: 'Will be deleted',
      version: '1.0.0',
      systemPrompt: 'Bye.',
    };
    saveRole(role);
    expect(loadRole('to-delete')).not.toBeNull();

    const deleted = deleteRole('to-delete');
    expect(deleted).toBe(true);

    // After delete, should fall through to built-in (or null)
    expect(loadRole('to-delete')).toBeNull();
  });

  it('deleteRole() returns false for non-existent user role', () => {
    const deleted = deleteRole('nonexistent');
    expect(deleted).toBe(false);
  });

  // === Validation ===

  it('loadRole() returns null for invalid fields', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, 'broken.json'), JSON.stringify({
      id: 'broken',
      name: 'Broken',
      description: 'Broken role',
      version: '1.0.0',
      systemPrompt: 'Prompt.',
      model: 'invalid-tier',
    }), 'utf-8');

    expect(loadRole('broken')).toBeNull();
  });

  // === Path traversal protection ===

  it('loadRole() rejects path traversal (../../etc/passwd)', () => {
    expect(() => loadRole('../../etc/passwd')).toThrow('Invalid role name');
  });

  it('loadRole() rejects names with slashes', () => {
    expect(() => loadRole('foo/bar')).toThrow('Invalid role name');
  });

  it('loadRole() rejects names with null bytes', () => {
    expect(() => loadRole('foo\x00bar')).toThrow('Invalid role name');
  });

  it('saveRole() rejects path traversal in id', () => {
    expect(() => saveRole({
      id: '../malicious',
      name: 'Evil',
      description: 'Attack',
      version: '1.0.0',
      systemPrompt: 'Hack.',
    })).toThrow('Invalid role name');
  });

  it('loadRole() rejects names with dots', () => {
    expect(() => loadRole('foo.bar')).toThrow('Invalid role name');
  });

  // === Built-in content verification ===

  it('researcher has correct config', () => {
    const role = loadRole('researcher');
    expect(role!.deniedTools).toEqual(['write_file', 'bash']);
    expect(role!.model).toBe('opus');
    expect(role!.effort).toBe('max');
    expect(role!.autonomy).toBe('guided');
    expect(role!.allowedTools).toBeUndefined();
  });

  it('analyst has correct config', () => {
    const role = loadRole('analyst');
    expect(role!.deniedTools).toEqual(['write_file', 'bash']);
    expect(role!.model).toBe('sonnet');
    expect(role!.effort).toBe('high');
    expect(role!.autonomy).toBe('guided');
  });

  it('executor has full tool access', () => {
    const role = loadRole('executor');
    expect(role!.allowedTools).toBeUndefined();
    expect(role!.deniedTools).toBeUndefined();
    expect(role!.model).toBe('opus');
    expect(role!.autonomy).toBe('guided');
  });

  it('operator has correct config', () => {
    const role = loadRole('operator');
    expect(role!.deniedTools).toEqual(['write_file']);
    expect(role!.model).toBe('haiku');
    expect(role!.autonomy).toBe('autonomous');
  });

  it('strategist has correct config', () => {
    const role = loadRole('strategist');
    expect(role!.deniedTools).toEqual(['bash', 'write_file']);
    expect(role!.model).toBe('opus');
    expect(role!.autonomy).toBe('guided');
  });

  it('creator has correct config', () => {
    const role = loadRole('creator');
    expect(role!.deniedTools).toEqual(['bash']);
    expect(role!.model).toBe('sonnet');
    expect(role!.autonomy).toBe('guided');
  });

  it('collector has allowedTools whitelist', () => {
    const role = loadRole('collector');
    expect(role!.allowedTools).toEqual(['ask_user', 'memory_store', 'memory_recall']);
    expect(role!.model).toBe('haiku');
    expect(role!.effort).toBe('medium');
    expect(role!.autonomy).toBe('supervised');
  });

  it('communicator has correct config', () => {
    const role = loadRole('communicator');
    expect(role!.deniedTools).toEqual(['write_file', 'bash']);
    expect(role!.model).toBe('sonnet');
    expect(role!.autonomy).toBe('guided');
  });

  // === Extends ===

  it('resolves simple extends chain', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'strict-researcher.json'), JSON.stringify({
      id: 'strict-researcher',
      name: 'Strict Researcher',
      description: 'Strict version of researcher',
      version: '1.0.0',
      systemPrompt: 'Be extra thorough.',
      extends: 'researcher',
      effort: 'max',
    }), 'utf-8');

    const role = loadRole('strict-researcher');
    expect(role).not.toBeNull();
    expect(role!.id).toBe('strict-researcher');
    expect(role!.name).toBe('Strict Researcher');
    // systemPrompt: parent + child
    expect(role!.systemPrompt).toContain('Research specialist');
    expect(role!.systemPrompt).toContain('Be extra thorough.');
    // Inherits parent's model
    expect(role!.model).toBe('opus');
  });

  it('extends concatenates systemPrompt', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'verbose-analyst.json'), JSON.stringify({
      id: 'verbose-analyst',
      name: 'Verbose Analyst',
      description: 'Verbose analyst',
      version: '1.0.0',
      systemPrompt: 'Include detailed explanations.',
      extends: 'analyst',
    }), 'utf-8');

    const role = loadRole('verbose-analyst');
    expect(role!.systemPrompt).toContain('Analysis specialist');
    expect(role!.systemPrompt).toContain('Include detailed explanations.');
  });

  it('extends unions deniedTools', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'no-http-analyst.json'), JSON.stringify({
      id: 'no-http-analyst',
      name: 'No-HTTP Analyst',
      description: 'Analyst without HTTP',
      version: '1.0.0',
      systemPrompt: 'Also no HTTP.',
      extends: 'analyst',
      deniedTools: ['http'],
    }), 'utf-8');

    const role = loadRole('no-http-analyst');
    // analyst denied: write_file, bash + child denied: http = union
    expect(role!.deniedTools).toContain('write_file');
    expect(role!.deniedTools).toContain('bash');
    expect(role!.deniedTools).toContain('http');
  });

  it('extends uses Math.min for maxBudgetUsd', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'parent-budget.json'), JSON.stringify({
      id: 'parent-budget',
      name: 'Parent',
      description: 'Parent with budget',
      version: '1.0.0',
      systemPrompt: 'Parent.',
      maxBudgetUsd: 10,
    }), 'utf-8');

    writeFileSync(join(userDir, 'child-budget.json'), JSON.stringify({
      id: 'child-budget',
      name: 'Child',
      description: 'Child with lower budget',
      version: '1.0.0',
      systemPrompt: 'Child.',
      extends: 'parent-budget',
      maxBudgetUsd: 5,
    }), 'utf-8');

    const role = loadRole('child-budget');
    expect(role!.maxBudgetUsd).toBe(5);
  });

  it('extends protects against cycles', () => {
    const userDir = join(tempDir, '.nodyn', 'roles');
    mkdirSync(userDir, { recursive: true });

    writeFileSync(join(userDir, 'cycle-a.json'), JSON.stringify({
      id: 'cycle-a',
      name: 'Cycle A',
      description: 'Cycle A',
      version: '1.0.0',
      systemPrompt: 'A.',
      extends: 'cycle-b',
    }), 'utf-8');

    writeFileSync(join(userDir, 'cycle-b.json'), JSON.stringify({
      id: 'cycle-b',
      name: 'Cycle B',
      description: 'Cycle B',
      version: '1.0.0',
      systemPrompt: 'B.',
      extends: 'cycle-a',
    }), 'utf-8');

    // Should not infinite loop — cycle protection breaks
    const role = loadRole('cycle-a');
    expect(role).not.toBeNull();
    expect(role!.id).toBe('cycle-a');
  });

  // === Model Mismatch Warning ===

  it('warnModelMismatch() warns on downgrade', () => {
    const role = loadRole('executor')!;
    const warning = warnModelMismatch(role, 'haiku');
    expect(warning).not.toBeNull();
    expect(warning).toContain('may produce unreliable results');
  });

  it('warnModelMismatch() warns on upgrade', () => {
    const role = loadRole('operator')!;
    const warning = warnModelMismatch(role, 'opus');
    expect(warning).not.toBeNull();
    expect(warning).toContain('increases cost without clear benefit');
  });

  it('warnModelMismatch() returns null on match', () => {
    const role = loadRole('executor')!;
    const warning = warnModelMismatch(role, 'opus');
    expect(warning).toBeNull();
  });
});
