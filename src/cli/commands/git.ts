/**
 * Git-related CLI commands: /git, /pr, /diff
 */

import { stderr } from 'node:process';

import type { Nodyn } from '../../core/orchestrator.js';
import { getErrorMessage } from '../../core/utils.js';
import { renderError, BOLD, DIM, BLUE, GREEN, YELLOW, RESET } from '../ui.js';
import { spinner } from '../cli-state.js';
import { gitExec } from '../cli-helpers.js';
import type { CLICtx } from './types.js';

export async function handleGit(parts: string[], _nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1] ?? 'status';
  switch (sub) {
    case 'status': {
      const branch = gitExec('branch --show-current');
      const tracking = gitExec('rev-parse --abbrev-ref @{upstream}');
      const ahead = gitExec('rev-list @{upstream}..HEAD --count');
      const behind = gitExec('rev-list HEAD..@{upstream} --count');
      const status = gitExec('status --short');

      ctx.stdout.write(`${BOLD}Git Status${RESET}  ${DIM}${branch}${RESET}`);
      if (tracking && !tracking.startsWith('fatal')) {
        const info: string[] = [];
        if (ahead && ahead !== '0') info.push(`${ahead} ahead`);
        if (behind && behind !== '0') info.push(`${behind} behind`);
        if (info.length > 0) ctx.stdout.write(`  ${YELLOW}${info.join(', ')}${RESET}`);
      }
      ctx.stdout.write('\n');
      ctx.stdout.write(status ? `${status}\n` : `${DIM}Clean working tree.${RESET}\n`);
      break;
    }
    case 'diff': {
      const diffOut = gitExec('diff --stat');
      ctx.stdout.write(`${BOLD}Git Diff${RESET}\n`);
      ctx.stdout.write(diffOut ? `${diffOut}\n` : `${DIM}No uncommitted changes.${RESET}\n`);
      break;
    }
    case 'log':
      ctx.stdout.write(`${BOLD}Git Log${RESET}\n${gitExec('log --oneline -15')}\n`);
      break;
    case 'branch':
      ctx.stdout.write(`${BOLD}Branches${RESET}\n${gitExec('branch -a')}\n`);
      break;
    default:
      ctx.stdout.write(`${BOLD}Git${RESET}\n${gitExec(parts.slice(1).join(' '))}\n`);
  }
  return true;
}

export async function handlePr(_parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const diff = gitExec('diff main...HEAD --stat');
  const log = gitExec('log main...HEAD --oneline');
  const prompt = `Generate a concise PR description for these changes:\n\nCommits:\n${log}\n\nDiff summary:\n${diff}`;
  try {
    spinner.start('Generating PR description...');
    await nodyn.run(prompt);
  } catch (err: unknown) {
    spinner.stop();
    stderr.write(renderError(getErrorMessage(err)));
  }
  return true;
}

export async function handleDiff(_parts: string[], _nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const diffStat = gitExec('diff --stat');
  const diffFull = gitExec('diff');
  if (!diffStat && !diffFull) {
    ctx.stdout.write('No uncommitted changes.\n');
  } else {
    ctx.stdout.write(`${BOLD}Uncommitted Changes${RESET}\n${diffStat}\n`);
    if (diffFull) {
      ctx.stdout.write(`\n${diffFull}\n`);
    }
  }
  return true;
}
