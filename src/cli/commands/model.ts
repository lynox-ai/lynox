/**
 * Model-related CLI commands: /model, /accuracy, /cost, /context
 */

import type { Nodyn } from '../../core/orchestrator.js';
import type { ModelTier } from '../../types/index.js';
import { MODEL_MAP, CONTEXT_WINDOW } from '../../types/index.js';
import { renderTable, BOLD, DIM, GREEN, RED, RESET } from '../ui.js';
import { state } from '../cli-state.js';
import { printCost } from '../cli-helpers.js';
import { MODEL_ALIASES } from '../help-text.js';
import type { CLICtx } from './types.js';

export async function handleModel(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const modelArg = parts[1]?.toLowerCase();
  const currentTier = nodyn.getModelTier();
  const tierLabels: Record<ModelTier, string> = {
    'opus': 'Opus', 'sonnet': 'Sonnet', 'haiku': 'Haiku',
  };

  if (!modelArg) {
    // Interactive select (use dialog directly — not promptUser which has abort logic)
    const tiers: ModelTier[] = ['opus', 'sonnet', 'haiku'];
    const options = tiers.map(t => {
      const label = `${tierLabels[t]} (${MODEL_MAP[t]})`;
      return t === currentTier ? `${label}  current` : label;
    });

    if (ctx.cliPrompt) {
      const answer = await ctx.cliPrompt('Select model:', options);
      if (!answer) {
        // ESC / Ctrl+C — cancelled
        return true;
      }
      const idx = options.indexOf(answer);
      // Also try matching the answer against MODEL_ALIASES (freeform "Other" input)
      const tier = idx >= 0 ? tiers[idx]! : MODEL_ALIASES[answer.toLowerCase()];
      const selected = tier ?? currentTier;
      if (selected !== currentTier) {
        const resolved = nodyn.setModel(selected);
        state.currentModelId = resolved;
        ctx.stdout.write(`${GREEN}✓${RESET} Switched to ${BOLD}${tierLabels[selected]}${RESET} (${resolved})\n`);
      } else {
        ctx.stdout.write(`Already using ${BOLD}${tierLabels[currentTier]}${RESET}.\n`);
      }
    } else {
      ctx.stdout.write(`Current model: ${BOLD}${tierLabels[currentTier]}${RESET} (${MODEL_MAP[currentTier]})\n`);
      ctx.stdout.write(`Usage: /model <opus|sonnet|haiku>\n`);
    }
  } else {
    const tier = MODEL_ALIASES[modelArg];
    if (!tier) {
      ctx.stdout.write(`Unknown model: ${modelArg}. Use opus, sonnet, or haiku.\n`);
    } else if (tier === currentTier) {
      ctx.stdout.write(`Already using ${BOLD}${tierLabels[currentTier]}${RESET}.\n`);
    } else {
      const resolved = nodyn.setModel(tier);
      state.currentModelId = resolved;
      ctx.stdout.write(`${GREEN}✓${RESET} Switched to ${BOLD}${tierLabels[tier]}${RESET} (${resolved})\n`);
    }
  }
  return true;
}

export async function handleAccuracy(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1]?.toLowerCase();
  const effortLevels = ['low', 'medium', 'high', 'max'] as const;

  // Direct shorthand: /thinking low, /thinking max, etc.
  if (sub && effortLevels.includes(sub as typeof effortLevels[number])) {
    nodyn.setEffort(sub as typeof effortLevels[number]);
    ctx.stdout.write(`${GREEN}✓${RESET} Accuracy set to ${BOLD}${sub}${RESET}\n`);
    return true;
  }
  if (sub === 'show') {
    state.showThinking = !state.showThinking;
    ctx.stdout.write(`Thinking display: ${state.showThinking ? 'on' : 'off'}\n`);
    return true;
  }

  // No arg or unknown: interactive select
  const currentEffort = nodyn.getEffort();
  const options = effortLevels.map(l => {
    const desc = l === 'low' ? 'quick' : l === 'medium' ? 'balanced' : l === 'high' ? 'thorough' : 'exhaustive';
    return l === currentEffort ? `${l} — ${desc}  current` : `${l} — ${desc}`;
  });

  if (ctx.cliPrompt) {
    const answer = await ctx.cliPrompt('Accuracy:', [...options, `toggle thinking display (${state.showThinking ? 'on' : 'off'})`]);
    if (!answer) return true;
    const idx = options.indexOf(answer);
    if (idx >= 0) {
      const selected = effortLevels[idx]!;
      if (selected !== currentEffort) {
        nodyn.setEffort(selected);
        ctx.stdout.write(`${GREEN}✓${RESET} Accuracy set to ${BOLD}${selected}${RESET}\n`);
      } else {
        ctx.stdout.write(`Already using ${BOLD}${currentEffort}${RESET}.\n`);
      }
    } else if (answer.startsWith('toggle')) {
      state.showThinking = !state.showThinking;
      ctx.stdout.write(`Thinking display: ${state.showThinking ? 'on' : 'off'}\n`);
    }
  } else {
    ctx.stdout.write(`Accuracy: ${BOLD}${currentEffort}${RESET}  Thinking display: ${state.showThinking ? 'on' : 'off'}\n`);
    ctx.stdout.write(`${DIM}Usage: /thinking <low|medium|high|max> or /thinking show${RESET}\n`);
  }
  return true;
}

