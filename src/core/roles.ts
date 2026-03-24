import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Role, ModelTier, RoleSource } from '../types/index.js';
import { writeFileAtomicSync } from './atomic-write.js';
import { RoleSchema } from '../types/schemas.js';

// === Types ===

export type { RoleSource } from '../types/index.js';

export interface RoleListEntry {
  id: string;
  source: RoleSource;
  description: string;
  model?: ModelTier | undefined;
}

// === Validation ===

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validateRoleName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid role name "${name}" — only letters, numbers, hyphens, underscores allowed`);
  }
}

export function parseRoleConfig(raw: unknown): Role | null {
  const result = RoleSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data as Role;
}

// === Built-in Roles (8) ===

const RESEARCHER: Role = {
  id: 'researcher',
  name: 'Researcher',
  description: 'Broad exploration specialist — follows leads, cross-references sources, read-only',
  version: '1.0.0',
  systemPrompt: 'Research specialist. Explore broadly — follow leads across files, documents, data, and any available sources. Cross-reference findings from multiple sources. Cite file paths and locations for every claim. Distinguish verified facts from inferences. Structure output as: Key Findings → Detailed Analysis → Sources. Flag conflicting information explicitly. Do not modify any files — read and analyze only.',
  model: 'opus',
  effort: 'max',
  autonomy: 'guided',
  deniedTools: ['write_file', 'bash'],
};

const ANALYST: Role = {
  id: 'analyst',
  name: 'Analyst',
  description: 'Pattern recognition specialist — structures findings with evidence, read-only',
  version: '1.0.0',
  systemPrompt: 'Analysis specialist. Examine the subject methodically — look for patterns, anomalies, and trends. Structure findings with concrete evidence: numbers, comparisons, and specific references. Use tables for comparisons, bullet points for recommendations. Prioritize findings by severity or impact (critical > major > minor). Present clearly: lead with the key finding, then supporting evidence. Do not modify any files.',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'guided',
  deniedTools: ['write_file', 'bash'],
};

const EXECUTOR: Role = {
  id: 'executor',
  name: 'Executor',
  description: 'Task-focused execution specialist — full tool access, verify results',
  version: '1.0.0',
  systemPrompt: 'Execution specialist. Read existing content before making changes — understand patterns and conventions first. Keep changes minimal and focused on the task. Handle errors cleanly. Verify results after making changes. If something breaks, investigate before retrying.',
  model: 'opus',
  effort: 'high',
  autonomy: 'guided',
};

const OPERATOR: Role = {
  id: 'operator',
  name: 'Operator',
  description: 'Fast operations assistant — status checks, routine tasks, concise reporting',
  version: '1.0.0',
  systemPrompt: 'Operations assistant. Fast, focused, efficient. For status checks: run the check, report the result, done. For routine tasks: execute immediately, confirm completion. Keep responses under 3 sentences unless asked for detail. Flag anomalies only — don\'t report when things are normal.',
  model: 'haiku',
  effort: 'high',
  autonomy: 'autonomous',
  deniedTools: ['write_file'],
};

const STRATEGIST: Role = {
  id: 'strategist',
  name: 'Strategist',
  description: 'Strategic planning specialist — designs plans with evidence, read-only',
  version: '1.0.0',
  systemPrompt: 'Strategy and planning specialist. Gather context before planning — read relevant files and data. Break complex goals into ordered, concrete steps. Identify dependencies and risks. Back every recommendation with evidence. Structure output as: Summary → Recommendations → Detailed Plan → Open Questions. Do not execute — design only.',
  model: 'opus',
  effort: 'high',
  autonomy: 'guided',
  deniedTools: ['bash', 'write_file'],
};

const CREATOR: Role = {
  id: 'creator',
  name: 'Creator',
  description: 'Content creation specialist — adapts tone and format to audience',
  version: '1.0.0',
  systemPrompt: 'Content creation specialist. Produce clear, well-structured output tailored to the audience. Adapt tone and format to the context — technical docs, blog posts, copy, reports. Read existing content first to match the established voice and style. Focus on clarity and usefulness over embellishment. Write to files when needed but do not run shell commands.',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'guided',
  deniedTools: ['bash'],
};

const COLLECTOR: Role = {
  id: 'collector',
  name: 'Collector',
  description: 'Feedback collector — structured Q&A, stores insights to memory',
  version: '1.0.0',
  systemPrompt: 'Feedback collector. Ask one clear question at a time. Offer options where possible. Summarize understanding and confirm before storing. Save key insights to memory. Keep the conversation focused and efficient.',
  model: 'haiku',
  effort: 'medium',
  autonomy: 'supervised',
  allowedTools: ['ask_user', 'memory_store', 'memory_recall'],
};

const COMMUNICATOR: Role = {
  id: 'communicator',
  name: 'Communicator',
  description: 'Communication specialist — adapts tone to recipient and channel',
  version: '1.0.0',
  systemPrompt: 'Communication specialist. Craft messages tailored to the recipient and channel. Adapt tone: formal for clients, concise for team, friendly for community. Use context from memory to personalize — reference previous conversations, known preferences, ongoing projects. Keep messages clear and actionable. Do not write files or run commands — focus on composing and sending messages.',
  model: 'sonnet',
  effort: 'high',
  autonomy: 'guided',
  deniedTools: ['write_file', 'bash'],
};

const BUILTIN_ROLES: Record<string, Role> = {
  'researcher': RESEARCHER,
  'analyst': ANALYST,
  'executor': EXECUTOR,
  'operator': OPERATOR,
  'strategist': STRATEGIST,
  'creator': CREATOR,
  'collector': COLLECTOR,
  'communicator': COMMUNICATOR,
};

// === Directory Helpers ===

function getProjectRolesDir(): string {
  return join(process.cwd(), '.nodyn', 'roles');
}

function getUserRolesDir(): string {
  return join(homedir(), '.nodyn', 'roles');
}

// === Extends Resolution ===

function loadRoleRaw(id: string): Role | null {
  validateRoleName(id);

  // 1. Project roles
  const projectDir = getProjectRolesDir();
  const projectPath = join(projectDir, `${id}.json`);
  if (existsSync(projectPath)) {
    try {
      const raw = readFileSync(projectPath, 'utf-8');
      const parsed = parseRoleConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // Malformed JSON — fall through
    }
  }

  // 2. User roles
  const userDir = getUserRolesDir();
  const userPath = join(userDir, `${id}.json`);
  if (existsSync(userPath)) {
    try {
      const raw = readFileSync(userPath, 'utf-8');
      const parsed = parseRoleConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // Malformed JSON — fall through
    }
  }

  // 3. Built-in roles
  return BUILTIN_ROLES[id] ?? null;
}

function resolveInheritanceChain(role: Role): Role[] {
  const chain: Role[] = [role];
  let current = role;
  const maxDepth = 3;
  const seen = new Set<string>([current.id]);

  while (current.extends && chain.length <= maxDepth) {
    if (seen.has(current.extends)) break; // cycle protection
    const parent = loadRoleRaw(current.extends);
    if (!parent) break;
    seen.add(parent.id);
    chain.unshift(parent); // parent first
    current = parent;
  }
  return chain;
}

function mergeChain(chain: Role[]): Role {
  if (chain.length === 1) return chain[0]!;

  const base = { ...chain[0]! };

  for (let i = 1; i < chain.length; i++) {
    const child = chain[i]!;

    // systemPrompt: concatenate
    base.systemPrompt = base.systemPrompt + '\n\n' + child.systemPrompt;

    // deniedTools: union
    if (child.deniedTools) {
      const merged = new Set([...(base.deniedTools ?? []), ...child.deniedTools]);
      base.deniedTools = [...merged];
    }

    // allowedTools: child wins (narrowing)
    if (child.allowedTools !== undefined) {
      base.allowedTools = child.allowedTools;
    }

    // maxBudgetUsd: most restrictive
    if (child.maxBudgetUsd !== undefined) {
      base.maxBudgetUsd = base.maxBudgetUsd !== undefined
        ? Math.min(base.maxBudgetUsd, child.maxBudgetUsd)
        : child.maxBudgetUsd;
    }

    // Everything else: child overrides parent (last-write-wins)
    base.id = child.id;
    base.name = child.name;
    base.description = child.description;
    base.version = child.version;
    if (child.model !== undefined) base.model = child.model;
    if (child.thinking !== undefined) base.thinking = child.thinking;
    if (child.effort !== undefined) base.effort = child.effort;
    if (child.autonomy !== undefined) base.autonomy = child.autonomy;
    if (child.maxIterations !== undefined) base.maxIterations = child.maxIterations;
    if (child.outputFormat !== undefined) base.outputFormat = child.outputFormat;
    if (child.memoryScope !== undefined) base.memoryScope = child.memoryScope;
    if (child.tags !== undefined) base.tags = child.tags;
    if (child.source !== undefined) base.source = child.source;
  }

  // Clear extends on resolved result
  delete base.extends;
  return base;
}

// === Model Mismatch Warning ===

const MODEL_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

export function warnModelMismatch(
  role: Role,
  overrideModel: ModelTier,
): string | null {
  if (!role.model || role.model === overrideModel) return null;

  const defaultRank = MODEL_RANK[role.model];
  const overrideRank = MODEL_RANK[overrideModel];

  if (overrideRank < defaultRank) {
    return `Role "${role.id}" is designed for ${role.model}. ` +
      `Using ${overrideModel} may produce unreliable results.`;
  }
  if (overrideRank > defaultRank) {
    return `Role "${role.id}" is designed for ${role.model}. ` +
      `Using ${overrideModel} increases cost without clear benefit.`;
  }
  return null;
}

// === Public API ===

/**
 * Load a role by ID.
 * Resolution order: project `.nodyn/roles/` > user `~/.nodyn/roles/` > built-in.
 * Resolves extends chain.
 * Returns null if not found.
 */
export function loadRole(id: string): Role | null {
  const raw = loadRoleRaw(id);
  if (!raw) return null;
  if (!raw.extends) return raw;
  const chain = resolveInheritanceChain(raw);
  return mergeChain(chain);
}

/**
 * List all available roles from all sources.
 * Project roles override user roles which override built-in.
 */
export function listRoles(): RoleListEntry[] {
  const seen = new Map<string, RoleListEntry>();

  // Built-in (lowest priority — added first, overridden by user/project)
  for (const [id, role] of Object.entries(BUILTIN_ROLES)) {
    seen.set(id, { id, source: 'builtin', description: role.description, model: role.model });
  }

  // User roles
  const userDir = getUserRolesDir();
  if (existsSync(userDir)) {
    try {
      const files = readdirSync(userDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const id = file.replace(/\.json$/, '');
        try {
          const raw = readFileSync(join(userDir, file), 'utf-8');
          const role = parseRoleConfig(JSON.parse(raw));
          if (role) {
            seen.set(id, { id, source: 'user', description: role.description, model: role.model });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory read failed
    }
  }

  // Project roles (highest priority)
  const projectDir = getProjectRolesDir();
  if (existsSync(projectDir)) {
    try {
      const files = readdirSync(projectDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const id = file.replace(/\.json$/, '');
        try {
          const raw = readFileSync(join(projectDir, file), 'utf-8');
          const role = parseRoleConfig(JSON.parse(raw));
          if (role) {
            seen.set(id, { id, source: 'project', description: role.description, model: role.model });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory read failed
    }
  }

  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get the IDs of all built-in roles.
 */
export function getBuiltinRoleIds(): string[] {
  return Object.keys(BUILTIN_ROLES).sort();
}

/**
 * Save a role to the user roles directory.
 */
export function saveRole(role: Role): void {
  const parsed = parseRoleConfig(role);
  if (!parsed) {
    throw new Error('Role must have valid id, name, description, version, and systemPrompt fields');
  }
  validateRoleName(parsed.id);
  const filePath = join(getUserRolesDir(), `${parsed.id}.json`);
  writeFileAtomicSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
}

/**
 * Export a role (built-in or loaded) as JSON string.
 */
export function exportRole(id: string): string | null {
  const role = loadRole(id);
  if (!role) return null;
  return JSON.stringify(role, null, 2);
}

/**
 * Import a role from a JSON file path into user roles.
 */
export function importRole(filePath: string): Role {
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid role JSON: ${filePath}`);
  }
  const role = parseRoleConfig(parsed);
  if (!role) {
    throw new Error('Role must have valid id, name, description, version, and systemPrompt fields');
  }
  validateRoleName(role.id);
  saveRole(role);
  return role;
}

/**
 * Delete a user role by ID. Returns true if deleted, false if not found.
 * Cannot delete built-in roles (only user overrides).
 */
export function deleteRole(id: string): boolean {
  validateRoleName(id);
  const filePath = join(getUserRolesDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}
