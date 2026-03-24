/**
 * History-related CLI commands: /runs, /stats, /batch, /batch-status
 */

import { readFileSync } from 'node:fs';

import type { Nodyn } from '../../core/orchestrator.js';
import type { BatchRequest } from '../../types/index.js';
import { renderTable, renderError, BOLD, DIM, BLUE, GREEN, RED, RESET } from '../ui.js';
import type { CLICtx } from './types.js';

// /tree is an internal command dispatched from /runs tree
export async function handleTree(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const tH = nodyn.getRunHistory();
  if (!tH) { ctx.stdout.write('Run history not available.\n'); return true; }
  const tId = parts[1];
  if (!tId) { ctx.stdout.write('Usage: /tree <run_id>\n'); return true; }
  const tRoot = tH.getRun(tId);
  if (!tRoot) { ctx.stdout.write(`Run ${tId} not found.\n`); return true; }
  const sTree = tH.getSpawnTree(tRoot.id);
  const allR = tH.getRunWithDescendants(tRoot.id);
  const rM = new Map(allR.map(r => [r.id, r]));
  const cM = new Map<string, Array<{ childRunId: string; depth: number }>>();
  for (const sp of sTree) {
    const ls = cM.get(sp.parent_run_id) ?? [];
    ls.push({ childRunId: sp.child_run_id, depth: sp.depth });
    cM.set(sp.parent_run_id, ls);
  }
  const fD = (ms: number): string => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const rTN = (rid: string, pfx: string, lst: boolean, rt: boolean): string => {
    const r = rM.get(rid);
    if (!r) return '';
    const cn = rt ? '' : (lst ? '\u2514\u2500\u2500 ' : '\u251C\u2500\u2500 ');
    const ic = r.status === 'completed' ? `${GREEN}\u2713${RESET}` : r.status === 'failed' ? `${RED}\u2717${RESET}` : `${BLUE}~${RESET}`;
    const tk = r.task_text.slice(0, 50).replace(/\n/g, ' ');
    const co = r.cost_usd > 0 ? `$${r.cost_usd.toFixed(4)}` : '-';
    const du = r.duration_ms > 0 ? fD(r.duration_ms) : '-';
    const ml = r.model_tier || r.model_id.split('-').slice(1, 2).join('');
    let o = `${pfx}${cn}${ic} ${BOLD}${r.id.slice(0, 8)}${RESET} ${DIM}[${ml}]${RESET} ${tk}  ${DIM}${co} / ${du}${RESET}\n`;
    const ch = cM.get(rid) ?? [];
    const cp = rt ? pfx : pfx + (lst ? '    ' : '\u2502   ');
    for (let j = 0; j < ch.length; j++) {
      o += rTN(ch[j]!.childRunId, cp, j === ch.length - 1, false);
    }
    return o;
  };
  ctx.stdout.write(`\n${BOLD}Spawn Tree${RESET} ${DIM}(run ${tRoot.id.slice(0, 8)})${RESET}\n\n`);
  ctx.stdout.write(rTN(tRoot.id, '', true, true));
  const tCost = allR.reduce((s, r) => s + r.cost_usd, 0);
  const mxD = sTree.reduce((mx, s) => Math.max(mx, s.depth), 0);
  ctx.stdout.write(`\n${DIM}Nodes: ${allR.length} | Max depth: ${mxD} | Total cost: $${tCost.toFixed(4)} | Root duration: ${fD(tRoot.duration_ms)}${RESET}\n`);
  return true;
}

