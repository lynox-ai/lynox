/**
 * Zod schemas for JSON-serializable config types.
 * Used for runtime validation of user-facing config files and role JSON.
 */
import { z } from 'zod';

// === Shared enums ===

const ModelTierSchema = z.enum(['opus', 'sonnet', 'haiku']);
const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'max']);
const AutonomyLevelSchema = z.enum(['supervised', 'guided', 'autonomous']);
const MemoryScopeTypeSchema = z.enum(['global', 'context', 'user']);

const ThinkingModeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('enabled'), budget_tokens: z.number() }),
  z.object({ type: z.literal('adaptive') }),
  z.object({ type: z.literal('disabled') }),
]);

const MemoryScopeRefSchema = z.object({
  type: MemoryScopeTypeSchema,
  id: z.string(),
});

// === Role ===

export const RoleSchema = z.object({
  id:          z.string().min(1),
  name:        z.string().min(1),
  description: z.string().min(1),
  version:     z.string().min(1),

  // Capability
  systemPrompt:  z.string().min(1),
  allowedTools:  z.array(z.string()).optional(),
  deniedTools:   z.array(z.string()).optional(),
  outputFormat:  z.enum(['text', 'json', 'markdown']).optional(),
  memoryScope:   MemoryScopeRefSchema.optional(),

  // Autonomy
  autonomy: AutonomyLevelSchema.optional(),

  // Tuning
  model:         ModelTierSchema.optional(),
  thinking:      ThinkingModeSchema.optional(),
  effort:        EffortLevelSchema.optional(),
  maxIterations: z.number().optional(),
  maxBudgetUsd:  z.number().optional(),

  // Meta
  extends: z.string().optional(),
  tags:    z.array(z.string()).optional(),
  source:  z.enum(['builtin', 'user', 'project']).optional(),
});

// === Playbook ===

export const PlaybookParameterSchema = z.object({
  name:         z.string().min(1),
  description:  z.string().min(1),
  type:         z.enum(['string', 'number', 'date', 'boolean']),
  required:     z.boolean(),
  defaultValue: z.unknown().optional(),
});

export const PlaybookPhaseSchema = z.object({
  name:            z.string().min(1),
  description:     z.string().min(1),
  recommendedRole: z.string().optional(),
  verification:    z.string().optional(),
  dependsOn:       z.array(z.string()).optional(),
});

export const PlaybookSchema = z.object({
  id:             z.string().min(1),
  name:           z.string().min(1),
  description:    z.string().min(1),
  version:        z.string().min(1),
  phases:         z.array(PlaybookPhaseSchema).min(1),
  parameters:     z.array(PlaybookParameterSchema).optional(),
  applicableWhen: z.string().optional(),
  extends:        z.string().optional(),
  tags:           z.array(z.string()).optional(),
  source:         z.enum(['builtin', 'user', 'project']).optional(),
});

// === LynoxUserConfig ===

export const LynoxUserConfigSchema = z.object({
  api_key:              z.string().optional(),
  api_base_url:         z.string().optional(),
  default_tier:         ModelTierSchema.optional(),
  thinking_mode:        z.enum(['adaptive', 'disabled']).optional(),
  effort_level:         EffortLevelSchema.optional(),
  max_session_cost_usd: z.number().optional(),
  voyage_api_key:       z.string().optional(),
  embedding_provider:   z.enum(['voyage', 'onnx', 'local']).optional(),
  plugins:              z.record(z.string(), z.boolean()).optional(),
  agents_dir:           z.string().optional(),
  manifests_dir:        z.string().optional(),
  workspace_dir:        z.string().optional(),
  user_id:              z.string().optional(),
  organization_id:      z.string().optional(),
  client_id:            z.string().optional(),
  changeset_review:     z.boolean().optional(),
  memory_auto_scope:    z.boolean().optional(),
  greeting:             z.boolean().optional(),
  telegram_bot_token:       z.string().optional(),
  telegram_allowed_chat_ids: z.array(z.number()).optional(),
  search_api_key:       z.string().optional(),
  search_provider:      z.enum(['tavily', 'brave']).optional(),
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
}).passthrough(); // allow unknown keys for forward compat
