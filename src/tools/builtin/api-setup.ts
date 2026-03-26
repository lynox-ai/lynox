/**
 * api_setup tool — create, validate, and hot-reload API profiles.
 *
 * The agent uses this tool to onboard new APIs from conversation:
 * 1. Research the API docs (web_search)
 * 2. Create the profile via this tool
 * 3. Ask user for credentials (ask_user)
 * 4. Test connection (http_request)
 *
 * Profiles are written to ~/.lynox/apis/<id>.json and immediately activated.
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolEntry, IAgent } from '../../types/index.js';
import { getLynoxDir } from '../../core/config.js';
import type { ApiProfile } from '../../core/api-store.js';

interface ApiSetupInput {
  action: 'create' | 'update' | 'delete' | 'list';
  /** API profile data (required for create/update). */
  profile?: ApiProfile | undefined;
  /** Profile ID (required for delete). */
  id?: string | undefined;
}

const REQUIRED_FIELDS: Array<keyof ApiProfile> = ['id', 'name', 'base_url', 'description'];
const VALID_AUTH_TYPES = new Set(['basic', 'bearer', 'header', 'query']);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function validateProfile(profile: ApiProfile): string | null {
  for (const field of REQUIRED_FIELDS) {
    if (!profile[field] || (typeof profile[field] === 'string' && (profile[field] as string).trim() === '')) {
      return `Missing required field: ${field}`;
    }
  }
  if (!ID_PATTERN.test(profile.id)) {
    return `Invalid id "${profile.id}": must be lowercase alphanumeric with hyphens/underscores, 1-64 chars`;
  }
  try {
    new URL(profile.base_url);
  } catch {
    return `Invalid base_url: "${profile.base_url}" is not a valid URL`;
  }
  if (profile.auth && !VALID_AUTH_TYPES.has(profile.auth.type)) {
    return `Invalid auth type "${profile.auth.type}": must be basic, bearer, header, or query`;
  }
  if (profile.rate_limit) {
    const rl = profile.rate_limit;
    if (rl.requests_per_second !== undefined && (rl.requests_per_second < 0 || !Number.isFinite(rl.requests_per_second))) {
      return 'Invalid rate_limit.requests_per_second';
    }
    if (rl.requests_per_minute !== undefined && (rl.requests_per_minute < 0 || !Number.isFinite(rl.requests_per_minute))) {
      return 'Invalid rate_limit.requests_per_minute';
    }
  }
  return null;
}

function getApisDir(): string {
  return join(getLynoxDir(), 'apis');
}