export async function handleRuns(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const history = nodyn.getRunHistory();
  if (!history) { ctx.stdout.write('Run history not available.\n'); return true; }

  const sub = parts[1];
  if (sub === 'tree') {
    // Delegate to handleTree with shifted parts
    return handleTree(['', ...parts.slice(2)], nodyn, ctx);
  }
  if (sub === 'delete') {
    const runId = parts[2];
    if (!runId) { ctx.stdout.write('Usage: /runs delete <id>\n'); return true; }
    const run = history.getRun(runId);
    if (!run) { ctx.stdout.write(`Run ${runId} not found.\n`); return true; }
    history.deleteRun(run.id);
    ctx.stdout.write(`Deleted run ${run.id.slice(0, 8)} and associated data.\n`);
    return true;
  }
  if (sub === 'purge') {
    const ctxObj = nodyn.getContext();
    if (!ctxObj) { ctx.stdout.write('No active context.\n'); return true; }
    const count = history.deleteRunsByContext(ctxObj.id);
    history.vacuum();
    ctx.stdout.write(`Purged ${count} run(s) for context ${ctxObj.id} + VACUUM.\n`);
    return true;
  }
  if (sub === 'vacuum') {
    history.vacuum();
    ctx.stdout.write('VACUUM complete — WAL truncated.\n');
    return true;
  }
  if (sub === 'reset') {
    const askUser = nodyn.promptUser;
    const confirm = askUser
      ? await askUser('This will permanently delete ALL run history, pipelines, tasks, and embeddings. Type "yes" to confirm.')
      : '';
    if (confirm.trim().toLowerCase() !== 'yes') {
      ctx.stdout.write('Reset cancelled.\n');
      return true;
    }
    history.resetDatabase();
    ctx.stdout.write('Database reset complete — all data deleted.\n');
    return true;
  }
  if (sub === 'search') {
    const query = parts.slice(2).join(' ');
    if (!query) { ctx.stdout.write('Usage: /runs search <query>\n'); return true; }
    const results = history.searchRuns(query);
    if (results.length === 0) { ctx.stdout.write('No matching runs.\n'); return true; }
    const rows = results.map(r => [r.id.slice(0, 8), r.model_tier, r.task_text.slice(0, 40), `$${r.cost_usd.toFixed(4)}`, r.status]);
    ctx.stdout.write(renderTable(['ID', 'Model', 'Task', 'Cost', 'Status'], rows) + '\n');
  } else if (sub && sub !== 'search') {
    const run = history.getRun(sub);
    if (!run) { ctx.stdout.write(`Run ${sub} not found.\n`); return true; }
    ctx.stdout.write(`${BOLD}Run ${run.id.slice(0, 8)}${RESET}\n`);
    ctx.stdout.write(`Task:     ${run.task_text.slice(0, 80)}\n`);
    ctx.stdout.write(`Model:    ${run.model_id} (${run.model_tier})\n`);
    ctx.stdout.write(`Tokens:   ${run.tokens_in} in / ${run.tokens_out} out\n`);
    ctx.stdout.write(`Cost:     $${run.cost_usd.toFixed(4)}\n`);
    ctx.stdout.write(`Duration: ${run.duration_ms}ms\n`);
    ctx.stdout.write(`Status:   ${run.status}\n`);
    if (run.session_id) {
      ctx.stdout.write(`Session:  ${DIM}${run.session_id.slice(0, 8)}${RESET}\n`);
    }
    const calls = history.getRunToolCalls(run.id);
    if (calls.length > 0) {
      ctx.stdout.write(`\n${BOLD}Tool Calls (${calls.length}):${RESET}\n`);
      for (const tc of calls) {
        const hasError = tc.output_json !== '' && tc.output_json !== '{}';
        const icon = hasError ? `${RED}✗${RESET}` : `${GREEN}✓${RESET}`;
        let inputPreview = '';
        if (tc.input_json && tc.input_json !== '{}') {
          const raw = tc.input_json.length > 60 ? tc.input_json.slice(0, 57) + '...' : tc.input_json;
          inputPreview = ` ${DIM}${raw}${RESET}`;
        }
        ctx.stdout.write(`  ${icon} ${tc.sequence_order + 1}. ${tc.tool_name} (${tc.duration_ms}ms)${inputPreview}\n`);
      }
    }
  } else {
    const runs = history.getRecentRuns(20);
    if (runs.length === 0) { ctx.stdout.write('No runs recorded yet.\n'); return true; }
    const rows = runs.map(r => [r.id.slice(0, 8), r.model_tier, r.task_text.slice(0, 40), `$${r.cost_usd.toFixed(4)}`, `${r.duration_ms}ms`, r.status]);
    ctx.stdout.write(renderTable(['ID', 'Model', 'Task', 'Cost', 'Time', 'Status'], rows) + '\n');
  }
  return true;
}

