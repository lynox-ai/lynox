/**
 * /quickstart — Interactive guided first steps for new users.
 * Context-aware: detects connected integrations and suggests relevant tasks.
 */

import type { Session } from '../../core/session.js';
import { BOLD, DIM, BLUE, GREEN, RESET } from '../ui.js';
import { spinner } from '../cli-state.js';
import { existsSync, readdirSync } from 'node:fs';
import type { CLICtx } from './types.js';

interface QuickstartTask {
  label: string;
  task: string | null;
  description: string;
}

function buildTasks(session: Session): QuickstartTask[] {
  const tasks: QuickstartTask[] = [];
  const config = session.getUserConfig();

  // If Google is connected, suggest email
  const hasGoogle = !!(config.google_client_id || process.env['GOOGLE_CLIENT_ID']);
  if (hasGoogle) {
    tasks.push({
      label: 'Check my emails',
      task: 'Check my recent emails and tell me what needs attention. Summarize the important ones and draft replies if needed.',
      description: 'nodyn reads your inbox and drafts replies',
    });
  }

  // If there are files in the working directory, suggest exploring them
  let hasFiles = false;
  try {
    const entries = readdirSync('.').filter(e => !e.startsWith('.'));
    hasFiles = entries.length > 0;
  } catch { /* empty dir or no access */ }

  if (hasFiles) {
    tasks.push({
      label: 'What\'s in this folder?',
      task: 'Look at the files in this directory and give me a brief overview of what\'s here.',
      description: 'nodyn reads your files and explains what it finds',
    });
  }

  // Always offer research
  tasks.push({
    label: 'Research something for me',
    task: null, // user types their own topic
    description: 'tell nodyn a topic — it searches, summarizes, and remembers',
  });

  // If no Google and no files, add a conversational starter
  if (!hasGoogle && !hasFiles) {
    tasks.unshift({
      label: 'Tell me what you can do',
      task: 'Introduce yourself briefly. Then show me 3 concrete things you could help me with right now — keep it simple and practical.',
      description: 'see what nodyn can do for you',
    });
  }

  return tasks;
}

export async function handleQuickstart(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const tasks = buildTasks(session);

  ctx.stdout.write(`\n${BLUE}${BOLD}  Quick Start${RESET}\n`);
  ctx.stdout.write(`${DIM}  Try one of these to get started:${RESET}\n\n`);

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i]!;
    ctx.stdout.write(`  ${BOLD}${i + 1}.${RESET} ${t.label}\n`);
    ctx.stdout.write(`     ${DIM}${t.description}${RESET}\n`);
  }

  const options = tasks.map((_, i) => String(i + 1));
  ctx.stdout.write(`\n${DIM}  Pick a number (1-${tasks.length}) or press Enter to skip:${RESET} `);

  if (!ctx.cliPrompt) {
    ctx.stdout.write(`\n${DIM}Or just type a task at the prompt — nodyn is ready.${RESET}\n\n`);
    return true;
  }

  const answer = await ctx.cliPrompt(`Pick a number (1-${tasks.length})`, options);
  const idx = parseInt(answer.trim(), 10) - 1;

  if (idx < 0 || idx >= tasks.length) {
    ctx.stdout.write(`\n${DIM}No worries — just type any task at the prompt. nodyn is ready.${RESET}\n\n`);
    return true;
  }

  const selected = tasks[idx]!;

  if (selected.task === null) {
    ctx.stdout.write(`\n${DIM}Type what you want to research at the prompt.${RESET}\n`);
    ctx.stdout.write(`${DIM}nodyn will search, summarize, and remember what it finds.${RESET}\n\n`);
    return true;
  }

  ctx.stdout.write(`\n${DIM}Running: ${selected.label}${RESET}\n\n`);

  try {
    spinner.start('Working...');
    await session.run(selected.task);
  } catch {
    spinner.stop();
  }

  ctx.stdout.write(`\n${GREEN}✓${RESET} That's how nodyn works. Just type what you need at the prompt.\n\n`);
  return true;
}
