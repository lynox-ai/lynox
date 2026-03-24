// === Pipeline Run Records ===

export interface PipelineRunRecord {
  id: string;
  manifest_name: string;
  status: string;
  manifest_json: string;
  total_duration_ms: number;
  total_cost_usd: number;
  total_tokens_in: number;
  total_tokens_out: number;
  step_count: number;
  parent_run_id: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface PipelineStepRecord {
  id: number;
  pipeline_run_id: string;
  step_id: string;
  status: string;
  result: string;
  error: string | null;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}
