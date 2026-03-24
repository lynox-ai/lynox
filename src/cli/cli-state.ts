/**
 * Mutable CLI state shared across command handlers and the stream handler.
 *
 * All module-level `let` variables from index.ts are collected here so that
 * extracted command modules can read/write them via a single import.
 */

import type { Nodyn } from '../core/orchestrator.js';
import { MODEL_MAP } from '../types/index.js';
import { Spinner, PROMPT_READY } from './spinner.js';
import { MarkdownStreamer } from './markdown.js';
import { FooterBar } from './footer.js';

export { PROMPT_READY };

// ── Mutable state ──────────────────────────────────────────────────────

export const state = {
  showThinking: false,
  lastResponse: '',
  responseStarted: false,
  currentModelId: MODEL_MAP['sonnet'],
  cliPrompt: null as ((question: string, options?: string[]) => Promise<string>) | null,
  activeNodyn: null as InstanceType<typeof Nodyn> | null,
  thinkingStarted: false,
  showThinkingRendered: false,
  pipeSummaryEnabled: false,
  lastUsage: null as Record<string, number> | null,
  turnCount: 0,
  hadError: false,
  sessionTruncated: false,
  turnStartMs: 0,
  lastGoalKey: '',
};

// ── Shared instances ───────────────────────────────────────────────────

export const spinner = new Spinner();
export const md = new MarkdownStreamer();
export const footer = new FooterBar();
export const toolsUsed = new Set<string>();
