/**
 * The owner's sentence for a self-hosted instance whose durable knowledge did not load (ux U-048,
 * case 2) tells them to look for one of two lines in the engine's start-up log. It quotes their
 * prefixes. This test holds those prefixes against the code that writes them, so a rewording of
 * either log line fails here instead of leaving the sentence pointing at a line that no longer
 * exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { durableMemoryState } from './memory-tool-set.js';

const ENGINE = readFileSync(fileURLToPath(new URL('./engine.ts', import.meta.url)), 'utf8');

/** The prefixes the U-048 sentence names, verbatim. */
const DURABLE_MEMORY_LOG_PREFIXES = ['[lynox] EngineDb init failed', '[lynox] durable-memory wiring failed'] as const;

describe('the log lines the U-048 sentence names', () => {
  it.each(DURABLE_MEMORY_LOG_PREFIXES)('engine.ts writes %s to stderr', (prefix) => {
    expect(ENGINE).toContain(`process.stderr.write(\`${prefix}: `);
  });
});

describe('durableMemoryState', () => {
  it('maps each reason to its one word', () => {
    expect(durableMemoryState(null)).toBe('on');
    expect(durableMemoryState('dk_off')).toBe('off');
    expect(durableMemoryState('store_missing')).toBe('not_loaded');
  });
});
