/**
 * /quickstart — Interactive guided first steps for new users.
 * Shows 3 starter tasks to demonstrate nodyn's capabilities.
 */

import type { Nodyn } from '../../core/orchestrator.js';
import { BOLD, DIM, BLUE, GREEN, RESET } from '../ui.js';
import { spinner } from '../cli-state.js';
import type { CLICtx } from './types.js';

const QUICKSTART_TASKS = [
  {
    label: 'Explore this project',
    task: 'What is this project about? Give a brief overview of the directory structure and key files.',
    description: 'nodyn reads your files and explains the project',
  },
  {
    label: 'Summarize recent git activity',
    task: 'Summarize the last 10 git commits. Group by theme and highlight important changes.',
    description: 'nodyn uses tools (git, file reading) autonomously',
  },
  {
    label: 'Ask a business question',
    task: null, // user types their own
    description: 'type any question about your work — nodyn remembers the answer',
  },
] as const;

export async function handleQuickstart(_parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  ctx.stdout.write(`\n${BLUE}${BOLD}  Quick Start${RESET}\n`);
  ctx.stdout.write(`${DIM}  Try these to see what nodyn can do:${RESET}\n\n`);

  for (let i = 0; i < QUICKSTART_TASKS.length; i++) {
    const t = QUICKSTART_TASKS[i]!;
    ctx.stdout.write(`  ${BOLD}${i + 1}.${RESET} ${t.label}\n`);
    ctx.stdout.write(`     ${DIM}${t.description}${RESET}\n`);
  }

  ctx.stdout.write(`\n${DIM}  Pick a number (1-3) or press Enter to skip:${RESET} `);

  if (!ctx.cliPrompt) {
    ctx.stdout.write(`\n${DIM}Or just type a task at the prompt — nodyn is ready.${RESET}\n\n`);
    return true;
  }

  const answer = await ctx.cliPrompt('Pick a number (1-3)', ['1', '2', '3']);
  const idx = parseInt(answer.trim(), 10) - 1;

  if (idx < 0 || idx >= QUICKSTART_TASKS.length) {
    ctx.stdout.write(`\n${DIM}No worries — just type any task at the prompt. nodyn is ready.${RESET}\n\n`);
    return true;
  }

  const selected = QUICKSTART_TASKS[idx]!;

  if (selected.task === null) {
    ctx.stdout.write(`\n${DIM}Type any question about your work at the prompt.${RESET}\n`);
    ctx.stdout.write(`${DIM}nodyn will remember what you tell it.${RESET}\n\n`);
    return true;
  }

  ctx.stdout.write(`\n${DIM}Running: ${selected.task}${RESET}\n\n`);

  try {
    spinner.start('Working...');
    await nodyn.run(selected.task);
  } catch {
    spinner.stop();
  }

  ctx.stdout.write(`\n${GREEN}✓${RESET} That's how nodyn works. Type ${BOLD}/help${RESET} for all commands.\n\n`);
  return true;
}
