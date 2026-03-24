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
Herr Thomas Müller von der Firma Acme GmbH hat das Projekt "Webshop Redesign" besprochen.
Dr. Schmidt empfiehlt SvelteKit für das Frontend, wir haben uns für PostgreSQL 16 entschieden.
Client Roland betreibt v-skin.ch und nutzt unseren Service seit März.
Company Digitec AG in Zürich hat Interesse an einer Integration gezeigt.
The team uses Docker for deployment and runs on Cloudflare Workers.
Project "nodyn-ai/nodyn" requires Node.js 22+ and TypeScript strict mode.
Partner Maria from Berlin mentioned switching to Lucia v3 for authentication.
Mrs. Weber from Organisation TechHub suggested using Brave Search API.
Located in Bern, the startup chose Tailwind CSS v4 for their design system.
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
