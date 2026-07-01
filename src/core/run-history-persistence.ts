import type Database from 'better-sqlite3';
import type { TaskRecord, TriggerRecord } from '../types/index.js';
import type { ProcessRecord, ProcessStep, ProcessParameter } from '../types/index.js';
import { randomUUID } from 'node:crypto';

function generateId(): string {
  return randomUUID();
}

// Re-export locally for consumers that need the record type
export interface PromptSnapshotRecord {
  hash: string;
  profile_name: string;
  prompt_text: string;
  first_seen_at: string;
}

// ============================================================
// Prompt Snapshots
// ============================================================

export function insertPromptSnapshot(db: Database.Database, hash: string, profileName: string, promptText: string): void {
  db.prepare(
    'INSERT OR IGNORE INTO prompt_snapshots (hash, profile_name, prompt_text) VALUES (?, ?, ?)'
  ).run(hash, profileName, promptText);
}

export function getPromptSnapshot(db: Database.Database, hash: string): PromptSnapshotRecord | undefined {
  return db.prepare(
    'SELECT hash, profile_name, prompt_text, first_seen_at FROM prompt_snapshots WHERE hash = ?'
  ).get(hash) as PromptSnapshotRecord | undefined;
}

// ============================================================
// Scopes
// ============================================================

export function insertScope(db: Database.Database, id: string, type: string, name: string, parentId?: string | undefined): void {
  db.prepare(`
    INSERT OR IGNORE INTO scopes (id, type, name, parent_id) VALUES (?, ?, ?, ?)
  `).run(id, type, name, parentId ?? null);
}

export function getScope(db: Database.Database, id: string): { id: string; type: string; name: string; parent_id: string | null; metadata: string | null; created_at: string; updated_at: string } | undefined {
  return db.prepare('SELECT * FROM scopes WHERE id = ?').get(id) as {
    id: string; type: string; name: string; parent_id: string | null;
    metadata: string | null; created_at: string; updated_at: string;
  } | undefined;
}

export function listScopes(db: Database.Database, type?: string | undefined): Array<{ id: string; type: string; name: string; parent_id: string | null; created_at: string }> {
  if (type) {
    return db.prepare('SELECT id, type, name, parent_id, created_at FROM scopes WHERE type = ? ORDER BY created_at').all(type) as Array<{
      id: string; type: string; name: string; parent_id: string | null; created_at: string;
    }>;
  }
  return db.prepare('SELECT id, type, name, parent_id, created_at FROM scopes ORDER BY type, created_at').all() as Array<{
    id: string; type: string; name: string; parent_id: string | null; created_at: string;
  }>;
}

export function deleteScope(db: Database.Database, id: string): boolean {
  // Prevent deleting if child scopes reference this scope
  const childCount = db.prepare(
    'SELECT COUNT(*) as cnt FROM scopes WHERE parent_id = ?'
  ).get(id) as { cnt: number };
  if (childCount.cnt > 0) return false;
  const result = db.prepare('DELETE FROM scopes WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getScopeChildren(db: Database.Database, parentId: string): Array<{ id: string; type: string; name: string; parent_id: string | null; created_at: string }> {
  return db.prepare(
    'SELECT id, type, name, parent_id, created_at FROM scopes WHERE parent_id = ? ORDER BY created_at'
  ).all(parentId) as Array<{
    id: string; type: string; name: string; parent_id: string | null; created_at: string;
  }>;
}

export function getScopeTree(db: Database.Database, rootId: string): Array<{ id: string; type: string; name: string; parent_id: string | null; depth: number }> {
  return db.prepare(`
    WITH RECURSIVE tree AS (
      SELECT id, type, name, parent_id, 0 as depth FROM scopes WHERE id = ?
      UNION ALL
      SELECT s.id, s.type, s.name, s.parent_id, t.depth + 1
      FROM scopes s JOIN tree t ON s.parent_id = t.id
    )
    SELECT * FROM tree ORDER BY depth, id
  `).all(rootId) as Array<{
    id: string; type: string; name: string; parent_id: string | null; depth: number;
  }>;
}

// ============================================================
// Embeddings
// ============================================================

export function insertEmbedding(db: Database.Database, params: {
  projectId: string;
  namespace: string;
  text: string;
  embedding: Buffer;
  embeddingDim: number;
  provider: string;
  sourceRunId?: string | undefined;
  scopeType?: string | undefined;
  scopeId?: string | undefined;
}): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO memory_embeddings (id, project_id, namespace, text, embedding, embedding_dim, provider, source_run_id, scope_type, scope_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.projectId, params.namespace, params.text, params.embedding, params.embeddingDim, params.provider, params.sourceRunId ?? null, params.scopeType ?? 'project', params.scopeId ?? params.projectId);
  return id;
}

export function getEmbeddings(db: Database.Database, projectId: string): Array<{
  id: string;
  project_id: string;
  namespace: string;
  text: string;
  embedding: Buffer;
  embedding_dim: number;
  provider: string;
  source_run_id: string | null;
  last_retrieved_at: string | null;
  created_at: string;
}> {
  return db.prepare(
    'SELECT * FROM memory_embeddings WHERE project_id = ? OR project_id = ? ORDER BY created_at DESC'
  ).all(projectId, '') as Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
  }>;
}

