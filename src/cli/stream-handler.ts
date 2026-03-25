/**
 * Stream event handler for CLI output.
 *
 * Renders text, thinking, tool calls, pipeline progress, and other
 * streaming events from the agent to the terminal.
 */

import { stderr } from 'node:process';

import type { StreamEvent } from '../types/index.js';
import { CONTEXT_WINDOW } from '../types/index.js';
import { renderToolCall, renderToolResult, renderSpawn, renderError, renderThinking, BOLD, DIM, BLUE, GREEN, RED, MAGENTA, RESET } from './ui.js';
import { state, spinner, md, footer, toolsUsed } from './cli-state.js';

// ── Pipeline DAG Renderer (in-place updates) ──────────────────────────

export const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const pipelineSteps = new Map<string, { status: 'running' | 'done' | 'failed' | 'skipped'; startedAt: number; durationMs?: number; detail?: string }>();
let pipelineRenderedLines = 0;
let pipelineSpinnerIdx = 0;
let pipelineHeartbeat: ReturnType<typeof setInterval> | null = null;

export function renderPipelineBlock(_stdout: NodeJS.WriteStream): string {
  pipelineSpinnerIdx = (pipelineSpinnerIdx + 1) % BRAILLE.length;
  let out = '';
  for (const [stepId, step] of pipelineSteps) {
    const elapsed = step.durationMs ?? Math.round((Date.now() - step.startedAt) / 1000) * 1000;
    const secs = Math.round(elapsed / 1000);
    const pad = ' '.repeat(Math.max(1, 28 - stepId.length));
    if (step.status === 'running') {
      out += `  ${BLUE}${BRAILLE[pipelineSpinnerIdx]}${RESET} ${stepId}${pad}${DIM}${secs}s${RESET}\n`;
    } else if (step.status === 'done') {
      out += `  ${GREEN}✓${RESET} ${stepId}${pad}${DIM}${secs}s${RESET}\n`;
    } else if (step.status === 'failed') {
      out += `  ${RED}✗${RESET} ${stepId}${pad}${DIM}${step.detail ?? ''}${RESET}\n`;
    } else {
      out += `  ${DIM}⊘ ${stepId}${pad}${step.detail ?? ''}${RESET}\n`;
    }
  }
  return out;
}

export function redrawPipelineBlock(stdout: NodeJS.WriteStream): void {
  if (pipelineSteps.size === 0) return;
  // Move cursor up and clear previous render
  if (pipelineRenderedLines > 0) {
    stdout.write(`\x1b[${pipelineRenderedLines}A`);
  }
  const block = renderPipelineBlock(stdout);
  const lines = block.split('\n').filter(l => l.length > 0);
  for (const line of lines) {
    stdout.write(`\x1b[2K${line}\n`); // clear line + write
  }
  // Clear any leftover lines from previous render
  for (let i = lines.length; i < pipelineRenderedLines; i++) {
    stdout.write('\x1b[2K\n');
  }
  pipelineRenderedLines = Math.max(lines.length, pipelineRenderedLines);
}

export function startPipelineHeartbeat(stdout: NodeJS.WriteStream): void {
  if (pipelineHeartbeat) return;
  pipelineHeartbeat = setInterval(() => redrawPipelineBlock(stdout), 500);
}

export function stopPipelineHeartbeat(): void {
  if (pipelineHeartbeat) {
    clearInterval(pipelineHeartbeat);
    pipelineHeartbeat = null;
  }
}

export function resetPipelineRenderer(): void {
  stopPipelineHeartbeat();
  pipelineSteps.clear();
  pipelineRenderedLines = 0;
}

// ── Stream event handler ───────────────────────────────────────────────

