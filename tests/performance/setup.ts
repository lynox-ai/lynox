/**
 * Shared setup for performance benchmarks.
 * Provides temp directory helpers and common constants.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Create an isolated temp directory for benchmark isolation. */
export function createBenchDir(prefix = 'nodyn-bench-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

/** Generate a realistic text payload of approximate character count. */
export function generateText(chars: number): string {
  const words = [
    'nodyn', 'agent', 'pipeline', 'knowledge', 'memory', 'workflow',
    'business', 'customer', 'project', 'analysis', 'report', 'data',
    'integration', 'automation', 'strategy', 'decision', 'process',
    'entity', 'relation', 'context', 'scope', 'retrieval', 'embedding',
  ];
  let text = '';
  let i = 0;
  while (text.length < chars) {
    text += words[i % words.length] + ' ';
    i++;
  }
  return text.slice(0, chars);
}

/** Generate a realistic German/English mixed text for entity extraction benchmarks. */
export function generateEntityText(): string {
  return `
Mr. Thomas Miller from Acme Corp discussed the "Webshop Redesign" project.
Dr. Chen recommends SvelteKit for the frontend, the team chose PostgreSQL 16.
Client James runs example-store.com and has been using the service since March.
Company Globex Inc in New York expressed interest in an integration.
The team uses Docker for deployment and runs on Cloudflare Workers.
Project "example-org/example" requires Node.js 22+ and TypeScript strict mode.
Partner Sarah from London mentioned switching to Lucia v3 for authentication.
Ms. Park from TechHub suggested using Brave Search API.
Located in Austin, the startup chose Tailwind CSS v4 for their design system.
Colleague Alex uses GitHub Actions for CI/CD and migrated to pnpm.
`.trim();
}

/** Generate mock message history for agent truncation benchmarks. */
export function generateMessageHistory(count: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: generateText(500 + Math.floor(Math.random() * 1500)),
    });
  }
  return messages;
}