export const apiSetupTool: ToolEntry<ApiSetupInput> = {
  definition: {
    name: 'api_setup',
    description: 'Create, update, or delete API profiles. Profiles teach you how to correctly use external APIs — endpoints, auth, rate limits, and common mistakes. Use "create" with a complete profile object when the user wants to connect a new API. Use "list" to show registered APIs. The profile is validated and immediately activated (no restart needed).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list'],
          description: 'Action to perform',
        },
        profile: {
          type: 'object',
          description: 'API profile data. Required fields: id (lowercase, alphanumeric), name, base_url, description. Optional: auth (type: basic|bearer|header|query), rate_limit (requests_per_second/minute/hour/day), endpoints (array of {method, path, description}), guidelines (array of best practices), avoid (array of common mistakes), notes (array of extra context).',
        },
        id: {
          type: 'string',
          description: 'Profile ID (for delete action)',
        },
      },
      required: ['action'],
    },
  },
  handler: async (input: ApiSetupInput, agent: IAgent): Promise<string> => {
    const apisDir = getApisDir();

    if (input.action === 'list') {
      const apiStore = agent.toolContext?.apiStore;
      if (!apiStore || apiStore.size === 0) {
        return 'No API profiles registered. Use action "create" with a profile object to add one.';
      }
      const profiles = apiStore.getAll();
      const lines = profiles.map(p => {
        const limits: string[] = [];
        if (p.rate_limit?.requests_per_second) limits.push(`${String(p.rate_limit.requests_per_second)}/s`);
        if (p.rate_limit?.requests_per_minute) limits.push(`${String(p.rate_limit.requests_per_minute)}/min`);
        const limitStr = limits.length > 0 ? ` [${limits.join(', ')}]` : '';
        return `- ${p.id}: ${p.name} (${p.base_url})${limitStr}`;
      });
      return `Registered APIs (${String(profiles.length)}):\n${lines.join('\n')}`;
    }

    if (input.action === 'create' || input.action === 'update') {
      if (!input.profile) {
        return 'Error: "profile" object is required for create/update action.';
      }

      const profile = input.profile;
      const error = validateProfile(profile);
      if (error) {
        return `Validation error: ${error}`;
      }

      // Enforce research: warn if profile is too thin
      const warnings: string[] = [];
      if (!profile.endpoints || profile.endpoints.length === 0) {
        warnings.push('No endpoints listed — research the API documentation first (web_search) and add the key endpoints.');
      }
      if (!profile.guidelines || profile.guidelines.length === 0) {
        warnings.push('No guidelines — add best practices (correct HTTP methods, required headers, pagination, etc.).');
      }
      if (!profile.avoid || profile.avoid.length === 0) {
        warnings.push('No "avoid" rules — add common mistakes to prevent (wrong methods, missing params, rate limit pitfalls).');
      }
      if (!profile.auth) {
        warnings.push('No auth method specified — most APIs require authentication.');
      }
      if (warnings.length > 0) {
        return `Profile is incomplete — research the API docs before creating:\n\n${warnings.map(w => `- ${w}`).join('\n')}\n\nUse web_search to find the API documentation, then retry with a complete profile.`;
      }

      // Write to disk
      mkdirSync(apisDir, { recursive: true, mode: 0o700 });
      const filePath = join(apisDir, `${profile.id}.json`);
      const isUpdate = existsSync(filePath);
      writeFileSync(filePath, JSON.stringify(profile, null, 2), { mode: 0o600 });

      // Hot-reload into ApiStore
      const apiStore = agent.toolContext?.apiStore;
      if (apiStore) {
        apiStore.register(profile);
      }

      const verb = isUpdate ? 'Updated' : 'Created';
      const parts: string[] = [
        `${verb} API profile "${profile.name}" (${profile.id}).`,
        `Base URL: ${profile.base_url}`,
      ];
      if (profile.auth) parts.push(`Auth: ${profile.auth.type}`);
      if (profile.rate_limit) {
        const rl: string[] = [];
        if (profile.rate_limit.requests_per_second) rl.push(`${String(profile.rate_limit.requests_per_second)}/s`);
        if (profile.rate_limit.requests_per_minute) rl.push(`${String(profile.rate_limit.requests_per_minute)}/min`);
        if (profile.rate_limit.requests_per_hour) rl.push(`${String(profile.rate_limit.requests_per_hour)}/h`);
        if (profile.rate_limit.requests_per_day) rl.push(`${String(profile.rate_limit.requests_per_day)}/day`);
        if (rl.length > 0) parts.push(`Rate limits: ${rl.join(', ')}`);
      }
      if (profile.endpoints) parts.push(`Endpoints: ${String(profile.endpoints.length)}`);
      if (profile.guidelines) parts.push(`Guidelines: ${String(profile.guidelines.length)}`);
      if (profile.avoid) parts.push(`Avoid rules: ${String(profile.avoid.length)}`);
      parts.push(`Profile saved to ${filePath} and activated immediately.`);
      parts.push('Next steps: ask the user for API credentials if needed, then test with a simple http_request.');
      return parts.join('\n');
    }

    if (input.action === 'delete') {
      const id = input.id ?? input.profile?.id;
      if (!id) {
        return 'Error: "id" is required for delete action.';
      }
      const filePath = join(apisDir, `${id}.json`);
      if (!existsSync(filePath)) {
        return `API profile "${id}" not found.`;
      }
      unlinkSync(filePath);
      return `Deleted API profile "${id}". Changes take effect on next restart.`;
    }

    return 'Unknown action. Use "create", "update", "delete", or "list".';
  },
};
