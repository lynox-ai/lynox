/**
 * Pipeline CLI command: /pipeline (including /chain, /manifest subcommands)
 */

import { resolve } from 'node:path';
import { stderr } from 'node:process';

import type { Session } from '../../core/session.js';
import { getErrorMessage } from '../../core/utils.js';
import { renderError, BOLD, DIM, BLUE, GREEN, RED, MAGENTA, RESET } from '../ui.js';
import { spinner } from '../cli-state.js';
import type { CLICtx } from './types.js';

export async function handlePipeline(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  session.registerPipelineTools();
  const pipelineSub = parts[1];

  if (!pipelineSub || pipelineSub === 'list') {
    const { getPipelineStore } = await import('../../tools/builtin/pipeline.js');

    const store = getPipelineStore();

    if (store.size === 0) {
      ctx.stdout.write('No pipelines. Use plan_task or /pipeline plan <goal> to create one.\n');
    } else {
      ctx.stdout.write(`${BOLD}Session pipelines:${RESET}\n`);
      for (const [id, p] of store) {
        const status = p.executed ? `${GREEN}executed${RESET}` : `${DIM}pending${RESET}`;
        ctx.stdout.write(`  ${id.slice(0, 8)} ${p.name} (${p.steps.length} steps) ${status}\n`);
      }
    }
    return true;
  }

  if (pipelineSub === 'plan') {
    const goal = parts.slice(2).join(' ');
    if (!goal) {
      ctx.stdout.write('Usage: /pipeline plan <goal>\n');
      return true;
    }
    ctx.stdout.write(`${BLUE}\u25B6${RESET} Planning pipeline...\n`);
    const { planDAG: pDAG, estimatePipelineCost: estCost } = await import('../../core/dag-planner.js');
    const cfg = session.getUserConfig();
    const plan = await pDAG(goal, {
      apiKey: cfg.api_key,
      apiBaseURL: cfg.api_base_url,
    });
    if (!plan || plan.steps.length === 0) {
      ctx.stdout.write(renderError('Planning failed.'));
      return true;
    }
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    const { storePipeline } = await import('../../tools/builtin/pipeline.js');
    storePipeline(id, {
      id, name: `pipeline-${id.slice(0, 8)}`, goal, steps: plan.steps,
      reasoning: plan.reasoning, estimatedCost: plan.estimatedCost,
      createdAt: new Date().toISOString(), executed: false,
    });
    const cost = estCost(plan.steps);
    ctx.stdout.write(`${GREEN}\u2713${RESET} Pipeline ${id.slice(0, 8)} (${plan.steps.length} steps, ~$${cost.totalCostUsd.toFixed(4)})\n`);
    for (const s of plan.steps) {
      const deps = s.input_from?.length ? ` ${DIM}\u2190 ${s.input_from.join(', ')}${RESET}` : '';
      ctx.stdout.write(`  ${s.id} (${s.model ?? 'sonnet'}) ${s.task.slice(0, 70)}${deps}\n`);
    }
    ctx.stdout.write(`${DIM}Execute: /pipeline run ${id.slice(0, 8)}${RESET}\n`);
    return true;
  }

  if (pipelineSub === 'show') {
    const showId = parts[2];
    if (!showId) {
      ctx.stdout.write('Usage: /pipeline show <id>\n');
      return true;
    }
    const { getPipeline } = await import('../../tools/builtin/pipeline.js');
    const p = getPipeline(showId);
    if (!p) {
      // Try history
      const history = session.getRunHistory();
      if (history) {
        const run = history.getPipelineRun(showId);
        if (run) {
          ctx.stdout.write(`${BOLD}${run.manifest_name}${RESET} [${run.status}]\n`);
          ctx.stdout.write(`  Duration: ${run.total_duration_ms}ms  Cost: $${run.total_cost_usd.toFixed(4)}  Steps: ${run.step_count}\n`);
          const steps = history.getPipelineStepResults(run.id);
          for (const s of steps) {
            const icon = s.status === 'completed' ? `${GREEN}\u2713${RESET}` : s.status === 'failed' ? `${RED}\u2717${RESET}` : `${DIM}\u2298${RESET}`;
            ctx.stdout.write(`  ${icon} ${s.step_id} ${DIM}${s.duration_ms}ms $${s.cost_usd.toFixed(4)}${RESET}\n`);
          }
          return true;
        }
      }
      ctx.stdout.write(`Pipeline "${showId}" not found.\n`);
      return true;
    }
    ctx.stdout.write(`${BOLD}${p.name}${RESET} ${p.executed ? `${GREEN}executed${RESET}` : `${DIM}pending${RESET}`}\n`);
    ctx.stdout.write(`Goal: ${p.goal}\n`);
    for (const s of p.steps) {
      const deps = s.input_from?.length ? ` ${DIM}\u2190 ${s.input_from.join(', ')}${RESET}` : '';
      ctx.stdout.write(`  ${s.id} (${s.model ?? 'sonnet'}) ${s.task.slice(0, 70)}${deps}\n`);
    }
    ctx.stdout.write(`Reasoning: ${p.reasoning}\n`);
    return true;
  }

  if (pipelineSub === 'run') {
    const runId = parts[2];
    if (!runId) {
      ctx.stdout.write('Usage: /pipeline run <id>\n');
      return true;
    }
    const { getPipeline: getPipe } = await import('../../tools/builtin/pipeline.js');
    const p = getPipe(runId);
    if (!p) {
      ctx.stdout.write(`Pipeline "${runId}" not found.\n`);
      return true;
    }
    ctx.stdout.write(`${BLUE}\u25B6${RESET} Executing pipeline: ${BOLD}${p.name}${RESET}\n`);
    const response = await session.run(`Execute pipeline ${p.id} using run_pipeline tool with pipeline_id.`);
    ctx.stdout.write(response + '\n');
    return true;
  }

  if (pipelineSub === 'retry') {
    const retryId = parts[2];
    if (!retryId) {
      ctx.stdout.write('Usage: /pipeline retry <id>\n');
      return true;
    }
    ctx.stdout.write(`${BLUE}\u25B6${RESET} Retrying pipeline: ${retryId}\n`);
    const response = await session.run(`Retry the failed steps of pipeline ${retryId} using run_pipeline with pipeline_id and retry=true.`);
    ctx.stdout.write(response + '\n');
    return true;
  }

  if (pipelineSub === 'history') {
    const history = session.getRunHistory();
    if (!history) {
      ctx.stdout.write('Run history not available.\n');
      return true;
    }
    const runs = history.getRecentPipelineRuns(20);
    if (runs.length === 0) {
      ctx.stdout.write('No pipeline runs in history.\n');
      return true;
    }
    ctx.stdout.write(`${BOLD}Recent pipeline runs:${RESET}\n`);
    for (const r of runs) {
      const icon = r.status === 'completed' ? `${GREEN}\u2713${RESET}` : r.status === 'failed' ? `${RED}\u2717${RESET}` : `${DIM}\u25CB${RESET}`;
      ctx.stdout.write(`  ${icon} ${r.id.slice(0, 8)} ${r.manifest_name} (${r.step_count} steps, $${r.total_cost_usd.toFixed(4)}) ${DIM}${r.started_at}${RESET}\n`);
    }
    return true;
  }

  // chain subcommand (sequential task execution)
  if (pipelineSub === 'chain') {
    const chainStr = parts.slice(2).join(' ');
    let steps = chainStr.split('->').map(s => s.trim().replace(/^["']|["']$/g, ''));
    if (steps.length === 0 || !steps[0]) {
      if (!ctx.cliPrompt) {
        ctx.stdout.write('Usage: /pipeline chain "step1" -> "step2" -> "step3"\n');
        return true;
      }
      steps = [];
       
      while (true) {
        const step = await ctx.cliPrompt(`Step ${steps.length + 1} (empty to run):`);
        if (!step) break;
        steps.push(step);
      }
      if (steps.length === 0) return true;
    }
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      ctx.stdout.write(`\n${BLUE}[${i + 1}/${steps.length}]${RESET} ${BOLD}${step}${RESET}\n`);
      try {
        spinner.start(`Step ${i + 1}/${steps.length}...`);
        await session.run(step);
      } catch (err: unknown) {
        spinner.stop();
        stderr.write(renderError(`Chain failed at step ${i + 1}: ${getErrorMessage(err)}`));
        break;
      }
    }
    return true;
  }

  // manifest subcommand (file-based DAG execution)
  if (pipelineSub === 'manifest') {
    const manifestSub = parts[2];
    const manifestPath = parts[3];
    if (!manifestSub) {
      ctx.stdout.write(`Usage:\n  /pipeline manifest run <path>       Run a manifest file\n  /pipeline manifest validate <path>  Validate without running\n  /pipeline manifest dry-run <path>   Run with mock responses\n`);
      return true;
    }
    if (manifestSub !== 'run' && manifestSub !== 'validate' && manifestSub !== 'dry-run') {
      ctx.stdout.write(`Unknown manifest subcommand: ${manifestSub}. Use run, validate, or dry-run.\n`);
      return true;
    }
    if (!manifestPath) {
      ctx.stdout.write(`Usage: /pipeline manifest ${manifestSub} <path>\n`);
      return true;
    }
    const { loadManifestFile: loadMf } = await import('../../orchestrator/runner.js');
    try {
      const manifest = loadMf(resolve(manifestPath));
      if (manifestSub === 'validate') {
        ctx.stdout.write(`${GREEN}✓${RESET} Manifest "${manifest.name}" is valid (${manifest.agents.length} steps)\n`);
        return true;
      }
      const { runManifest: runMf } = await import('../../orchestrator/runner.js');
      const { LocalGateAdapter: LocalAdapter } = await import('../../orchestrator/gates.js');
      const cfg = session.getUserConfig();
      let gateAdapter: import('../../orchestrator/types.js').GateAdapter | undefined;
      if (ctx.cliPrompt) {
        gateAdapter = new LocalAdapter(ctx.cliPrompt);
      }
      ctx.stdout.write(`${BLUE}▶${RESET} Running manifest: ${BOLD}${manifest.name}${RESET}\n`);
      const runState = await runMf(manifest, cfg, {
        mockResponses: manifestSub === 'dry-run' ? new Map() : undefined,
        gateAdapter: manifestSub === 'dry-run' ? undefined : gateAdapter,
        hooks: {
          onStepStart: (stepId, agentName) => ctx.stdout.write(`  ${DIM}→ ${stepId} (${agentName})${RESET}\n`),
          onStepComplete: (output) => ctx.stdout.write(`  ${GREEN}✓${RESET} ${output.stepId} ${DIM}${output.durationMs}ms${RESET}\n`),
          onStepSkipped: (stepId, reason) => ctx.stdout.write(`  ${DIM}⊘ ${stepId}: ${reason}${RESET}\n`),
          onGateSubmit: (stepId) => ctx.stdout.write(`  ${MAGENTA}⏳${RESET} Gate pending: ${stepId}\n`),
          onGateDecision: (stepId, d) => ctx.stdout.write(`  ${d.status === 'approved' ? GREEN : RED}${d.status}${RESET} gate: ${stepId}\n`),
          onError: (stepId, err) => stderr.write(renderError(`${stepId}: ${err.message}`)),
        },
      });
      const icon = runState.status === 'completed' ? `${GREEN}✓` : `${RED}✗`;
      ctx.stdout.write(`${icon}${RESET} ${manifest.name} — ${BOLD}${runState.status}${RESET}\n`);
    } catch (err: unknown) {
      ctx.stdout.write(renderError(getErrorMessage(err)));
    }
    return true;
  }

  ctx.stdout.write(`Unknown subcommand: ${pipelineSub}. Use list, plan, run, show, retry, history, or chain.\n`);
  return true;
}

// Standalone /chain command (alias behavior)
export async function handleChain(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const chainStr = parts.slice(1).join(' ');
  let steps = chainStr.split('->').map(s => s.trim().replace(/^["']|["']$/g, ''));
  if (steps.length === 0 || !steps[0]) {
    if (!ctx.cliPrompt) {
      ctx.stdout.write('Usage: /chain "step1" -> "step2" -> "step3"\n');
      return true;
    }
    // Interactive: collect steps one by one
    steps = [];
     
    while (true) {
      const step = await ctx.cliPrompt(`Step ${steps.length + 1} (empty to run):`);
      if (!step) break;
      steps.push(step);
    }
    if (steps.length === 0) return true;
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    ctx.stdout.write(`\n${BLUE}[${i + 1}/${steps.length}]${RESET} ${BOLD}${step}${RESET}\n`);
    try {
      spinner.start(`Step ${i + 1}/${steps.length}...`);
      await session.run(step);
    } catch (err: unknown) {
      spinner.stop();
      stderr.write(renderError(`Chain failed at step ${i + 1}: ${getErrorMessage(err)}`));
      break;
    }
  }
  return true;
}

// Standalone /manifest command
export async function handleManifest(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const manifestSub = parts[1];
  const manifestPath = parts[2];

  if (!manifestSub || manifestSub === 'list') {
    ctx.stdout.write(`Usage:\n  /manifest run <path>       Run a manifest file\n  /manifest validate <path>  Validate without running\n  /manifest dry-run <path>   Run with mock responses (no API)\n`);
    return true;
  }

  if (manifestSub !== 'run' && manifestSub !== 'validate' && manifestSub !== 'dry-run') {
    ctx.stdout.write(`Unknown subcommand: ${manifestSub}. Use run, validate, or dry-run.\n`);
    return true;
  }

  if (!manifestPath) {
    ctx.stdout.write(`Usage: /manifest ${manifestSub} <path>\n`);
    return true;
  }

  const { loadManifestFile: loadMf } = await import('../../orchestrator/runner.js');
  try {
    const manifest = loadMf(resolve(manifestPath));

    if (manifestSub === 'validate') {
      ctx.stdout.write(`${GREEN}✓${RESET} Manifest "${manifest.name}" is valid (${manifest.agents.length} steps)\n`);
      return true;
    }

    const { runManifest: runMf } = await import('../../orchestrator/runner.js');
    const { LocalGateAdapter: LocalAdapter } = await import('../../orchestrator/gates.js');
    const cfg = session.getUserConfig();
    let gateAdapter: import('../../orchestrator/types.js').GateAdapter | undefined;
    if (ctx.cliPrompt) {
      gateAdapter = new LocalAdapter(ctx.cliPrompt);
    }

    ctx.stdout.write(`${BLUE}▶${RESET} Running manifest: ${BOLD}${manifest.name}${RESET}\n`);
    const runState = await runMf(manifest, cfg, {
      mockResponses: manifestSub === 'dry-run' ? new Map() : undefined,
      gateAdapter: manifestSub === 'dry-run' ? undefined : gateAdapter,
      hooks: {
        onStepStart: (stepId, agentName) => ctx.stdout.write(`  ${DIM}→ ${stepId} (${agentName})${RESET}\n`),
        onStepComplete: (output) => ctx.stdout.write(`  ${GREEN}✓${RESET} ${output.stepId} ${DIM}${output.durationMs}ms${RESET}\n`),
        onStepSkipped: (stepId, reason) => ctx.stdout.write(`  ${DIM}⊘ ${stepId}: ${reason}${RESET}\n`),
        onGateSubmit: (stepId) => ctx.stdout.write(`  ${MAGENTA}⏳${RESET} Gate pending: ${stepId}\n`),
        onGateDecision: (stepId, d) => ctx.stdout.write(`  ${d.status === 'approved' ? GREEN : RED}${d.status}${RESET} gate: ${stepId}\n`),
        onError: (stepId, err) => stderr.write(renderError(`${stepId}: ${err.message}`)),
      },
    });
    const icon = runState.status === 'completed' ? `${GREEN}✓` : `${RED}✗`;
    ctx.stdout.write(`${icon}${RESET} ${manifest.name} — ${BOLD}${runState.status}${RESET}\n`);
  } catch (err: unknown) {
    ctx.stdout.write(renderError(getErrorMessage(err)));
  }
  return true;
}

// /tools and /mcp commands that were in the switch
export async function handleTools(_parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const reg = session.getRegistry();
  const entries = reg.getEntries();
  const servers = reg.getMCPServers();
  ctx.stdout.write('Builtin tools:\n');
  for (const e of entries) {
    ctx.stdout.write(`  - ${e.definition.name}: ${e.definition.description ?? ''}\n`);
  }
  ctx.stdout.write(`  - web_search (native)\n`);
  if (servers.length > 0) {
    ctx.stdout.write('MCP servers:\n');
    for (const s of servers) {
      ctx.stdout.write(`  - ${s.name}: ${s.url}\n`);
    }
  }
  return true;
}

export async function handleMcp(parts: string[], session: Session, ctx: CLICtx): Promise<boolean> {
  const sub = parts[1];

  // /mcp list
  if (!sub || sub === 'list') {
    const config = session.getUserConfig();
    const servers = config.mcp_servers ?? [];
    if (servers.length === 0) {
      ctx.stdout.write('No persistent MCP servers configured.\nUsage: /mcp add <name> <url>\n');
      return true;
    }
    ctx.stdout.write('MCP Servers:\n');
    for (const s of servers) {
      ctx.stdout.write(`  ${s.name} — ${s.url}\n`);
    }
    return true;
  }

  // /mcp add <name> <url>
  if (sub === 'add') {
    const name = parts[2];
    const url = parts[3];
    if (!name || !url) {
      ctx.stdout.write('Usage: /mcp add <name> <url>\n');
      return true;
    }
    // Register in session
    session.addMCP({ type: 'url', name, url });
    // Persist to config
    const { readUserConfig, saveUserConfig } = await import('../../core/config.js');
    const config = readUserConfig();
    const servers = config.mcp_servers ?? [];
    if (!servers.some(s => s.name === name)) {
      servers.push({ name, url });
      config.mcp_servers = servers;
      saveUserConfig(config);
    }
    ctx.stdout.write(`MCP server "${name}" registered and saved.\n`);
    return true;
  }

  // /mcp remove <name>
  if (sub === 'remove') {
    const name = parts[2];
    if (!name) {
      ctx.stdout.write('Usage: /mcp remove <name>\n');
      return true;
    }
    const { readUserConfig, saveUserConfig } = await import('../../core/config.js');
    const config = readUserConfig();
    const servers = config.mcp_servers ?? [];
    const filtered = servers.filter(s => s.name !== name);
    if (filtered.length === servers.length) {
      ctx.stdout.write(`MCP server "${name}" not found.\n`);
      return true;
    }
    config.mcp_servers = filtered.length > 0 ? filtered : undefined;
    saveUserConfig(config);
    ctx.stdout.write(`MCP server "${name}" removed. Restart to disconnect.\n`);
    return true;
  }

  // Legacy: /mcp <name> <url> (backwards compat)
  const url = parts[2];
  if (sub && url) {
    session.addMCP({ type: 'url', name: sub, url });
    const { readUserConfig, saveUserConfig } = await import('../../core/config.js');
    const config = readUserConfig();
    const servers = config.mcp_servers ?? [];
    if (!servers.some(s => s.name === sub)) {
      servers.push({ name: sub, url });
      config.mcp_servers = servers;
      saveUserConfig(config);
    }
    ctx.stdout.write(`MCP server "${sub}" registered and saved.\n`);
    return true;
  }

  ctx.stdout.write('Usage:\n  /mcp              List MCP servers\n  /mcp add <name> <url>   Add and persist\n  /mcp remove <name>      Remove\n');
  return true;
}