export function updateEmbeddingRetrieved(db: Database.Database, id: string): void {
  db.prepare(
    "UPDATE memory_embeddings SET last_retrieved_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function deleteOldEmbeddings(db: Database.Database, daysOld: number): number {
  const result = db.prepare(
    "DELETE FROM memory_embeddings WHERE last_retrieved_at IS NULL AND created_at < datetime('now', ?)"
  ).run(`-${daysOld} days`);
  return result.changes;
}

export function getStaleEmbeddings(
  db: Database.Database,
  scopeType: string,
  scopeId: string,
  daysOld: number,
): Array<{
  id: string; text: string; namespace: string;
  created_at: string; last_retrieved_at: string | null;
}> {
  return db.prepare(
    `SELECT id, text, namespace, created_at, last_retrieved_at FROM memory_embeddings
     WHERE scope_type = ? AND scope_id = ?
     AND created_at < datetime('now', ?)
     AND (last_retrieved_at IS NULL OR last_retrieved_at < datetime('now', ?))`
  ).all(scopeType, scopeId, `-${daysOld} days`, `-${daysOld} days`) as Array<{
    id: string; text: string; namespace: string;
    created_at: string; last_retrieved_at: string | null;
  }>;
}

export function deleteEmbedding(db: Database.Database, id: string): boolean {
  const result = db.prepare(
    'DELETE FROM memory_embeddings WHERE id = ?'
  ).run(id);
  return result.changes > 0;
}

export function getEmbeddingsByScope(db: Database.Database, scopeType: string, scopeId: string): Array<{
  id: string; project_id: string; namespace: string; text: string;
  embedding: Buffer; embedding_dim: number; provider: string;
  source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
  scope_type: string; scope_id: string;
}> {
  return db.prepare(
    'SELECT * FROM memory_embeddings WHERE scope_type = ? AND scope_id = ? ORDER BY created_at DESC'
  ).all(scopeType, scopeId) as Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    scope_type: string; scope_id: string;
  }>;
}

export function getEmbeddingsMultiScope(db: Database.Database, scopes: Array<{ type: string; id: string }>): Array<{
  id: string; project_id: string; namespace: string; text: string;
  embedding: Buffer; embedding_dim: number; provider: string;
  source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
  scope_type: string; scope_id: string;
}> {
  if (scopes.length === 0) return [];
  const conditions = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
  const params = scopes.flatMap(s => [s.type, s.id]);
  return db.prepare(
    `SELECT * FROM memory_embeddings WHERE ${conditions} ORDER BY created_at DESC`
  ).all(...params) as Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    scope_type: string; scope_id: string;
  }>;
}

/**
 * Like getEmbeddings but with optional namespace filter and LIMIT.
 * Orders by rowid DESC (most recent first) before applying LIMIT.
 */
export function getEmbeddingsFiltered(db: Database.Database, projectId: string, opts?: { namespace?: string | undefined; limit?: number | undefined }): Array<{
  id: string; project_id: string; namespace: string; text: string;
  embedding: Buffer; embedding_dim: number; provider: string;
  source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
}> {
  const limit = opts?.limit ?? 500;
  if (opts?.namespace !== undefined) {
    return db.prepare(
      'SELECT * FROM memory_embeddings WHERE (project_id = ? OR project_id = ?) AND namespace = ? ORDER BY rowid DESC LIMIT ?'
    ).all(projectId, '', opts.namespace, limit) as Array<{
      id: string; project_id: string; namespace: string; text: string;
      embedding: Buffer; embedding_dim: number; provider: string;
      source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    }>;
  }
  return db.prepare(
    'SELECT * FROM memory_embeddings WHERE (project_id = ? OR project_id = ?) ORDER BY rowid DESC LIMIT ?'
  ).all(projectId, '', limit) as Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
  }>;
}

/**
 * Like getEmbeddingsMultiScope but with optional namespace filter and LIMIT.
 * Orders by rowid DESC (most recent first) before applying LIMIT.
 */
export function getEmbeddingsMultiScopeFiltered(db: Database.Database, scopes: Array<{ type: string; id: string }>, opts?: { namespace?: string | undefined; limit?: number | undefined }): Array<{
  id: string; project_id: string; namespace: string; text: string;
  embedding: Buffer; embedding_dim: number; provider: string;
  source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
  scope_type: string; scope_id: string;
}> {
  if (scopes.length === 0) return [];
  const limit = opts?.limit ?? 500;
  const conditions = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
  const params: Array<string | number> = scopes.flatMap(s => [s.type, s.id]);
  if (opts?.namespace !== undefined) {
    return db.prepare(
      `SELECT * FROM memory_embeddings WHERE (${conditions}) AND namespace = ? ORDER BY rowid DESC LIMIT ?`
    ).all(...params, opts.namespace, limit) as Array<{
      id: string; project_id: string; namespace: string; text: string;
      embedding: Buffer; embedding_dim: number; provider: string;
      source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
      scope_type: string; scope_id: string;
    }>;
  }
  return db.prepare(
    `SELECT * FROM memory_embeddings WHERE (${conditions}) ORDER BY rowid DESC LIMIT ?`
  ).all(...params, limit) as Array<{
    id: string; project_id: string; namespace: string; text: string;
    embedding: Buffer; embedding_dim: number; provider: string;
    source_run_id: string | null; last_retrieved_at: string | null; created_at: string;
    scope_type: string; scope_id: string;
  }>;
}

// ============================================================
// Pre-Approval
// ============================================================

