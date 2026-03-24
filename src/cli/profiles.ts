import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ModelTier, EffortLevel } from '../types/index.js';
import { MODEL_TIER_SET, EFFORT_LEVEL_SET } from '../types/index.js';
import { ensureDirSync, writeFileAtomicSync } from '../core/atomic-write.js';

export interface Profile {
  name: string;
  systemPrompt?: string | undefined;
  model?: ModelTier | undefined;
  effort?: EffortLevel | undefined;
  tools?: string[] | undefined;
}

const PROFILES_DIR = join(homedir(), '.nodyn', 'profiles');
const SAFE_PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function ensureDir(): void {
  ensureDirSync(PROFILES_DIR);
}

function parseProfile(raw: unknown, fallbackName: string): Profile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const name = typeof obj['name'] === 'string' && SAFE_PROFILE_NAME_RE.test(obj['name'])
    ? obj['name']
    : fallbackName;
  const profile: Profile = { name };

  if (obj['systemPrompt'] !== undefined) {
    if (typeof obj['systemPrompt'] !== 'string') return null;
    profile.systemPrompt = obj['systemPrompt'];
  }
  if (obj['model'] !== undefined) {
    if (typeof obj['model'] !== 'string' || !MODEL_TIER_SET.has(obj['model'] as ModelTier)) return null;
    profile.model = obj['model'] as ModelTier;
  }
  if (obj['effort'] !== undefined) {
    if (typeof obj['effort'] !== 'string' || !EFFORT_LEVEL_SET.has(obj['effort'] as EffortLevel)) return null;
    profile.effort = obj['effort'] as EffortLevel;
  }
  if (obj['tools'] !== undefined) {
    if (!Array.isArray(obj['tools']) || !obj['tools'].every(value => typeof value === 'string')) return null;
    profile.tools = obj['tools'] as string[];
  }

  return profile;
}

export function listProfiles(): string[] {
  ensureDir();
  try {
    return readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
  } catch {
    return [];
  }
}

export function loadProfile(name: string): Profile | null {
  if (!SAFE_PROFILE_NAME_RE.test(name)) return null;
  const filePath = join(PROFILES_DIR, `${name}.json`);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return parseProfile(JSON.parse(raw), name);
  } catch {
    return null;
  }
}

export function saveProfile(profile: Profile): void {
  if (!SAFE_PROFILE_NAME_RE.test(profile.name)) {
    throw new Error(`Invalid profile name "${profile.name}"`);
  }
  if (profile.model !== undefined && !MODEL_TIER_SET.has(profile.model)) {
    throw new Error(`Invalid profile model "${profile.model}"`);
  }
  if (profile.effort !== undefined && !EFFORT_LEVEL_SET.has(profile.effort)) {
    throw new Error(`Invalid profile effort "${profile.effort}"`);
  }
  ensureDir();
  const filePath = join(PROFILES_DIR, `${profile.name}.json`);
  writeFileAtomicSync(filePath, JSON.stringify(profile, null, 2) + '\n');
}
