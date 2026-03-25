/**
 * Mode-related CLI commands: /mode, /roles, /profile
 */

import type { Session } from '../../core/session.js';
import { BUILTIN_ROLES, getRoleNames } from '../../core/roles.js';
import { listProfiles, loadProfile } from '../profiles.js';
import { renderTable, BOLD, DIM, BLUE, GREEN, RESET } from '../ui.js';
import { state } from '../cli-state.js';
import type { CLICtx } from './types.js';

export async function handleMode(_parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  ctx.stdout.write(`${BOLD}Mode:${RESET} interactive (assistant)\n`);
  ctx.stdout.write(`${DIM}nodyn always runs in interactive mode. For background work, use task_create with assignee "nodyn".${RESET}\n`);
  return true;
}

export async function handleRoles(parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];

  if (sub === 'show') {
    const roleId = parts[2];
    if (!roleId) {
      ctx.stdout.write('Usage: /roles show <id>\n');
      return true;
    }
    const role = BUILTIN_ROLES[roleId];
    if (!role) {
      ctx.stdout.write(`Role "${roleId}" not found. Use /roles to see available roles.\n`);
      return true;
    }
    ctx.stdout.write(`${BOLD}${roleId}${RESET}\n`);
    ctx.stdout.write(`  Model:     ${role.model}\n`);
    ctx.stdout.write(`  Effort:    ${role.effort}\n`);
    ctx.stdout.write(`  Autonomy:  ${role.autonomy}\n`);
    if (role.denyTools) ctx.stdout.write(`  Denied:    ${role.denyTools.join(', ')}\n`);
    if (role.allowTools) ctx.stdout.write(`  Allowed:   ${role.allowTools.join(', ')}\n`);
    ctx.stdout.write(`  ${DIM}${role.description}${RESET}\n`);
    return true;
  }

  // Default: list all roles
  const names = getRoleNames();
  if (names.length === 0) {
    ctx.stdout.write('No roles available.\n');
    return true;
  }
  const rows = names.map(name => {
    const r = BUILTIN_ROLES[name]!;
    return [name, r.model, r.effort, r.description];
  });
  ctx.stdout.write(renderTable(['Role', 'Model', 'Effort', 'Description'], rows) + '\n');
  ctx.stdout.write(`${DIM}Use roles via spawn_agent or pipeline steps (role field).${RESET}\n`);
  return true;
}

export async function handleProfile(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const profileName = parts[1];
  if (!profileName || profileName === 'list') {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      ctx.stdout.write(`No profiles found. Create them in ${DIM}~/.nodyn/profiles/{name}.json${RESET}\n`);
    } else {
      ctx.stdout.write(`${BOLD}Profiles:${RESET}\n`);
      for (const p of profiles) {
        ctx.stdout.write(`  ${BLUE}${p}${RESET}\n`);
      }
    }
  } else {
    const profile = loadProfile(profileName);
    if (!profile) {
      ctx.stdout.write(`Profile "${profileName}" not found.\n`);
    } else {
      const applied: string[] = [];
      const skipped: string[] = [];

      if (profile.model) {
        const resolved = session.setModel(profile.model);
        state.currentModelId = resolved;
        applied.push(`model=${profile.model}`);
      }

      if (profile.effort && ['low', 'medium', 'high', 'max'].includes(profile.effort)) {
        session.setEffort(profile.effort as 'low' | 'medium' | 'high' | 'max');
        applied.push(`effort=${profile.effort}`);
      }

      if (profile.systemPrompt) {
        session._recreateAgent({
          systemPromptSuffix: `\n\n${profile.systemPrompt}`,
        });
        applied.push('systemPrompt');
      }

      if (profile.tools && profile.tools.length > 0) {
        skipped.push('tools (unsupported in profiles; use templates)');
      }

      ctx.stdout.write(`${GREEN}\u2713${RESET} Profile "${profileName}" loaded`);
      if (applied.length > 0) {
        ctx.stdout.write(` — applied: ${applied.join(', ')}`);
      }
      ctx.stdout.write('.\n');
      if (skipped.length > 0) {
        ctx.stdout.write(`${DIM}${skipped.join(', ')}.${RESET}\n`);
      }
    }
  }
  return true;
}