export function streamHandler(event: StreamEvent, stdout: NodeJS.WriteStream): void {
  if (spinner.isActive() && event.type !== 'turn_end' && event.type !== 'thinking') {
    spinner.stop();
    if (!state.responseStarted) {
      stdout.write(`👾 `);
      state.responseStarted = true;
    }
  }

  switch (event.type) {
    case 'text':
      if (state.thinkingStarted) {
        spinner.stop();
        if (state.showThinkingRendered) {
          stdout.write('\n');
        }
        if (!state.responseStarted) {
          stdout.write(`👾 `);
          state.responseStarted = true;
        }
        state.thinkingStarted = false;
        state.showThinkingRendered = false;
      }
      state.lastResponse += event.text;
      stdout.write(md.push(event.text));
      break;

    case 'thinking':
      if (!state.thinkingStarted) {
        state.thinkingStarted = true;
      }
      if (state.showThinking) {
        // Detailed mode: stop spinner to show thinking text inline
        if (spinner.isActive()) {
          spinner.stop();
          if (!state.responseStarted) {
            stdout.write(`👾 `);
            state.responseStarted = true;
          }
        }
        stdout.write(renderThinking(event.thinking, state.thinkingStarted && !state.showThinkingRendered));
        state.showThinkingRendered = true;
      }
      // Daily mode (showThinking=false): spinner keeps running
      break;

    case 'tool_call':
      toolsUsed.add(event.name);
      stdout.write(renderToolCall(event.name, event.input));
      spinner.start('Running...');
      break;

    case 'tool_result':
      stdout.write(renderToolResult(event.name));
      break;

    case 'spawn':
      stdout.write(renderSpawn(event.agents, event.estimatedCostUSD));
      break;

    case 'turn_end': {
      spinner.stop();
      state.thinkingStarted = false;
      state.showThinkingRendered = false;
      stdout.write(md.flush());
      stdout.write('\n');
      md.reset();
      state.lastUsage = event.usage as unknown as Record<string, number>;
      state.turnCount++;
      if (footer.isActivated()) {
        const inTok = event.usage.input_tokens
          + (event.usage.cache_creation_input_tokens ?? 0)
          + (event.usage.cache_read_input_tokens ?? 0);
        const outTok = event.usage.output_tokens;
        const tokens = `${inTok.toLocaleString()} in / ${outTok.toLocaleString()} out`;
        const maxCtx = CONTEXT_WINDOW[state.currentModelId] ?? 200_000;
        const pctRaw = Math.min(100, (inTok / maxCtx) * 100);
        const pct = Math.round(pctRaw * 10) / 10;
        const filled = Math.round(pct / 10);
        const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
        const color = pct >= 80 ? RED : pct >= 50 ? '\x1b[33m' : GREEN;
        const pctStr = pct < 10 ? pct.toFixed(1) : Math.round(pct).toString();
        const cacheRead = event.usage.cache_read_input_tokens ?? 0;
        const cacheCreate = event.usage.cache_creation_input_tokens ?? 0;
        const cacheTotal = event.usage.input_tokens + cacheCreate + cacheRead;
        const cachePct = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;
        const cacheSuffix = (cacheRead > 0 || cacheCreate > 0)
          ? `  ${cachePct >= 50 ? GREEN : DIM}cache ${cachePct}%${RESET}`
          : '';
        // Mode indicator (always interactive now)
        const modeSuffix = '';
        const truncMark = state.sessionTruncated ? '*' : '';
        const thinkingSuffix = state.showThinking ? `  ${DIM}👾 detailed${RESET}` : '';
        const elapsedMs = state.turnStartMs > 0 ? Date.now() - state.turnStartMs : 0;
        const elapsedStr = elapsedMs > 0
          ? `  ${DIM}${elapsedMs < 1000 ? `${elapsedMs}ms` : `${(elapsedMs / 1000).toFixed(1)}s`}${RESET}`
          : '';
        footer.setStatus(`${tokens}${elapsedStr}  ctx ${color}${bar}${RESET}${DIM} ${pctStr}%${truncMark}${RESET}${cacheSuffix}${modeSuffix}${thinkingSuffix}`);
        stdout.write(footer.render());
      }
      break;
    }

    case 'error':
      state.hadError = true;
      if (event.message.includes('retrying') && spinner.isActive()) {
        const retryMatch = event.message.match(/attempt (\d+)\/(\d+)/);
        spinner.updateLabel(retryMatch ? `Retrying (${retryMatch[1]}/${retryMatch[2]})...` : 'Retrying...');
      } else {
        const prefix = event.agent !== 'nodyn' ? `[${event.agent}] ` : '';
        stderr.write(renderError(`${prefix}${event.message}`));
      }
      break;

    case 'goal_update': {
      const g = event.goal;
      const completed = g.subtasks.filter(s => s.status === 'complete').length;
      const total = g.subtasks.length;
      const key = `${g.status}:${completed}/${total}`;
      if (key === state.lastGoalKey) break; // Skip duplicate renders
      state.lastGoalKey = key;
      const statusColor = g.status === 'complete' ? GREEN : g.status === 'failed' ? RED : BLUE;
      stdout.write(`  ${statusColor}◉${RESET} ${DIM}Goal:${RESET} ${g.goal} ${DIM}[${completed}/${total} subtasks — ${g.status}]${RESET}\n`);
      break;
    }

    case 'trigger':
      stdout.write(`  ${MAGENTA}⚡${RESET} ${DIM}Trigger:${RESET} ${event.event.source} ${DIM}at ${event.event.timestamp}${RESET}\n`);
      break;

    case 'cost_warning': {
      const s = event.snapshot;
      const pct = s.budgetPercent;
      const color = pct >= 100 ? RED : '\x1b[33m';
      stdout.write(`  ${color}⚠${RESET} ${DIM}Cost:${RESET} $${s.estimatedCostUSD.toFixed(4)} ${DIM}(${pct}% of budget, ${s.iterationsUsed} iterations)${RESET}\n`);
      break;
    }

    case 'continuation':
      stdout.write(`  ${BLUE}↻${RESET} ${DIM}Continuation ${event.iteration}/${event.max}${RESET}\n`);
      break;

    case 'pipeline_progress': {
      // Cost estimate header
      if (event.stepId === 'cost-estimate') {
        stdout.write(`\n  ${BLUE}◈${RESET} ${BOLD}Pipeline${RESET} ${DIM}— ${event.detail}${RESET}\n`);
        break;
      }
      // Phase headers: reset step tracker, print header
      if (event.stepId.startsWith('phase-')) {
        stopPipelineHeartbeat();
        pipelineSteps.clear();
        pipelineRenderedLines = 0;
        stdout.write(`\n  ${DIM}━━${RESET} ${BOLD}${event.detail}${RESET} ${DIM}${'━'.repeat(30)}${RESET}\n`);
        break;
      }
      // Step events: update tracker and redraw
      if (event.status === 'started' && !event.detail?.includes('running')) {
        pipelineSteps.set(event.stepId, { status: 'running', startedAt: Date.now() });
        redrawPipelineBlock(stdout);
        startPipelineHeartbeat(stdout);
      } else if (event.status === 'completed') {
        const step = pipelineSteps.get(event.stepId);
        if (step) {
          step.status = 'done';
          step.durationMs = event.durationMs ?? Date.now() - step.startedAt;
        }
        redrawPipelineBlock(stdout);
        // Stop heartbeat if no more running steps
        const hasRunning = [...pipelineSteps.values()].some(s => s.status === 'running');
        if (!hasRunning) stopPipelineHeartbeat();
      } else if (event.status === 'failed') {
        const step = pipelineSteps.get(event.stepId);
        if (step) {
          step.status = 'failed';
          step.detail = event.detail ?? '';
        }
        redrawPipelineBlock(stdout);
        const hasRunning = [...pipelineSteps.values()].some(s => s.status === 'running');
        if (!hasRunning) stopPipelineHeartbeat();
      } else if (event.status === 'skipped') {
        pipelineSteps.set(event.stepId, { status: 'skipped', startedAt: Date.now(), detail: event.detail ?? '' });
        redrawPipelineBlock(stdout);
      }
      break;
    }

    case 'context_pressure': {
      if (event.droppedMessages > 0) {
        state.sessionTruncated = true;
        stderr.write(`\n\x1b[33m⚠ ${event.droppedMessages} message(s) compacted to fit context (${event.usagePercent}% used) — use /compact or /clear to free space, /save to preserve full history${RESET}\n`);
      }
      break;
    }
  }
}
