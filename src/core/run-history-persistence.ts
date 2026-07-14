import type Database from 'better-sqlite3';
import type { TaskRecord } from '../types/index.js';
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
  // 2a: no `completed_at` stamp at INSERT — the row is born 'running' with a
  // NULL completed_at and is closed out by `updatePipelineRun` at finalize.
  // (Pre-2a this INSERT was the run-END write, so it stamped completed_at; the
  // orchestrator is now the single canonical writer via start-INSERT + finalize.)
  db.prepare(`
    INSERT INTO pipeline_runs (id, manifest_name, status, manifest_json, total_duration_ms, total_cost_usd, total_tokens_in, total_tokens_out, step_count, parent_run_id, error, workflow_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  totalTokensIn?: number | undefined;
  totalTokensOut?: number | undefined;
  stepCount?: number | undefined;
  error?: string | undefined;
}): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (params.status !== undefined) { sets.push('status = ?'); values.push(params.status); }
  if (params.totalDurationMs !== undefined) { sets.push('total_duration_ms = ?'); values.push(params.totalDurationMs); }
  if (params.totalCostUsd !== undefined) { sets.push('total_cost_usd = ?'); values.push(params.totalCostUsd); }
  // 2a/B2: the finalize path records step_count + token totals (the run-END
  // INSERT used to carry these; they'd stay 0 otherwise since the start-INSERT
  // writes the row before any step has run).
  if (params.totalTokensIn !== undefined) { sets.push('total_tokens_in = ?'); values.push(params.totalTokensIn); }
  if (params.totalTokensOut !== undefined) { sets.push('total_tokens_out = ?'); values.push(params.totalTokensOut); }
  if (params.stepCount !== undefined) { sets.push('step_count = ?'); values.push(params.stepCount); }
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

// ============================================================
// Tasks (USER-TODOs — `tasks` table). Workflow DEFINITIONS + agent TRIGGERS moved
// to the engine.db verb-graph (WorkflowStore/TriggerStore) in the S3f write-cutover;
// their legacy `pipeline_runs status='planned'/'executed'` rows + `triggers` table
// are dropped in mig v44, so only the task persistence remains here. Tasks stay
// legacy-authoritative + mirrored until the S4 subject resolution.
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

/**
 * UNBOUNDED full-scan of every USER-TODO (`tasks`) row — the S3d backfill source.
 * NO `LIMIT` (the clamped {@link getTasks} default-100 would undercount). Ordered
 * `created_at ASC` so a PARENT task is upserted before its children whenever the
 * parent was created first (the common case) — the backfill's pass-2 re-link then
 * only has to fix genuinely out-of-order parent/child pairs.
 */
export function getAllTasks(db: Database.Database): TaskRecord[] {
  return db.prepare('SELECT * FROM tasks ORDER BY created_at ASC').all() as TaskRecord[];
}

/**
 * The RAW legacy history.db `triggers` row (v42 schema — carries the pre-#850
 * `task_type`, NOT the split source/effect axes). Read-only migration shape used
 * ONLY by the verb-graph backfill; the derivation of source/effect from `task_type`
 * lives in the backfill (via `deriveSourceEffect`) so the persistence layer keeps no
 * cross-module dependency.
 */
export interface LegacyTriggerRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  scope_type: string | null;
  scope_id: string | null;
  created_at: string;
  updated_at: string;
  schedule_cron: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_result: string | null;
  last_run_status: string | null;
  task_type: string | null;
  watch_config: string | null;
  max_retries: number | null;
  retry_count: number | null;
  notification_channel: string | null;
  pipeline_id: string | null;
  pipeline_params: string | null;
  enabled: number | null;
}

/**
 * UNBOUNDED read of every legacy `triggers` row — the verb-graph backfill's trigger
 * source. Tolerates the table being ABSENT (a minimal-seed / fresh-v2 DB that never
 * created it, or a future release that finally drops it): returns `[]` rather than
 * throwing, so the backfill is a clean no-op on such a tenant. Ordered `created_at
 * ASC` for a stable, reproducible backfill.
 */
export function getLegacyTriggerRows(db: Database.Database): LegacyTriggerRow[] {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='triggers'")
    .get();
  if (!exists) return [];
  return db.prepare('SELECT * FROM triggers ORDER BY created_at ASC').all() as LegacyTriggerRow[];
}

/**
 * UNBOUNDED read of every legacy saved-workflow definition (`pipeline_runs` rows
 * with `status='planned'`) — the verb-graph backfill's workflow source. Tolerates
 * `pipeline_runs` being absent (returns `[]`). Ordered `started_at DESC` (matches
 * the pre-S3f library-list order).
 */
export function getAllPlannedPipelines(db: Database.Database): Array<{
  id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
}> {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pipeline_runs'")
    .get();
  if (!exists) return [];
  return db.prepare(
    "SELECT id, manifest_name, manifest_json, step_count, started_at FROM pipeline_runs WHERE status = 'planned' ORDER BY started_at DESC"
  ).all() as Array<{
    id: string; manifest_name: string; manifest_json: string; step_count: number; started_at: string;
  }>;
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
