/**
 * Zod schemas for JSON-serializable config types.
 * Used for runtime validation of user-facing config files and role JSON.
 */
import { z } from 'zod';

// === Shared enums ===

const ModelTierSchema = z.enum(['opus', 'sonnet', 'haiku']);
const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'max']);
// AutonomyLevelSchema and ThinkingModeSchema validated at runtime via type checks, not Zod

// === LynoxUserConfig ===

const LLMProviderSchema = z.enum(['anthropic', 'bedrock', 'vertex', 'custom']);

export const LynoxUserConfigSchema = z.object({
  api_key:              z.string().optional(),
  api_base_url:         z.string().optional(),
  provider:             LLMProviderSchema.optional(),
  aws_region:           z.string().optional(),
  bedrock_eu_only:      z.boolean().optional(),
  gcp_region:           z.string().optional(),
  gcp_project_id:       z.string().optional(),
  default_tier:         ModelTierSchema.optional(),
  thinking_mode:        z.enum(['adaptive', 'disabled']).optional(),
  effort_level:         EffortLevelSchema.optional(),
  max_session_cost_usd: z.number().optional(),
  embedding_provider:   z.enum(['onnx', 'local']).optional(),
  plugins:              z.record(z.string(), z.boolean()).optional(),
  agents_dir:           z.string().optional(),
  manifests_dir:        z.string().optional(),
  workspace_dir:        z.string().optional(),
  user_id:              z.string().optional(),
  display_name:         z.string().optional(),
  organization_id:      z.string().optional(),
  client_id:            z.string().optional(),
  changeset_review:     z.boolean().optional(),
  memory_auto_scope:    z.boolean().optional(),
  greeting:             z.boolean().optional(),
  telegram_bot_token:       z.string().optional(),
  telegram_allowed_chat_ids: z.array(z.number()).optional(),
  search_api_key:       z.string().optional(),
  search_provider:      z.enum(['tavily', 'searxng']).optional(),
  searxng_url:          z.string().url().refine(
    url => url.startsWith('http://') || url.startsWith('https://'),
    { message: 'SearXNG URL must use http:// or https:// scheme' },
  ).optional().or(z.null()),
  google_client_id:     z.string().optional(),
  google_client_secret: z.string().optional(),
  max_daily_cost_usd:   z.number().optional(),
  max_monthly_cost_usd: z.number().optional(),
  max_http_requests_per_hour: z.number().optional(),
  max_http_requests_per_day:  z.number().optional(),
  memory_extraction:    z.boolean().optional(),
  memory_half_life_days:   z.number().optional(),
  pipeline_context_limit:  z.number().min(1_000).max(262_144).optional(),
  pipeline_step_result_limit: z.number().min(1_000).max(1_048_576).optional(),
  memory_extraction_limit: z.number().min(1_000).max(262_144).optional(),
  http_response_limit:     z.number().min(1_000).max(5_242_880).optional(),
  google_oauth_scopes:     z.array(z.string()).optional(),
  enforce_https:           z.boolean().optional(),
  sentry_dsn:              z.string().optional(),
  backup_dir:              z.string().optional(),
  backup_schedule:         z.string().optional(),
  backup_retention_days:   z.number().min(0).max(365).optional(),
  backup_encrypt:          z.boolean().optional(),
  backup_gdrive:           z.boolean().optional(),
  mcp_servers:             z.array(z.object({ name: z.string(), url: z.string() })).optional(),
  mcp_exposed_tools:       z.array(z.string()).optional(),
  experience:              z.enum(['business', 'developer']).optional(),
  max_tool_result_chars:   z.number().min(1_000).max(500_000).optional(),
  knowledge_graph_enabled: z.boolean().optional(),
  embedding_model:         z.enum(['all-minilm-l6-v2', 'multilingual-e5-small', 'bge-m3']).optional(),
}).passthrough(); // allow unknown keys for forward compat
