import type Database from 'better-sqlite3';

export function getRepeatTasks(db: Database.Database, contextId: string, minCount: number, days: number): Array<{
  task_hash: string; task_text: string; run_count: number; session_count: number; last_run_at: string;
}> {
  return db.prepare(`
    SELECT task_hash, MIN(task_text) as task_text, COUNT(*) as run_count,
           COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) as session_count,
           MAX(created_at) as last_run_at
    FROM runs
    WHERE context_id = ? AND created_at >= datetime('now', ?)
      AND task_hash != ''
    GROUP BY task_hash
    HAVING COUNT(*) >= ?
    ORDER BY run_count DESC
    LIMIT 10
  `).all(contextId, `-${days} days`, minCount) as Array<{
    task_hash: string; task_text: string; run_count: number; session_count: number; last_run_at: string;
  }>;
}

export function getFailurePatterns(db: Database.Database, contextId: string, days: number): Array<{
  model_id: string; error_prefix: string; fail_count: number; last_failed_at: string;
}> {
  return db.prepare(`
    SELECT model_id, SUBSTR(response_text, 1, 100) as error_prefix,
           COUNT(*) as fail_count, MAX(created_at) as last_failed_at
    FROM runs
    WHERE context_id = ? AND status = 'failed'
      AND created_at >= datetime('now', ?)
    GROUP BY model_id, SUBSTR(response_text, 1, 100)
    ORDER BY fail_count DESC
    LIMIT 10
  `).all(contextId, `-${days} days`) as Array<{
    model_id: string; error_prefix: string; fail_count: number; last_failed_at: string;
  }>;
}

export function getCacheEfficiency(db: Database.Database, contextId: string, days: number): {
  total_cache_read: number; total_cache_write: number; total_input: number; run_count: number;
} | undefined {
  const row = db.prepare(`
    SELECT COALESCE(SUM(tokens_cache_read), 0) as total_cache_read,
           COALESCE(SUM(tokens_cache_write), 0) as total_cache_write,
           COALESCE(SUM(tokens_in), 0) as total_input,
           COUNT(*) as run_count
    FROM runs
    WHERE context_id = ? AND created_at >= datetime('now', ?)
  `).get(contextId, `-${days} days`) as {
    total_cache_read: number; total_cache_write: number; total_input: number; run_count: number;
  } | undefined;
  if (!row || row.run_count === 0) return undefined;
  return row;
}

export function getModelEfficiency(db: Database.Database, contextId: string, days: number): Array<{
  model_id: string; avg_tokens_out: number; avg_tool_calls: number;
  avg_cost_usd: number; avg_duration_ms: number; run_count: number;
}> {
  return db.prepare(`
    SELECT model_id,
           AVG(tokens_out) as avg_tokens_out,
           AVG(tool_call_count) as avg_tool_calls,
           AVG(cost_usd) as avg_cost_usd,
           AVG(duration_ms) as avg_duration_ms,
           COUNT(*) as run_count
    FROM runs
    WHERE context_id = ? AND status = 'completed'
      AND created_at >= datetime('now', ?)
    GROUP BY model_id
    ORDER BY avg_cost_usd DESC
    LIMIT 10
  `).all(contextId, `-${days} days`) as Array<{
    model_id: string; avg_tokens_out: number; avg_tool_calls: number;
    avg_cost_usd: number; avg_duration_ms: number; run_count: number;
  }>;
}

export function getPromptVariantStats(db: Database.Database, contextId: string, days: number): Array<{
  prompt_hash: string; run_count: number; avg_cost_usd: number;
  avg_tokens_in: number; error_count: number; first_seen: string; last_seen: string;
}> {
  return db.prepare(`
    SELECT prompt_hash,
           COUNT(*) as run_count,
           AVG(cost_usd) as avg_cost_usd,
           AVG(tokens_in) as avg_tokens_in,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as error_count,
           MIN(created_at) as first_seen,
           MAX(created_at) as last_seen
    FROM runs
    WHERE context_id = ? AND created_at >= datetime('now', ?)
      AND prompt_hash != ''
    GROUP BY prompt_hash
    ORDER BY last_seen DESC
    LIMIT 20
  `).all(contextId, `-${days} days`) as Array<{
    prompt_hash: string; run_count: number; avg_cost_usd: number;
    avg_tokens_in: number; error_count: number; first_seen: string; last_seen: string;
  }>;
}

