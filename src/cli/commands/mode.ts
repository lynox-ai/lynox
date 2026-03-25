/**
 * Mode-related CLI commands: /mode, /roles, /profile
 */

import { stderr } from 'node:process';

import type { Session } from '../../core/session.js';
import type { ModeConfig, OperationalMode } from '../../types/index.js';
import { MODEL_MAP, MODE_DISPLAY, MODE_FROM_DISPLAY } from '../../types/index.js';
import { loadRole, listRoles, saveRole, exportRole, importRole, deleteRole } from '../../core/roles.js';
import { listPlaybooks, savePlaybook, exportPlaybook, importPlaybook, deletePlaybook } from '../../core/playbooks.js';
import type { Playbook } from '../../types/index.js';
import { getErrorMessage } from '../../core/utils.js';
import { listProfiles, loadProfile } from '../profiles.js';
import { renderTable, renderError, BOLD, DIM, BLUE, GREEN, RESET } from '../ui.js';
import { state, spinner } from '../cli-state.js';
import type { CLICtx } from './types.js';

// We need getValidModes from the parent module. Import from index.ts would create a circular dep.
// Instead, we accept it as a parameter or import from the registry.
// The dispatcher passes getValidModes via a module-level setter.
let _getValidModes: () => string[] = () => ['interactive', 'autopilot'];

export function setGetValidModes(fn: () => string[]): void {
  _getValidModes = fn;
}

export async function handleMode(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const line = parts.join(' ');
  // Accept both internal names (interactive, daemon) and display names (assistant, background)
  const rawName = parts[1]?.toLowerCase();
  const modeName = (rawName ? (MODE_FROM_DISPLAY[rawName] ?? rawName) : undefined) as OperationalMode | undefined;
  const validModes = _getValidModes();

  if (!modeName) {
    const currentMode = session.getMode();

    if (ctx.cliPrompt) {
      // Interactive mode selection
      const modeDescriptions: Record<string, string> = {
        interactive: 'Assistant — works with you step by step',
        autopilot: 'Autopilot — runs independently toward a goal',
        sentinel: 'Watchdog — monitors and alerts you',
        daemon: 'Background — runs on a schedule, fully autonomous',
        swarm: 'Team — multiple agents work in parallel',
      };
      const options = validModes.map(m => {
        const display = MODE_DISPLAY[m as OperationalMode] ?? m;
        return m === currentMode
          ? `${display} — ${modeDescriptions[m] ?? ''}  ${DIM}current${RESET}`
          : `${display} — ${modeDescriptions[m] ?? ''}`;
      });
      const answer = await ctx.cliPrompt('Select mode:', [...options, '\x00']);
      if (!answer) return true;
      const idx = options.indexOf(answer);
      if (idx < 0) return true;
      // Re-dispatch with selected mode name
      const selected = validModes[idx]!;
      return handleMode(['/mode', selected], session, ctx);
    }

    // Non-TTY fallback: show current mode info
    const goalState = session.getGoalState();
    const costSnap = session.getCostSnapshot();
    const currentDisplay = MODE_DISPLAY[currentMode as OperationalMode] ?? currentMode;
    ctx.stdout.write(`${BOLD}Mode:${RESET} ${currentDisplay}\n`);
    if (goalState) {
      const completed = goalState.subtasks.filter(s => s.status === 'complete').length;
      ctx.stdout.write(`${DIM}Goal:${RESET} ${goalState.goal} [${completed}/${goalState.subtasks.length} — ${goalState.status}]\n`);
    }
    if (costSnap) {
      ctx.stdout.write(`${DIM}Cost:${RESET} $${costSnap.estimatedCostUSD.toFixed(4)} (${costSnap.budgetPercent}% budget, ${costSnap.iterationsUsed} iterations)\n`);
    }
    ctx.stdout.write(`${DIM}Usage: /mode <${validModes.join('|')}> ["goal"] [--budget N]${RESET}\n`);
    return true;
  }

  if (!validModes.includes(modeName)) {
    ctx.stdout.write(`Unknown mode: ${modeName}. Valid: ${validModes.join(', ')}\n`);
    return true;
  }

  if (modeName === 'interactive') {
    await session.setMode({ mode: 'interactive' });
    ctx.stdout.write(`${GREEN}✓${RESET} Switched to assistant mode.\n`);
    return true;
  }

  // Extract goal from quotes: /mode autopilot "Build X"
  const goalMatch = line.match(/"([^"]+)"/);
  let goal = goalMatch?.[1];

  // Extract --budget
  const budgetMatch = line.match(/--budget\s+([\d.]+)/);
  let budget: number | undefined;
  if (budgetMatch?.[1] !== undefined) {
    const parsedBudget = Number(budgetMatch[1]);
    if (!Number.isFinite(parsedBudget) || parsedBudget <= 0) {
      ctx.stdout.write('Invalid budget. Use a positive number, e.g. --budget 5\n');
      return true;
    }
    budget = parsedBudget;
  }

  // For modes that require a goal, prompt if missing
  if (!goal && (modeName === 'autopilot' || modeName === 'swarm' || modeName === 'daemon')) {
    if (ctx.cliPrompt) {
      goal = await ctx.cliPrompt('Enter goal:');
      if (!goal) return true;
    } else {
      ctx.stdout.write(`${modeName} mode requires a goal. Usage: /mode ${modeName} "your goal"\n`);
      return true;
    }
  }

  // For sentinel, check for --watch
  let modeConfig: ModeConfig;
  if (modeName === 'sentinel') {
    const watchMatch = line.match(/--watch\s+(\S+)/);
    const onChangeMatch = line.match(/--on-change\s+"([^"]+)"/);
    const watchDir = watchMatch?.[1] ?? '.';
    const taskTemplate = onChangeMatch?.[1] ?? goal ?? 'Review changes in {files}';
    modeConfig = {
      mode: 'sentinel',
      autonomy: 'guided',
      triggers: [{ type: 'file', dir: watchDir }],
      taskTemplate,
      costGuard: budget ? { maxBudgetUSD: budget } : undefined,
    };
  } else {
    modeConfig = {
      mode: modeName,
      goal,
      costGuard: { maxBudgetUSD: budget ?? 5 },
    };
  }

  try {
    await session.setMode(modeConfig);
    const displayMode = MODE_DISPLAY[modeName as OperationalMode] ?? modeName;
    ctx.stdout.write(`${GREEN}✓${RESET} Mode: ${BOLD}${displayMode}${RESET}`);
    if (goal) ctx.stdout.write(` — ${DIM}${goal}${RESET}`);
    if (budget) ctx.stdout.write(` ${DIM}(budget: $${budget})${RESET}`);
    ctx.stdout.write('\n');

    // For autopilot/swarm, immediately start running the goal
    if ((modeName === 'autopilot' || modeName === 'swarm') && goal) {
      try {
        const spinnerLabel = MODE_DISPLAY[modeName as OperationalMode] ?? modeName;
        spinner.start(`${spinnerLabel} working...`);
        await session.run(goal);
      } catch (err: unknown) {
        spinner.stop();
        stderr.write(renderError(getErrorMessage(err)));
      }
    }
  } catch (err: unknown) {
    stderr.write(renderError(getErrorMessage(err)));
  }
  return true;
}

