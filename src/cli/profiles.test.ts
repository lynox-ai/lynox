import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

// Must import after mock is set up
import { homedir } from 'node:os';
import type { Profile } from './profiles.js';

describe('profiles', () => {
  let listProfiles: typeof import('./profiles.js').listProfiles;
  let loadProfile: typeof import('./profiles.js').loadProfile;
  let saveProfile: typeof import('./profiles.js').saveProfile;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'lynox-profiles-test-'));
    vi.mocked(homedir).mockReturnValue(tempDir);

    // Re-import to pick up the new homedir value for PROFILES_DIR
    vi.resetModules();
    const mod = await import('./profiles.js');
    listProfiles = mod.listProfiles;
    loadProfile = mod.loadProfile;
    saveProfile = mod.saveProfile;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('listProfiles() returns empty array when no profiles exist', () => {
    const result = listProfiles();
    expect(result).toEqual([]);
  });

  it('listProfiles() returns profile names without .json extension', () => {
    const profile1: Profile = { name: 'dev' };
    const profile2: Profile = { name: 'prod' };
    saveProfile(profile1);
    saveProfile(profile2);

    const result = listProfiles();
    expect(result.sort()).toEqual(['dev', 'prod']);
  });

  it('saveProfile() creates file with JSON content', () => {
    const profile: Profile = {
      name: 'test-profile',
      model: 'sonnet',
      systemPrompt: 'You are helpful',
      effort: 'high',
      tools: ['bash', 'fs'],
    };
    saveProfile(profile);

    const loaded = loadProfile('test-profile');
    expect(loaded).toEqual(profile);
  });

  it('loadProfile() returns profile data', () => {
    const profile: Profile = {
      name: 'my-profile',
      systemPrompt: 'Be concise',
    };
    saveProfile(profile);

    const result = loadProfile('my-profile');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('my-profile');
    expect(result!.systemPrompt).toBe('Be concise');
  });

  it('loadProfile() returns null for non-existent profile', () => {
    const result = loadProfile('does-not-exist');
    expect(result).toBeNull();
  });

  it('round-trip: save then load returns same data', () => {
    const profile: Profile = {
      name: 'roundtrip',
      model: 'haiku',
      systemPrompt: 'System prompt text',
      effort: 'max',
      tools: ['memory', 'http'],
    };

    saveProfile(profile);
    const loaded = loadProfile('roundtrip');

    expect(loaded).toEqual(profile);
  });

  it('loadProfile() rejects invalid model values', () => {
    mkdirSync(join(tempDir, '.lynox', 'profiles'), { recursive: true });
    const filePath = join(tempDir, '.lynox', 'profiles', 'invalid.json');
    writeFileSync(filePath, JSON.stringify({
      name: 'invalid',
      model: 'broken-tier',
      systemPrompt: 'bad',
    }), 'utf-8');

    expect(loadProfile('invalid')).toBeNull();
  });
});