export async function handleStats(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const history = nodyn.getRunHistory();
  if (!history) { ctx.stdout.write('Run history not available.\n'); return true; }
  const statsSub = parts[1];

  if (statsSub === 'tools') {
    const ctxObj = nodyn.getContext();
    const ctxId = ctxObj?.id ?? '';
    const days = parts[2] && !isNaN(Number(parts[2])) ? Number(parts[2]) : 7;
    const toolStats = history.getToolStats(ctxId, days);
    if (toolStats.length === 0) { ctx.stdout.write('No tool call data.\n'); return true; }
    ctx.stdout.write(`${BOLD}Tool Stats${RESET} ${DIM}(last ${days} day${days !== 1 ? 's' : ''})${RESET}\n`);
    const rows = toolStats.map(s => {
      const errPct = s.call_count > 0 ? Math.round((s.error_count / s.call_count) * 100) : 0;
      return [s.tool_name, `${s.call_count}`, `${s.error_count}`, `${errPct}%`, `${Math.round(s.avg_duration_ms)}ms`];
    });
    ctx.stdout.write(renderTable(['Tool', 'Calls', 'Errors', 'Error%', 'Avg Time'], rows) + '\n');
  } else if (statsSub === 'export') {
    const ctxObj = nodyn.getContext();
    const ctxId = ctxObj?.id ?? '';
    const exportDays = parts[2] && !isNaN(Number(parts[2])) ? Number(parts[2]) : 7;
    const stats = history.getStats();
    const toolStats = history.getToolStats(ctxId, exportDays);
    const sessions = history.getSessionSummaries(ctxId, exportDays);
    const report = {
      exportedAt: new Date().toISOString(),
      days: exportDays,
      contextId: ctxId || null,
      runSummary: stats,
      toolStats,
      sessions,
    };
    ctx.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (statsSub === 'prompts') {
    const ctxObj = nodyn.getContext();
    const ctxId = ctxObj?.id ?? '';
    const days = parts[2] && !isNaN(Number(parts[2])) ? Number(parts[2]) : 7;
    const variants = history.getPromptVariantStats(ctxId, days);
    if (variants.length === 0) { ctx.stdout.write('No prompt variant data.\n'); return true; }
    ctx.stdout.write(`${BOLD}Prompt Variants${RESET} ${DIM}(last ${days} day${days !== 1 ? 's' : ''})${RESET}\n`);
    const rows = variants.map(v => {
      const errPct = v.run_count > 0 ? Math.round((v.error_count / v.run_count) * 100) : 0;
      const snapshot = history.getPromptSnapshot(v.prompt_hash);
      const preview = snapshot?.prompt_text?.slice(0, 40) ?? '';
      return [v.prompt_hash.slice(0, 8), `${v.run_count}`, `$${v.avg_cost_usd.toFixed(3)}`, `${Math.round(v.avg_tokens_in)}`, `${errPct}%`, preview ? preview + '...' : ''];
    });
    ctx.stdout.write(renderTable(['Hash', 'Runs', 'Avg Cost', 'Avg Tokens', 'Err%', 'Preview'], rows) + '\n');
  } else if (statsSub === 'pipelines') {
    const days = parts[2] && !isNaN(Number(parts[2])) ? Number(parts[2]) : 7;
    const pipeStats = history.getPipelineCostStats(days);
    if (pipeStats.length === 0) { ctx.stdout.write('No pipeline data.\n'); return true; }
    ctx.stdout.write(`${BOLD}Pipeline Stats${RESET} ${DIM}(last ${days} day${days !== 1 ? 's' : ''})${RESET}\n`);
    const rows = pipeStats.map(p => [
      p.manifest_name, `${p.run_count}`, `$${p.avg_cost_usd.toFixed(3)}`, `$${p.total_cost_usd.toFixed(3)}`, `${Math.round(p.avg_duration_ms / 1000)}s`,
    ]);
    ctx.stdout.write(renderTable(['Pipeline', 'Runs', 'Avg Cost', 'Total Cost', 'Avg Time'], rows) + '\n');
  } else {
    const stats = history.getStats();
    ctx.stdout.write(`${BOLD}Run Statistics${RESET}\n`);
    ctx.stdout.write(`Total runs:    ${stats.total_runs}\n`);
    ctx.stdout.write(`Total tokens:  ${stats.total_tokens_in.toLocaleString()} in / ${stats.total_tokens_out.toLocaleString()} out\n`);
    ctx.stdout.write(`Total cost:    $${stats.total_cost_usd.toFixed(4)}\n`);
    ctx.stdout.write(`Avg duration:  ${Math.round(stats.avg_duration_ms)}ms\n`);
    if (stats.cost_by_model.length > 0) {
      ctx.stdout.write(`\n${BOLD}Cost by Model:${RESET}\n`);
      const rows = stats.cost_by_model.map(m => [m.model_id, `$${m.cost_usd.toFixed(4)}`, `${m.run_count} runs`]);
      ctx.stdout.write(renderTable(['Model', 'Cost', 'Runs'], rows) + '\n');
    }
  }
  return true;
}

export async function handleBatch(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const batchSub = parts[1];
  const runHist = nodyn.getRunHistory();

  if (batchSub === 'list' && runHist) {
    // List recent batch parents from run history
    const batches = runHist.getRecentRuns(50).filter(r => r.run_type === 'batch_parent');
    if (batches.length === 0) { ctx.stdout.write('No batches recorded.\n'); return true; }
    const rows = batches.map(b => {
      const summary = runHist.getBatchSummary(b.id);
      return [b.id.slice(0, 8), `${summary.total} items`, `${summary.succeeded} ok / ${summary.failed} fail`, `$${summary.totalCost.toFixed(4)}`, b.created_at];
    });
    ctx.stdout.write(renderTable(['ID', 'Items', 'Status', 'Cost', 'Created'], rows) + '\n');
    return true;
  }

  if (batchSub && runHist) {
    // Check if it's a run ID (batch detail)
    const batchRun = runHist.getRun(batchSub);
    if (batchRun && batchRun.run_type === 'batch_parent') {
      const action = parts[2];

      if (action === 'retry-failed') {
        const items = runHist.getBatchRuns(batchRun.id).filter(r => r.status === 'failed');
        if (items.length === 0) { ctx.stdout.write('No failed items to retry.\n'); return true; }
        const reqs: BatchRequest[] = items.map(item => ({
          id: `retry-${item.id.slice(0, 8)}`,
          task: item.task_text,
        }));
        const newBatchId = await nodyn.batch(reqs);
        ctx.stdout.write(`Retrying ${items.length} failed items. New batch: ${newBatchId}\n`);
        return true;
      }

      if (action === 'export') {
        const items = runHist.getBatchRuns(batchRun.id);
        const exportData = items.map(item => ({
          id: item.id,
          task: item.task_text,
          response: item.response_text,
          status: item.status,
          cost_usd: item.cost_usd,
        }));
        ctx.stdout.write(JSON.stringify(exportData, null, 2) + '\n');
        return true;
      }

      // Detail view
      const items = runHist.getBatchRuns(batchRun.id);
      const summary = runHist.getBatchSummary(batchRun.id);
      ctx.stdout.write(`${BOLD}Batch ${batchRun.id.slice(0, 8)}${RESET} — ${summary.total} items\n`);
      ctx.stdout.write(`Succeeded: ${summary.succeeded} | Failed: ${summary.failed} | Cost: $${summary.totalCost.toFixed(4)}\n\n`);
      const rows = items.map(r => [r.id.slice(0, 8), r.task_text.slice(0, 40), r.status, `$${r.cost_usd.toFixed(4)}`]);
      ctx.stdout.write(renderTable(['ID', 'Task', 'Status', 'Cost'], rows) + '\n');
      return true;
    }
  }

  // Default: submit batch from file
  if (!batchSub) { ctx.stdout.write('Usage: /batch <file.json> | /batch list | /batch <id> [retry-failed|export]\n'); return true; }
  const raw = readFileSync(batchSub, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.stdout.write('Invalid batch JSON file.\n');
    return true;
  }
  if (!Array.isArray(parsed)) {
    ctx.stdout.write('Batch file must contain a JSON array of requests.\n');
    return true;
  }
  const requests = parsed
    .filter((entry): entry is BatchRequest =>
      typeof entry === 'object'
      && entry !== null
      && typeof (entry as { id?: unknown }).id === 'string'
      && typeof (entry as { task?: unknown }).task === 'string'
      && ((entry as { system?: unknown }).system === undefined || typeof (entry as { system?: unknown }).system === 'string')
      && ((entry as { label?: unknown }).label === undefined || typeof (entry as { label?: unknown }).label === 'string'),
    );
  if (requests.length === 0) {
    ctx.stdout.write('Batch file has no valid requests.\n');
    return true;
  }
  const batchId = await nodyn.batch(requests);
  ctx.stdout.write(`Batch submitted: ${batchId}\n`);
  return true;
}

export async function handleBatchStatus(parts: string[], nodyn: Nodyn, ctx: CLICtx): Promise<boolean> {
  const batchId = parts[1];
  if (!batchId) { ctx.stdout.write('Usage: /batch-status <batch_id>\n'); return true; }
  const entry = await nodyn.getBatchIndex().get(batchId);
  if (entry) {
    ctx.stdout.write(`Batch: ${batchId}\nSubmitted: ${entry.submitted_at}\nRequests: ${entry.request_count}\nLabel: ${entry.label}\n`);
  } else {
    ctx.stdout.write(`Batch ${batchId} not found in local index.\n`);
  }
  return true;
}