export async function handleRoles(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];

  if (!sub || sub === 'list') {
    const roles = listRoles();
    if (roles.length === 0) {
      ctx.stdout.write('No roles available.\n');
    } else {
      const rows = roles.map(a => [a.id, a.source, a.model ?? '-', a.description.slice(0, 50)]);
      ctx.stdout.write(renderTable(['ID', 'Source', 'Model', 'Description'], rows) + '\n');
    }
    return true;
  }

  if (sub === 'show') {
    const roleId = parts[2];
    if (!roleId) {
      ctx.stdout.write('Usage: /roles show <id>\n');
      return true;
    }
    try {
      const json = exportRole(roleId);
      if (!json) {
        ctx.stdout.write(`Role "${roleId}" not found. Use /roles list to see available roles.\n`);
      } else {
        ctx.stdout.write(json + '\n');
      }
    } catch (err: unknown) {
      ctx.stdout.write(renderError(getErrorMessage(err)));
    }
    return true;
  }

  if (sub === 'create') {
    const roleId = parts[2];
    if (!roleId) {
      ctx.stdout.write('Usage: /roles create <id>\n');
      return true;
    }
    try {
      saveRole({
        id: roleId,
        name: roleId,
        description: `Custom role: ${roleId}`,
        version: '1.0.0',
        systemPrompt: 'You are a specialized agent. Describe your purpose here.',
      });
      ctx.stdout.write(`${GREEN}\u2713${RESET} Role "${roleId}" created at ~/.nodyn/roles/${roleId}.json\n`);
      ctx.stdout.write(`${DIM}Edit the file to customize model, tools, system prompt, etc.${RESET}\n`);
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Create failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  if (sub === 'delete') {
    const roleId = parts[2];
    if (!roleId) {
      ctx.stdout.write('Usage: /roles delete <id>\n');
      return true;
    }
    try {
      const deleted = deleteRole(roleId);
      if (deleted) {
        ctx.stdout.write(`${GREEN}\u2713${RESET} Role "${roleId}" deleted.\n`);
      } else {
        ctx.stdout.write(`Role "${roleId}" not found in user roles directory.\n`);
      }
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Delete failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  if (sub === 'import') {
    const importPath = parts[2];
    if (!importPath) {
      ctx.stdout.write('Usage: /roles import <path/to/role.json>\n');
      return true;
    }
    try {
      const imported = importRole(importPath);
      ctx.stdout.write(`${GREEN}\u2713${RESET} Role "${imported.id}" imported.\n`);
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Import failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  if (sub === 'export') {
    const roleId = parts[2];
    if (!roleId) {
      ctx.stdout.write('Usage: /roles export <id>\n');
      return true;
    }
    try {
      const json = exportRole(roleId);
      if (!json) {
        ctx.stdout.write(`Role "${roleId}" not found.\n`);
      } else {
        ctx.stdout.write(json + '\n');
      }
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Export failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  // Direct role apply: /roles <name>
  let role: import('../../types/index.js').Role | null = null;
  try {
    role = loadRole(sub);
  } catch (err: unknown) {
    ctx.stdout.write(renderError(getErrorMessage(err)));
    return true;
  }
  if (!role) {
    ctx.stdout.write(`Role "${sub}" not found. Use /roles list to see available roles.\n`);
    return true;
  }

  // Apply role overrides
  if (role.model && role.model in MODEL_MAP) {
    const resolved = session.setModel(role.model);
    state.currentModelId = resolved;
  }
  if (role.effort) {
    session.setEffort(role.effort);
  }
  if (role.systemPrompt || role.deniedTools) {
    session._recreateAgent({
      systemPromptSuffix: role.systemPrompt ? `\n\n${role.systemPrompt}` : undefined,
      excludeTools: role.deniedTools,
      autonomy: role.autonomy,
    });
  }

  ctx.stdout.write(`${GREEN}\u2713${RESET} Role "${role.name}" applied.`);
  if (role.model) ctx.stdout.write(` Model: ${role.model}`);
  if (role.effort) ctx.stdout.write(` Effort: ${role.effort}`);
  ctx.stdout.write('\n');
  return true;
}

export async function handlePlaybooks(parts: string[], _session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];

  if (!sub || sub === 'list') {
    const playbooks = listPlaybooks();
    if (playbooks.length === 0) {
      ctx.stdout.write('No playbooks available.\n');
    } else {
      const rows = playbooks.map(p => [p.id, p.source, String(p.phaseCount), p.description.slice(0, 50)]);
      ctx.stdout.write(renderTable(['ID', 'Source', 'Phases', 'Description'], rows) + '\n');
    }
    return true;
  }

  if (sub === 'show') {
    const pbId = parts[2];
    if (!pbId) {
      ctx.stdout.write('Usage: /playbooks show <id>\n');
      return true;
    }
    try {
      const json = exportPlaybook(pbId);
      if (!json) {
        ctx.stdout.write(`Playbook "${pbId}" not found. Use /playbooks list to see available playbooks.\n`);
      } else {
        ctx.stdout.write(json + '\n');
      }
    } catch (err: unknown) {
      ctx.stdout.write(renderError(getErrorMessage(err)));
    }
    return true;
  }

  if (sub === 'create') {
    const pbId = parts[2];
    if (!pbId) {
      ctx.stdout.write('Usage: /playbooks create <id>\n');
      return true;
    }
    try {
      const scaffold: Playbook = {
        id: pbId,
        name: pbId,
        description: `Custom playbook: ${pbId}`,
        version: '1.0.0',
        phases: [
          { name: 'Phase 1', description: 'Describe what to do in this phase' },
        ],
      };
      savePlaybook(scaffold);
      ctx.stdout.write(`${GREEN}\u2713${RESET} Playbook "${pbId}" created at ~/.nodyn/playbooks/${pbId}.json\n`);
      ctx.stdout.write(`${DIM}Edit the file to add phases, parameters, and recommended roles.${RESET}\n`);
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Create failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  if (sub === 'delete') {
    const pbId = parts[2];
    if (!pbId) {
      ctx.stdout.write('Usage: /playbooks delete <id>\n');
      return true;
    }
    try {
      const deleted = deletePlaybook(pbId);
      if (deleted) {
        ctx.stdout.write(`${GREEN}\u2713${RESET} Playbook "${pbId}" deleted.\n`);
      } else {
        ctx.stdout.write(`Playbook "${pbId}" not found in user playbooks directory.\n`);
      }
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Delete failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  if (sub === 'import') {
    const importPath = parts[2];
    if (!importPath) {
      ctx.stdout.write('Usage: /playbooks import <path/to/playbook.json>\n');
      return true;
    }
    try {
      const imported = importPlaybook(importPath);
      ctx.stdout.write(`${GREEN}\u2713${RESET} Playbook "${imported.id}" imported.\n`);
    } catch (err: unknown) {
      ctx.stdout.write(renderError(`Import failed: ${getErrorMessage(err)}`));
    }
    return true;
  }

  ctx.stdout.write(`Unknown subcommand "${sub}". Available: list, show, create, delete, import\n`);
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
        if (session.getMode() === 'interactive') {
          session._recreateAgent({
            systemPromptSuffix: `\n\n${profile.systemPrompt}`,
          });
          applied.push('systemPrompt');
        } else {
          skipped.push('systemPrompt (skipped outside interactive mode)');
        }
      }

      if (profile.tools && profile.tools.length > 0) {
        skipped.push('tools (unsupported in profiles; use templates)');
      }

      ctx.stdout.write(`${GREEN}✓${RESET} Profile "${profileName}" loaded`);
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