export async function handleCost(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const costSub = parts[1];
  const history = nodyn.getRunHistory();
  const model = MODEL_MAP[nodyn.getModelTier()];

  if (costSub === 'today' && history) {
    const days = history.getCostByDay(1);
    if (days.length === 0) { ctx.stdout.write('No runs today.\n'); } else {
      const d = days[0]!;
      ctx.stdout.write(`${BOLD}Today:${RESET} $${d.cost_usd.toFixed(4)} USD (${d.run_count} runs)\n`);
    }
  } else if (costSub === 'week' && history) {
    const days = history.getCostByDay(7);
    if (days.length === 0) { ctx.stdout.write('No runs this week.\n'); } else {
      const rows = days.map(d => [d.day, `$${d.cost_usd.toFixed(4)}`, `${d.run_count} runs`]);
      ctx.stdout.write(renderTable(['Day', 'Cost', 'Runs'], rows) + '\n');
      const total = days.reduce((s, d) => s + d.cost_usd, 0);
      ctx.stdout.write(`${BOLD}Week total:${RESET} $${total.toFixed(4)}\n`);
    }
  } else if (costSub === 'by-model' && history) {
    const models = history.getCostByModel();
    if (models.length === 0) { ctx.stdout.write('No cost data.\n'); } else {
      const rows = models.map(m => [m.model_id, `$${m.cost_usd.toFixed(4)}`, `${m.run_count} runs`]);
      ctx.stdout.write(renderTable(['Model', 'Cost', 'Runs'], rows) + '\n');
    }
  } else {
    printCost(nodyn, model, ctx.stdout);
  }
  return true;
}

export async function handleContext(_parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const maxCtx = CONTEXT_WINDOW[state.currentModelId] ?? 200_000;
  const u = nodyn.usage;
  const inTok = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  const pctRaw = Math.min(100, (inTok / maxCtx) * 100);
  const pct = Math.round(pctRaw * 10) / 10;

  // 10x5 grid (50 cells = 2% each)
  const filledCells = Math.round(pctRaw / 2);
  const COLS = 10;
  const ROWS = 5;

  ctx.stdout.write(`${BOLD}Context Window${RESET} — ${state.currentModelId}\n\n`);
  for (let r = 0; r < ROWS; r++) {
    ctx.stdout.write('  ');
    for (let c = 0; c < COLS; c++) {
      const idx = r * COLS + c;
      if (idx < filledCells) {
        const cellPct = (idx / 50) * 100;
        const color = cellPct >= 80 ? RED : cellPct >= 50 ? '\x1b[33m' : GREEN;
        ctx.stdout.write(`${color}█${RESET}`);
      } else {
        ctx.stdout.write(`${DIM}░${RESET}`);
      }
    }
    ctx.stdout.write('\n');
  }
  ctx.stdout.write(`\n  ${pct}% used — ${inTok.toLocaleString()} / ${maxCtx.toLocaleString()} tokens\n`);

  const cacheRead = u.cache_read_input_tokens;
  const cacheWrite = u.cache_creation_input_tokens;
  if (cacheRead > 0 || cacheWrite > 0) {
    const cacheTotal = u.input_tokens + cacheWrite + cacheRead;
    const cachePct = cacheTotal > 0 ? Math.round((cacheRead / cacheTotal) * 100) : 0;
    ctx.stdout.write(`  Cache hit: ${cachePct}% (${cacheRead.toLocaleString()} read / ${cacheWrite.toLocaleString()} write)\n`);
  }
  if (state.sessionTruncated) {
    ctx.stdout.write(`  ${'\x1b[33m'}⚠ Session was compacted${RESET}\n`);
  }
  return true;
}