export function insertPreApprovalSet(db: Database.Database, params: {
  id: string;
  taskSummary: string;
  approvedBy: string;
  patternsJson: string;
  maxUses: number;
  ttlMs: number;
  runId?: string | undefined;
}): void {
  db.prepare(`
    INSERT INTO pre_approval_sets (id, task_summary, approved_by, patterns_json, max_uses, ttl_ms, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(params.id, params.taskSummary, params.approvedBy, params.patternsJson, params.maxUses, params.ttlMs, params.runId ?? null);
}

export function insertPreApprovalEvent(db: Database.Database, params: {
  setId: string;
  patternIdx: number;
  toolName: string;
  matchString: string;
  pattern: string;
  decision: string;
  autonomyLevel?: string | undefined;
  runId?: string | undefined;
}): void {
  db.prepare(`
    INSERT INTO pre_approval_events (set_id, pattern_idx, tool_name, match_string, pattern, decision, autonomy_level, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(params.setId, params.patternIdx, params.toolName, params.matchString, params.pattern, params.decision, params.autonomyLevel ?? null, params.runId ?? null);
}

export function getPreApprovalSets(db: Database.Database, limit = 20): Array<{
  id: string; task_summary: string; approved_by: string;
  patterns_json: string; max_uses: number; ttl_ms: number;
  run_id: string | null; created_at: string;
}> {
  return db.prepare(
    'SELECT * FROM pre_approval_sets ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as Array<{
    id: string; task_summary: string; approved_by: string;
    patterns_json: string; max_uses: number; ttl_ms: number;
    run_id: string | null; created_at: string;
  }>;
}

export function getPreApprovalEvents(db: Database.Database, setId: string): Array<{
  id: number; set_id: string; pattern_idx: number;
  tool_name: string; match_string: string; pattern: string;
  decision: string; autonomy_level: string | null;
  run_id: string | null; created_at: string;
}> {
  return db.prepare(
    'SELECT * FROM pre_approval_events WHERE set_id = ? ORDER BY created_at'
  ).all(setId) as Array<{
    id: number; set_id: string; pattern_idx: number;
    tool_name: string; match_string: string; pattern: string;
    decision: string; autonomy_level: string | null;
    run_id: string | null; created_at: string;
  }>;
}

export function getPreApprovalSummary(db: Database.Database, setId: string): {
  total_matches: number; total_exhausted: number; total_expired: number;
} | undefined {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) as total_matches,
      SUM(CASE WHEN decision = 'exhausted' THEN 1 ELSE 0 END) as total_exhausted,
      SUM(CASE WHEN decision = 'expired' THEN 1 ELSE 0 END) as total_expired
    FROM pre_approval_events WHERE set_id = ?
  `).get(setId) as { total_matches: number; total_exhausted: number; total_expired: number } | undefined;
  return row;
}

// ============================================================
// Pipelines
// ============================================================

export function insertPipelineRun(db: Database.Database, params: {
  id: string;
  manifestName: string;
  status: string;
  manifestJson: string;
  totalDurationMs?: number | undefined;
  totalCostUsd?: number | undefined;
  totalTokensIn?: number | undefined;
  totalTokensOut?: number | undefined;
  stepCount?: number | undefined;
  parentRunId?: string | undefined;
  error?: string | undefined;
  /** Slice C2: the saved-workflow id this run executed (null for ad-hoc/inline
   *  runs), so a failed run can be resolved back to its workflow for fix/re-run. */
  workflowId?: string | undefined;
}): void {
  db.prepare(`
    INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, total_duration_ms, total_cost_usd, total_tokens_in, total_tokens_out, step_count, parent_run_id, error, workflow_id, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    params.id, params.manifestName, params.status, params.manifestJson,
    params.totalDurationMs ?? 0, params.totalCostUsd ?? 0,
    params.totalTokensIn ?? 0, params.totalTokensOut ?? 0,
    params.stepCount ?? 0, params.parentRunId ?? null, params.error ?? null,
    params.workflowId ?? null,
  );
}