export function getToolStats(db: Database.Database, contextId: string, days: number): Array<{
  tool_name: string; call_count: number; avg_duration_ms: number;
  error_count: number; total_duration_ms: number;
}> {
  return db.prepare(`
    SELECT tc.tool_name,
           COUNT(*) as call_count,
           AVG(tc.duration_ms) as avg_duration_ms,
           SUM(CASE WHEN tc.output_json != '' AND tc.output_json != '{}' THEN 1 ELSE 0 END) as error_count,
           SUM(tc.duration_ms) as total_duration_ms
    FROM run_tool_calls tc
    JOIN runs r ON tc.run_id = r.id
    WHERE r.context_id = ? AND r.created_at >= datetime('now', ?)
    GROUP BY tc.tool_name
    ORDER BY call_count DESC
    LIMIT 20
  `).all(contextId, `-${days} days`) as Array<{
    tool_name: string; call_count: number; avg_duration_ms: number;
    error_count: number; total_duration_ms: number;
  }>;
}

export function getPipelineStepStats(db: Database.Database, days: number): Array<{
  step_id: string; manifest_name: string; avg_duration_ms: number;
  total_runs: number; fail_count: number; avg_cost_usd: number;
}> {
  return db.prepare(`
    SELECT psr.step_id, pr.manifest_name,
           AVG(psr.duration_ms) as avg_duration_ms,
           COUNT(*) as total_runs,
           SUM(CASE WHEN psr.status = 'failed' THEN 1 ELSE 0 END) as fail_count,
           AVG(psr.cost_usd) as avg_cost_usd
    FROM pipeline_step_results psr
    JOIN pipeline_runs pr ON psr.pipeline_run_id = pr.id
    WHERE pr.started_at >= datetime('now', ?)
    GROUP BY psr.step_id, pr.manifest_name
  `).all(`-${days} days`) as Array<{
    step_id: string; manifest_name: string; avg_duration_ms: number;
    total_runs: number; fail_count: number; avg_cost_usd: number;
  }>;
}

export function getPipelineCostStats(db: Database.Database, days: number): Array<{
  manifest_name: string; run_count: number; avg_cost_usd: number;
  total_cost_usd: number; avg_duration_ms: number;
}> {
  return db.prepare(`
    SELECT manifest_name,
           COUNT(*) as run_count,
           AVG(total_cost_usd) as avg_cost_usd,
           SUM(total_cost_usd) as total_cost_usd,
           AVG(total_duration_ms) as avg_duration_ms
    FROM pipeline_runs
    WHERE started_at >= datetime('now', ?)
    GROUP BY manifest_name
  `).all(`-${days} days`) as Array<{
    manifest_name: string; run_count: number; avg_cost_usd: number;
    total_cost_usd: number; avg_duration_ms: number;
  }>;
}

export function getSessionSummaries(db: Database.Database, contextId: string, days: number): Array<{
  session_id: string; run_count: number; total_cost_usd: number;
  avg_duration_ms: number; model_ids: string; tool_call_count: number;
  completed_count: number; failed_count: number;
  first_run_at: string; last_run_at: string;
}> {
  return db.prepare(`
    SELECT session_id,
           COUNT(*) as run_count,
           COALESCE(SUM(cost_usd), 0) as total_cost_usd,
           AVG(duration_ms) as avg_duration_ms,
           GROUP_CONCAT(DISTINCT model_id) as model_ids,
           SUM(tool_call_count) as tool_call_count,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_count,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count,
           MIN(created_at) as first_run_at,
           MAX(created_at) as last_run_at
    FROM runs
    WHERE context_id = ? AND session_id != '' AND created_at >= datetime('now', ?)
    GROUP BY session_id ORDER BY last_run_at DESC LIMIT 50
  `).all(contextId, `-${days} days`) as Array<{
    session_id: string; run_count: number; total_cost_usd: number;
    avg_duration_ms: number; model_ids: string; tool_call_count: number;
    completed_count: number; failed_count: number;
    first_run_at: string; last_run_at: string;
  }>;
}
