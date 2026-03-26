/**
 * API Store CLI commands: /api list, /api show
 */

import type { Session } from '../../core/session.js';
import { BOLD, DIM, GREEN, YELLOW, RESET } from '../ui.js';
import type { CLICtx } from './types.js';

export async function handleApi(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const apiStore = session.engine.getApiStore();

  if (!apiStore || apiStore.size === 0) {
    ctx.stdout.write(
      `${DIM}No API profiles loaded.${RESET}\n\n`
      + `Add profiles to ${BOLD}~/.lynox/apis/${RESET} as JSON files.\n`
      + `Example:\n`
      + `${DIM}{\n`
      + `  "id": "my-api",\n`
      + `  "name": "My API",\n`
      + `  "base_url": "https://api.example.com/v3",\n`
      + `  "description": "What this API does",\n`
      + `  "auth": { "type": "bearer" },\n`
      + `  "rate_limit": { "requests_per_minute": 60 },\n`
      + `  "guidelines": ["Always use POST"],\n`
      + `  "avoid": ["Don't send more than 100 items per request"]\n`
      + `}${RESET}\n`,
    );
    return true;
  }

  const sub = parts[1];

  // /api or /api list
  if (!sub || sub === 'list') {
    const profiles = apiStore.getAll();
    ctx.stdout.write(`${BOLD}Registered APIs (${String(profiles.length)}):${RESET}\n`);
    for (const p of profiles) {
      const limits: string[] = [];
      if (p.rate_limit?.requests_per_second) limits.push(`${String(p.rate_limit.requests_per_second)}/s`);
      if (p.rate_limit?.requests_per_minute) limits.push(`${String(p.rate_limit.requests_per_minute)}/min`);
      if (p.rate_limit?.requests_per_hour) limits.push(`${String(p.rate_limit.requests_per_hour)}/h`);
      if (p.rate_limit?.requests_per_day) limits.push(`${String(p.rate_limit.requests_per_day)}/day`);
      const limitStr = limits.length > 0 ? ` [${limits.join(', ')}]` : '';
      const auth = p.auth ? ` (${p.auth.type})` : '';
      ctx.stdout.write(`  ${GREEN}${p.id}${RESET} — ${p.name}${auth}${limitStr}\n`);
      ctx.stdout.write(`    ${DIM}${p.description}${RESET}\n`);
    }
    return true;
  }

  // /api show <id>
  if (sub === 'show') {
    const id = parts[2];
    if (!id) {
      ctx.stdout.write(`Usage: /api show <id>\n`);
      return true;
    }
    const profile = apiStore.get(id);
    if (!profile) {
      ctx.stdout.write(`${YELLOW}API "${id}" not found.${RESET} Use /api list to see registered APIs.\n`);
      return true;
    }

    ctx.stdout.write(`${BOLD}${profile.name}${RESET} (${profile.id})\n`);
    ctx.stdout.write(`${profile.description}\n\n`);
    ctx.stdout.write(`Base URL: ${profile.base_url}\n`);

    if (profile.auth) {
      ctx.stdout.write(`Auth: ${profile.auth.type}`);
      if (profile.auth.header_name) ctx.stdout.write(` (header: ${profile.auth.header_name})`);
      if (profile.auth.query_param) ctx.stdout.write(` (param: ${profile.auth.query_param})`);
      ctx.stdout.write('\n');
      if (profile.auth.instructions) ctx.stdout.write(`  ${DIM}${profile.auth.instructions}${RESET}\n`);
    }

    if (profile.rate_limit) {
      const parts2: string[] = [];
      if (profile.rate_limit.requests_per_second) parts2.push(`${String(profile.rate_limit.requests_per_second)}/s`);
      if (profile.rate_limit.requests_per_minute) parts2.push(`${String(profile.rate_limit.requests_per_minute)}/min`);
      if (profile.rate_limit.requests_per_hour) parts2.push(`${String(profile.rate_limit.requests_per_hour)}/h`);
      if (profile.rate_limit.requests_per_day) parts2.push(`${String(profile.rate_limit.requests_per_day)}/day`);
      ctx.stdout.write(`Rate limit: ${parts2.join(', ')}\n`);
    }

    if (profile.endpoints && profile.endpoints.length > 0) {
      ctx.stdout.write(`\n${BOLD}Endpoints:${RESET}\n`);
      for (const ep of profile.endpoints) {
        ctx.stdout.write(`  ${ep.method} ${ep.path} — ${ep.description}\n`);
      }
    }

    if (profile.guidelines && profile.guidelines.length > 0) {
      ctx.stdout.write(`\n${GREEN}${BOLD}Guidelines:${RESET}\n`);
      for (const g of profile.guidelines) ctx.stdout.write(`  ${GREEN}+${RESET} ${g}\n`);
    }

    if (profile.avoid && profile.avoid.length > 0) {
      ctx.stdout.write(`\n${YELLOW}${BOLD}Avoid:${RESET}\n`);
      for (const a of profile.avoid) ctx.stdout.write(`  ${YELLOW}-${RESET} ${a}\n`);
    }

    if (profile.notes && profile.notes.length > 0) {
      ctx.stdout.write(`\n${DIM}Notes:${RESET}\n`);
      for (const n of profile.notes) ctx.stdout.write(`  ${DIM}${n}${RESET}\n`);
    }
    return true;
  }

  ctx.stdout.write(
    `${BOLD}Usage:${RESET}\n`
    + `  /api           List registered API profiles\n`
    + `  /api show <id> Show details of an API profile\n`,
  );
  return true;
}