export function updatePipelineRun(db: Database.Database, id: string, params: {
  status?: string | undefined;
  totalDurationMs?: number | undefined;
  totalCostUsd?: number | undefined;
  error?: string | undefined;
}): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }
  if (params.totalDurationMs !== undefined) { sets.push('total_duration_ms = ?'); values.push(params.totalDurationMs); }
  if (params.totalCostUsd !== undefined) { sets.push('total_cost_usd = ?'); values.push(params.totalCostUsd); }
  if (params.error !== undefined) { sets.push('error = ?'); values.push(params.error); }
  if (sets.length === 0) return;
  sets.push("completed_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE pipeline_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function insertPipelineStepResult(db: Database.Database, params: {
  pipelineRunId: string;
  stepId: string;
  status: string;
  result?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
  tokensIn?: number | undefined;
  tokensOut?: number | undefined;
  costUsd?: number | undefined;
  modelTier?: string | undefined;
}): void {
  db.prepare(`
    INSERT INTO pipeline_step_results (pipeline_run_id, step_id, status, result, error, duration_ms, tokens_in, tokens_out, cost_usd, model_tier)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.pipelineRunId, params.stepId, params.status,
    params.result ?? '', params.error ?? null,
    params.durationMs ?? 0, params.tokensIn ?? 0, params.tokensOut ?? 0, params.costUsd ?? 0,
    params.modelTier ?? '',
  );
}

export function getRecentPipelineRuns(db: Database.Database, limit = 20): Array<{
  id: string; manifest_name: string; status: string; total_duration_ms: number;
  total_cost_usd: number; step_count: number; error: string | null; started_at: string;
}> {
  // Exclude `status='planned'` rows (T2-W2): saved workflows and not-yet-run
  // plans share the `pipeline_runs` table with actual runs but represent
  // templates/plans, not executions. Without this filter, the Workflows
  // run-history tab leaks every saved-workflow library entry.
  return db.prepare(
    "SELECT id, manifest_name, status, total_duration_ms, total_cost_usd, step_count, error, started_at FROM pipeline_runs WHERE status != 'planned' ORDER BY started_at DESC LIMIT ?"
  ).all(limit) as Array<{
    id: string; manifest_name: string; status: string; total_duration_ms: number;
    total_cost_usd: number; step_count: number; error: string | null; started_at: string;
  }>;
}

export function getPipelineRun(db: Database.Database, id: string): {
  id: string; manifest_name: string; status: string; manifest_json: string;
  total_duration_ms: number; total_cost_usd: number; total_tokens_in: number;
  total_tokens_out: number; step_count: number; parent_run_id: string | null;
  error: string | null; workflow_id: string | null; started_at: string; completed_at: string | null;
} | undefined {
  // Escape LIKE metacharacters in the (possibly untrusted — LLM/client-supplied,
  // Slice C2) id so a `%`/`_` can't widen the prefix match to arbitrary rows.
  // Exclude `status='planned'` rows: those are saved-workflow TEMPLATES that
  // share this table, and a workflow id passed as a run id must NOT resolve to
  // one (it would render a bogus "run" with status 'planned'). A real run is
  // never 'planned'.
  const likePattern = `${id.replace(/[\\%_]/g, '\\$&')}%`;
  return db.prepare(
    "SELECT * FROM pipeline_runs WHERE (id = ? OR id LIKE ? ESCAPE '\\') AND status != 'planned'"
  ).get(id, likePattern) as {
    id: string; manifest_name: string; status: string; manifest_json: string;
    total_duration_ms: number; total_cost_usd: number; total_tokens_in: number;
    total_tokens_out: number; step_count: number; parent_run_id: string | null;
    error: string | null; workflow_id: string | null; started_at: string; completed_at: string | null;
  } | undefined;
}

export function getPipelineStepResults(db: Database.Database, pipelineRunId: string): Array<{
  id: number; pipeline_run_id: string; step_id: string; status: string;
  result: string; error: string | null; duration_ms: number;
  tokens_in: number; tokens_out: number; cost_usd: number;
}> {
  return db.prepare(
    'SELECT * FROM pipeline_step_results WHERE pipeline_run_id = ? ORDER BY id'
  ).all(pipelineRunId) as Array<{
    id: number; pipeline_run_id: string; step_id: string; status: string;
    result: string; error: string | null; duration_ms: number;
    tokens_in: number; tokens_out: number; cost_usd: number;
  }>;
}

// === Planned pipeline persistence ===

export function insertPlannedPipeline(db: Database.Database, planned: { id: string; name: string; goal: string; steps: unknown[]; reasoning: string; estimatedCost: number; createdAt: string }): void {
  db.prepare(`
    INSERT OR REPLACE INTO pipeline_runs (id, manifest_name, status, manifest_json, step_count)
    VALUES (?, ?, 'planned', ?, ?)
  `).run(planned.id, planned.name, JSON.stringify(planned), planned.steps.length);
}

export function getPlannedPipeline(db: Database.Database, id: string): { id: string; manifest_json: string } | undefined {
  return db.prepare(
    "SELECT id, manifest_json FROM pipeline_runs WHERE (id = ? OR id LIKE ?) AND status = 'planned' LIMIT 1"
  ).get(id, `${id}%`) as { id: string; manifest_json: string } | undefined;
}

/**
 * List every planned pipeline row (`status='planned'`), newest first. The
 * "saved workflow" library filter — `manifest_json.template === true` — is an
 * app-layer concern (there is no `template` column, PRD §6.8 / D13), so this
 * query stays a plain status filter and the caller deserializes + filters.
 */
export function getPlannedPipelines(db: Database.Database, limit = 100): Array<{
  id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
}> {
  return db.prepare(
    "SELECT id, manifest_name, manifest_json, step_count, started_at FROM pipeline_runs WHERE status = 'planned' ORDER BY started_at DESC LIMIT ?"
  ).all(limit) as Array<{
    id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
  }>;
}

/**
 * UNBOUNDED full-scan of every planned-pipeline (workflow) definition — the S3d
 * backfill source. Deliberately NO `LIMIT`: the clamped {@link getPlannedPipelines}
 * (default 100) would silently drop rows past the first page, undercounting the
 * backfill. Verb-def volume is human-bounded (dozens, not the KG's thousands), so
 * an unbounded scan is correct-by-construction, never a memory risk. Ordered by
 * `started_at` so the backfill upserts in the legacy library-read order. Mirrors
 * the S2 backfill's `listAllEntities` (unclamped) vs the clamped `listEntities`.
 */
export function getAllPlannedPipelines(db: Database.Database): Array<{
  id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
}> {
  return db.prepare(
    "SELECT id, manifest_name, manifest_json, step_count, started_at FROM pipeline_runs WHERE status = 'planned' ORDER BY started_at DESC"
  ).all() as Array<{
    id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
  }>;
}

/**
 * Rename a planned pipeline's display name. The name lives in TWO places — the
 * `manifest_name` column AND the serialized `PlannedPipeline.name` inside
 * `manifest_json` (which the library list and `getPipeline`'s SQLite fallback
 * both prefer). Both are patched together so a rename actually propagates.
 */
export function renamePlannedPipeline(db: Database.Database, id: string, name: string): boolean {
  const res = db.prepare(
    "UPDATE pipeline_runs SET manifest_name = ?, manifest_json = json_set(manifest_json, '$.name', ?) WHERE (id = ? OR id LIKE ?) AND status = 'planned'"
  ).run(name, name, id, `${id}%`);
  return res.changes > 0;
}

/** Delete a planned pipeline row. Only `status='planned'` rows are removable. */
export function deletePlannedPipeline(db: Database.Database, id: string): boolean {
  const res = db.prepare(
    "DELETE FROM pipeline_runs WHERE (id = ? OR id LIKE ?) AND status = 'planned'"
  ).run(id, `${id}%`);
  return res.changes > 0;
}

export function markPipelineExecuted(db: Database.Database, id: string): void {
  db.prepare("UPDATE pipeline_runs SET status = 'executed', completed_at = datetime('now') WHERE id = ?").run(id);
}

// ============================================================
// Tasks (USER-TODOs — `tasks` table) + Triggers (AGENT-TRIGGERs — `triggers`
// table). Split in migration v42: Tasks track user work (perceive/track side,
// never fired by the WorkerLoop); Triggers fire workflows (act side).
// ============================================================

export function insertTask(db: Database.Database, params: {
  id: string;
  title: string;
  description?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  scopeType?: string | undefined;
  scopeId?: string | undefined;
  dueDate?: string | undefined;
  tags?: string | undefined;
  parentTaskId?: string | undefined;
}): void {
  db.prepare(`
    INSERT INTO tasks (id, title, description, status, priority, assignee, scope_type, scope_id, due_date, tags, parent_task_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id, params.title, params.description ?? '',
    params.status ?? 'open', params.priority ?? 'medium',
    params.assignee ?? null,
    params.scopeType ?? 'project', params.scopeId ?? '',
    params.dueDate ?? null, params.tags ?? null, params.parentTaskId ?? null,
  );
}

/** Insert an AGENT-TRIGGER row (cron/watch/pipeline/reminder/backup). Mirrors
 *  the old `insertTask` trigger half. `assignee` defaults to 'lynox' (all
 *  triggers are fired by lynox), `taskType` to 'manual'. */
export function insertTrigger(db: Database.Database, params: {
  id: string;
  title: string;
  description?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
  scopeType?: string | undefined;
  scopeId?: string | undefined;
  scheduleCron?: string | undefined;
  nextRunAt?: string | undefined;
  taskType?: string | undefined;
  watchConfig?: string | undefined;
  maxRetries?: number | undefined;
  notificationChannel?: string | undefined;
  pipelineId?: string | undefined;
  pipelineParams?: string | undefined;
}): void {
  db.prepare(`
    INSERT INTO triggers (id, title, description, status, assignee, scope_type, scope_id, schedule_cron, next_run_at, task_type, watch_config, max_retries, notification_channel, pipeline_id, pipeline_params)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id, params.title, params.description ?? '',
    params.status ?? 'open', params.assignee ?? 'lynox',
    params.scopeType ?? 'project', params.scopeId ?? '',
    params.scheduleCron ?? null, params.nextRunAt ?? null,
    params.taskType ?? 'manual', params.watchConfig ?? null,
    params.maxRetries ?? 0, params.notificationChannel ?? null,
    params.pipelineId ?? null, params.pipelineParams ?? null,
  );
}

/** Slice B2: stamp `confirmedAt` onto a saved workflow's manifest blob (the
 *  human's first-run-confirm at promote-to-cron). Mirrors renamePlannedPipeline. */
export function setWorkflowConfirmedAt(db: Database.Database, id: string, confirmedAt: string): boolean {
  const res = db.prepare(
    "UPDATE pipeline_runs SET manifest_json = json_set(manifest_json, '$.confirmedAt', ?) WHERE (id = ? OR id LIKE ?) AND status = 'planned'"
  ).run(confirmedAt, id, `${id}%`);
  return res.changes > 0;
}

/** Slice B2: flip a scheduled trigger's cron kill-switch. */
export function setTriggerEnabled(db: Database.Database, id: string, enabled: boolean): boolean {
  const res = db.prepare(
    "UPDATE triggers SET enabled = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(enabled ? 1 : 0, id);
  return res.changes > 0;
}

export function updateTask(db: Database.Database, id: string, params: {
  title?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  dueDate?: string | undefined;
  tags?: string | undefined;
  completedAt?: string | undefined;
}, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): boolean {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.title !== undefined) { sets.push('title = ?'); values.push(params.title); }
  if (params.description !== undefined) { sets.push('description = ?'); values.push(params.description); }
  if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }
  if (params.priority !== undefined) { sets.push('priority = ?'); values.push(params.priority); }
  if (params.assignee !== undefined) { sets.push('assignee = ?'); values.push(params.assignee || null); }
  if (params.dueDate !== undefined) { sets.push('due_date = ?'); values.push(params.dueDate || null); }
  if (params.tags !== undefined) { sets.push('tags = ?'); values.push(params.tags || null); }
  if (params.completedAt !== undefined) { sets.push('completed_at = ?'); values.push(params.completedAt || null); }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");

  // Optional scope guard. When provided, fold the (scope_type, scope_id)
  // check INTO the UPDATE's WHERE clause so check + mutation are a single
  // SQL statement — the row never gets written if its scope is outside
  // the caller's active set, even under a hostile race. The tool layer
  // does an upfront getTask() for a friendlier error message, but this
  // WHERE is the canonical guard.
  const where: string[] = ['id = ?'];
  values.push(id);
  if (opts?.scopeFilter && opts.scopeFilter.length > 0) {
    const ors = opts.scopeFilter.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    where.push(`(${ors})`);
    for (const s of opts.scopeFilter) { values.push(s.type, s.id); }
  }
  return db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...values).changes > 0;
}

/** Update an AGENT-TRIGGER row. `nextRunAt`/`scheduleCron`: `undefined` leaves
 *  the column unchanged; empty-string/null clears it (mirrors the old
 *  `updateTask` schedule half — lets the agent un-schedule a trigger without
 *  deleting it). */
export function updateTrigger(db: Database.Database, id: string, params: {
  title?: string | undefined;
  description?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
  nextRunAt?: string | null | undefined;
  scheduleCron?: string | null | undefined;
}, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): boolean {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.title !== undefined) { sets.push('title = ?'); values.push(params.title); }
  if (params.description !== undefined) { sets.push('description = ?'); values.push(params.description); }
  if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }
  if (params.assignee !== undefined) { sets.push('assignee = ?'); values.push(params.assignee || null); }
  // Empty string / null clears the column. Lets the agent un-schedule a
  // one-shot trigger without deleting it (e.g. cancel a reminder).
  if (params.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(params.nextRunAt || null); }
  if (params.scheduleCron !== undefined) { sets.push('schedule_cron = ?'); values.push(params.scheduleCron || null); }
  if (sets.length === 0) return false;
  sets.push("updated_at = datetime('now')");

  // Optional scope guard — same atomic check-and-write as updateTask: fold the
  // (scope_type, scope_id) check INTO the UPDATE's WHERE so the row is never
  // written if its scope falls outside the caller's active set, even under a
  // hostile re-scope race between resolve and write (no TOCTOU window).
  const where: string[] = ['id = ?'];
  values.push(id);
  if (opts?.scopeFilter && opts.scopeFilter.length > 0) {
    const ors = opts.scopeFilter.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    where.push(`(${ors})`);
    for (const s of opts.scopeFilter) { values.push(s.type, s.id); }
  }
  return db.prepare(`UPDATE triggers SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`).run(...values).changes > 0;
}

export function getTask(db: Database.Database, id: string, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): TaskRecord | undefined {
  const where: string[] = ['(id = ? OR id LIKE ?)'];
  const params: unknown[] = [id, `${id}%`];
  if (opts?.scopeFilter && opts.scopeFilter.length > 0) {
    const ors = opts.scopeFilter.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    where.push(`(${ors})`);
    for (const s of opts.scopeFilter) { params.push(s.type, s.id); }
  }
  return db.prepare(
    `SELECT * FROM tasks WHERE ${where.join(' AND ')}`
  ).get(...params) as TaskRecord | undefined;
}

/** Look up an AGENT-TRIGGER by id (or id-prefix). Mirrors `getTask` incl. the
 *  optional scope guard. */
export function getTrigger(db: Database.Database, id: string, opts?: { scopeFilter?: Array<{ type: string; id: string }> | undefined }): TriggerRecord | undefined {
  const where: string[] = ['(id = ? OR id LIKE ?)'];
  const params: unknown[] = [id, `${id}%`];
  if (opts?.scopeFilter && opts.scopeFilter.length > 0) {
    const ors = opts.scopeFilter.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    where.push(`(${ors})`);
    for (const s of opts.scopeFilter) { params.push(s.type, s.id); }
  }
  return db.prepare(
    `SELECT * FROM triggers WHERE ${where.join(' AND ')}`
  ).get(...params) as TriggerRecord | undefined;
}

export function deleteTask(db: Database.Database, id: string): boolean {
  // Delete subtasks first
  db.prepare('DELETE FROM tasks WHERE parent_task_id = ?').run(id);
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}

/** Ids of the DIRECT subtasks of a task — the exact set {@link deleteTask}
 *  cascades. Read BEFORE that delete so the engine.db verb-graph mirror can
 *  remove the same set: the mirror's own `parent_task_id` may be FK-guarded to
 *  NULL for a pre-flag orphan (parent created before the mirror was enabled), so
 *  it can't reliably recompute the cascade from its own links. */
export function getTaskChildIds(db: Database.Database, id: string): string[] {
  return (db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').all(id) as Array<{ id: string }>)
    .map(r => r.id);
}

/** Delete an AGENT-TRIGGER. Triggers have no parent_task_id, so no subtask
 *  cascade. */
export function deleteTrigger(db: Database.Database, id: string): boolean {
  return db.prepare('DELETE FROM triggers WHERE id = ?').run(id).changes > 0;
}

export function getTasks(db: Database.Database, opts?: {
  scopeType?: string | undefined;
  scopeId?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
  parentTaskId?: string | undefined;
  limit?: number | undefined;
}): TaskRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.scopeType) { where.push('scope_type = ?'); params.push(opts.scopeType); }
  if (opts?.scopeId) { where.push('scope_id = ?'); params.push(opts.scopeId); }
  if (opts?.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts?.assignee) { where.push('assignee = ?'); params.push(opts.assignee); }
  if (opts?.parentTaskId !== undefined) {
    if (opts.parentTaskId === null) {
      where.push('parent_task_id IS NULL');
    } else {
      where.push('parent_task_id = ?'); params.push(opts.parentTaskId);
    }
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;
  params.push(limit);
  return db.prepare(
    `SELECT * FROM tasks ${whereClause} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, due_date ASC NULLS LAST, created_at DESC LIMIT ?`
  ).all(...params) as TaskRecord[];
}

/** List AGENT-TRIGGERs. Ordered by next_run_at ASC (NULLS LAST), then
 *  created_at DESC. */
export function getTriggers(db: Database.Database, opts?: {
  scopeType?: string | undefined;
  scopeId?: string | undefined;
  status?: string | undefined;
  taskType?: string | undefined;
  limit?: number | undefined;
}): TriggerRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts?.scopeType) { where.push('scope_type = ?'); params.push(opts.scopeType); }
  if (opts?.scopeId) { where.push('scope_id = ?'); params.push(opts.scopeId); }
  if (opts?.status) { where.push('status = ?'); params.push(opts.status); }
  if (opts?.taskType) { where.push('task_type = ?'); params.push(opts.taskType); }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;
  params.push(limit);
  return db.prepare(
    `SELECT * FROM triggers ${whereClause} ORDER BY next_run_at ASC NULLS LAST, created_at DESC LIMIT ?`
  ).all(...params) as TriggerRecord[];
}

/**
 * UNBOUNDED full-scan of every USER-TODO (`tasks`) row — the S3d backfill source.
 * NO `LIMIT` (the clamped {@link getTasks} default-100 would undercount). Ordered
 * `created_at ASC` so a PARENT task is upserted before its children whenever the
 * parent was created first (the common case) — the backfill's pass-2 re-link then
 * only has to fix genuinely out-of-order parent/child pairs. See {@link getAllPlannedPipelines}.
 */
export function getAllTasks(db: Database.Database): TaskRecord[] {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as TaskRecord[];
}

/** UNBOUNDED full-scan of every AGENT-TRIGGER (`triggers`) row — the S3d backfill
 *  source. NO `LIMIT` (see {@link getAllTasks}). Ordered `created_at ASC` for a
 *  stable, deterministic backfill order. */
export function getAllTriggers(db: Database.Database): TriggerRecord[] {
  return db.prepare('SELECT * FROM triggers ORDER BY created_at ASC').all() as TriggerRecord[];
}

export function getTasksDueInRange(db: Database.Database, start: string, end: string, scopes?: Array<{ type: string; id: string }> | undefined): TaskRecord[] {
  if (scopes && scopes.length > 0) {
    const scopeConditions = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    const params = scopes.flatMap(s => [s.type, s.id]);
    return db.prepare(
      `SELECT * FROM tasks WHERE due_date >= ? AND due_date <= ? AND status != 'completed' AND (${scopeConditions}) ORDER BY due_date ASC, priority ASC`
    ).all(start, end, ...params) as TaskRecord[];
  }
  return db.prepare(
    `SELECT * FROM tasks WHERE due_date >= ? AND due_date <= ? AND status != 'completed' ORDER BY due_date ASC, priority ASC`
  ).all(start, end) as TaskRecord[];
}

export function getOverdueTasks(db: Database.Database, scopes?: Array<{ type: string; id: string }> | undefined): TaskRecord[] {
  const now = new Date().toISOString().slice(0, 10);
  if (scopes && scopes.length > 0) {
    const scopeConditions = scopes.map(() => '(scope_type = ? AND scope_id = ?)').join(' OR ');
    const params = scopes.flatMap(s => [s.type, s.id]);
    return db.prepare(
      `SELECT * FROM tasks WHERE due_date < ? AND status != 'completed' AND (${scopeConditions}) ORDER BY due_date ASC`
    ).all(now, ...params) as TaskRecord[];
  }
  return db.prepare(
    `SELECT * FROM tasks WHERE due_date < ? AND status != 'completed' ORDER BY due_date ASC`
  ).all(now) as TaskRecord[];
}

/** Get triggers that are due for execution (next_run_at <= now, not in a
 * terminal status). Terminal = 'completed', or 'failed' for ONE-SHOT
 * triggers only. Cron triggers (`schedule_cron IS NOT NULL`) are kept in the
 * queue even when status='failed' so a single transient failure doesn't
 * permanently disable a recurring schedule — `recordTaskRun` derives the
 * cron trigger's status from the latest run (failed/open) and the cron
 * schedule itself determines re-fires. See task-manager.ts `recordTaskRun`
 * cron branch.
 *
 * We also clear next_run_at when a ONE-SHOT trigger reaches a terminal
 * state, so each guard is redundant with the other for one-shots — but
 * keeping both prevents a failed trigger with a stale `next_run_at` (e.g.
 * a row that pre-dates the v31 fix) from re-firing after migration.
 */
export function getDueTriggers(db: Database.Database): TriggerRecord[] {
  const now = new Date().toISOString();
  // Slice B2 — kill-switch: a disabled trigger (enabled=0) is simply NOT due, so
  // it is never processed and never has its status / next_run_at mutated. This
  // pauses it reversibly (re-enabling makes it due again with its schedule
  // intact) — unlike skipping it AFTER selection, which would route a one-shot
  // trigger through recordTaskRun and permanently complete it. The column is
  // NOT NULL DEFAULT 1, so legacy/absent rows count as enabled.
  return db.prepare(
    `SELECT * FROM triggers
     WHERE next_run_at IS NOT NULL
       AND next_run_at <= ?
       AND enabled != 0
       AND status != 'completed'
       AND (status != 'failed' OR schedule_cron IS NOT NULL)
     ORDER BY next_run_at ASC`
  ).all(now) as TriggerRecord[];
}

/**
 * Triggers that ACTIVELY reference a saved workflow — the destructive-edit guard
 * (Slice C, §4.6 U5). "Active" = enabled (not paused via the kill-switch) and
 * not a completed one-shot. A non-empty result means editing the workflow's
 * steps changes what an already-scheduled / still-pending run will do, so the
 * edit tool requires explicit confirmation. Disabled (`enabled=0`) and
 * `completed` rows are excluded — they cannot fire, so they don't make the
 * workflow "scheduled" for the purpose of the warning.
 */
export function getTriggersByPipelineId(db: Database.Database, pipelineId: string): TriggerRecord[] {
  return db.prepare(
    `SELECT * FROM triggers WHERE pipeline_id = ? AND enabled != 0 AND status != 'completed' ORDER BY created_at DESC`
  ).all(pipelineId) as TriggerRecord[];
}

/** Update a trigger after a run execution. */
export function updateTriggerRunResult(
  db: Database.Database,
  id: string,
  update: {
    lastRunAt: string;
    lastRunResult: string;
    lastRunStatus: string;
    // `undefined` leaves next_run_at unchanged; `null` clears it
    // (used when a one-shot trigger reaches a terminal state — without
    // this, getDueTriggers would keep re-selecting the failed trigger).
    nextRunAt?: string | null | undefined;
    retryCount?: number | undefined;
  },
): void {
  const sets: string[] = [
    'last_run_at = ?',
    'last_run_result = ?',
    'last_run_status = ?',
  ];
  const values: unknown[] = [
    update.lastRunAt,
    update.lastRunResult,
    update.lastRunStatus,
  ];
  if (update.nextRunAt !== undefined) {
    sets.push('next_run_at = ?');
    values.push(update.nextRunAt);
  }
  if (update.retryCount !== undefined) {
    sets.push('retry_count = ?');
    values.push(update.retryCount);
  }
  sets.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE triggers SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** Update the watch_config JSON for a watch trigger (e.g. to store last_hash). */
export function updateTriggerWatchConfig(db: Database.Database, id: string, watchConfig: string): void {
  db.prepare(
    "UPDATE triggers SET watch_config = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(watchConfig, id);
}

// ============================================================
// Processes
// ============================================================

export function insertProcess(db: Database.Database, record: ProcessRecord): void {
  db.prepare(`
    INSERT INTO processes (id, name, description, source_run_id, steps_json, parameters_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.name,
    record.description,
    record.sourceRunId,
    JSON.stringify(record.steps),
    JSON.stringify(record.parameters),
    record.createdAt,
  );
}

export function getProcess(db: Database.Database, id: string): ProcessRecord | undefined {
  type Row = { id: string; name: string; description: string; source_run_id: string; steps_json: string; parameters_json: string; promoted_to_pipeline_id: string | null; created_at: string };
  // Direct match first, then prefix match
  let row = db.prepare('SELECT * FROM processes WHERE id = ?').get(id) as Row | undefined;
  if (!row) {
    row = db.prepare('SELECT * FROM processes WHERE id LIKE ? LIMIT 1').get(`${id}%`) as Row | undefined;
  }
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceRunId: row.source_run_id,
    steps: JSON.parse(row.steps_json) as ProcessStep[],
    parameters: JSON.parse(row.parameters_json) as ProcessParameter[],
    createdAt: row.created_at,
    promotedToPipelineId: row.promoted_to_pipeline_id ?? undefined,
  };
}

export function listProcesses(db: Database.Database, limit = 20): ProcessRecord[] {
  type Row = { id: string; name: string; description: string; source_run_id: string; steps_json: string; parameters_json: string; promoted_to_pipeline_id: string | null; created_at: string };
  const rows = db.prepare('SELECT * FROM processes ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    description: row.description,
    sourceRunId: row.source_run_id,
    steps: JSON.parse(row.steps_json) as ProcessStep[],
    parameters: JSON.parse(row.parameters_json) as ProcessParameter[],
    createdAt: row.created_at,
    promotedToPipelineId: row.promoted_to_pipeline_id ?? undefined,
  }));
}

export function updateProcessPromotion(db: Database.Database, id: string, pipelineId: string): void {
  db.prepare('UPDATE processes SET promoted_to_pipeline_id = ? WHERE id = ?').run(pipelineId, id);
}

export function deleteProcess(db: Database.Database, id: string): boolean {
  const result = db.prepare('DELETE FROM processes WHERE id = ?').run(id);
  return result.changes > 0;
}
