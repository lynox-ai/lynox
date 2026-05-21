import { randomUUID } from 'node:crypto';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { createLLMClient, getActiveProvider, isCustomProvider } from './llm-client.js';
import type { ProcessRecord, ProcessStep, ProcessParameter } from '../types/index.js';
import type { ToolCallRecord } from './run-history.js';

/** Tools that are internal bookkeeping — excluded from process capture */
const INTERNAL_TOOLS = new Set([
  'memory_store', 'memory_recall', 'memory_delete', 'memory_update', 'memory_list', 'memory_promote',
  'ask_user', 'plan_task', 'save_workflow',
]);

const MAX_INPUT_CHARS = 500;
const MAX_OUTPUT_CHARS = 200;

// Safety pre-cap applied BEFORE redaction so a pathologically large tool
// output cannot make the regex scan unbounded. Generously sized (50x the
// final output cap) so any secret near the real truncation boundary is still
// well inside the redaction window — redact-then-truncate is preserved.
const MAX_REDACTION_SCAN_CHARS = 10_000;

const REDACTED = '[REDACTED]';

interface CaptureOptions {
  apiKey: string;
  apiBaseURL?: string | undefined;
  description?: string | undefined;
}

/**
 * Value-pattern secret scanners. Key-name redaction alone misses bearer
 * tokens, OAuth refresh tokens, JWTs and provider tokens that arrive as
 * bare values inside tool inputs/outputs. These regexes redact the secret
 * value wherever it appears.
 */
const VALUE_SECRET_PATTERNS: RegExp[] = [
  // Bearer / token auth headers — `Bearer <token>`, `token <token>`.
  /\b(Bearer|token)\s+[A-Za-z0-9\-._~+/]{12,}=*/gi,
  // Slack-style tokens — xoxb-, xoxp-, xapp-, xoxa-, xoxr- …
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/gi,
  // JWT shape — three base64url segments separated by dots.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Common provider key prefixes (Anthropic, OpenAI, GitHub, Stripe, Google).
  /\b(sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|rk_live_|sk_live_|sk_test_|AIza)[A-Za-z0-9\-_]{12,}/g,
];

/**
 * High-entropy bare string detector — catches long random-looking tokens
 * (API keys, session secrets) that carry no recognizable prefix. Applied to
 * whitespace/quote-delimited "words" so ordinary prose is not mangled.
 */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksHighEntropy(token: string): boolean {
  // Long, mixed-charset, and high per-character entropy = likely a secret.
  // 24-char floor is a deliberate gap: shorter secrets (e.g. 16-char keys)
  // are not entropy-redacted — lowering it risks mangling legitimate IDs and
  // hashes in prose. Prefixed/known-shape short secrets are still caught by
  // the value-pattern scan above.
  if (token.length < 24) return false;
  const hasUpper = /[A-Z]/.test(token);
  const hasLower = /[a-z]/.test(token);
  const hasDigit = /[0-9]/.test(token);
  // Require alphanumeric mix; URLs/sentences fail this.
  if (!((hasUpper || hasLower) && hasDigit)) return false;
  // Reject anything with spaces — already split into words upstream.
  return shannonEntropy(token) >= 3.6;
}

/**
 * Redact secrets from a serialized tool-call field. Runs key-name redaction,
 * value-pattern scanning, and high-entropy detection. Must run BEFORE any
 * length truncation so a secret split across the truncation boundary cannot
 * evade detection (redact-then-truncate, see PRD §6.2).
 */
function redactSecrets(text: string): string {
  // Safety pre-cap so the scan stays bounded on huge tool outputs. Far larger
  // than the final truncation cap, so redact-then-truncate still holds.
  const scoped = text.length > MAX_REDACTION_SCAN_CHARS
    ? text.slice(0, MAX_REDACTION_SCAN_CHARS)
    : text;
  // 1. Key-name redaction — `"api_key": "..."` style JSON pairs. The
  //    `[a-z0-9_-]*` prefix catches namespaced keys whose name ENDS in a
  //    sensitive keyword (`db-password`, `csrf_token`, `x_api_key`), not just
  //    the bare keyword. A keyword buried mid-name is intentionally not matched
  //    — a trailing wildcard would redact innocuous fields like `token_count`.
  let redacted = scoped.replace(
    /"([a-z0-9_-]*(?:api_?key|token|secret|password|authorization|access_token|refresh_token|client_secret))":\s*"[^"]*"/gi,
    '"$1": "[REDACTED]"',
  );
  // 1b. URL-embedded credentials — redact the `user:pass@` userinfo.
  redacted = redacted.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/:@]+@/gi,
    '$1[REDACTED]@',
  );
  // 2. Value-pattern scanning — bearer tokens, xox…, JWT, provider prefixes.
  for (const pattern of VALUE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  // 3. High-entropy bare strings — split on quotes/whitespace + `=;&` so a
  //    secret in `cookie=…;k=…` style runs is isolated, then redact each
  //    token that looks like a random secret.
  redacted = redacted.replace(/[^\s"'`,=;&]{24,}/g, match =>
    looksHighEntropy(match) ? REDACTED : match,
  );
  return redacted;
}

/**
 * Sanitize tool call for LLM consumption — redact secrets, then truncate.
 * Ordering is load-bearing: redaction runs on the full string before the
 * length cap so truncation cannot bisect a secret out of detection range.
 */
function sanitizeToolCall(tc: ToolCallRecord): { tool: string; input: string; output: string; order: number } {
  let input = redactSecrets(tc.input_json);
  if (input.length > MAX_INPUT_CHARS) input = input.slice(0, MAX_INPUT_CHARS) + '...';

  let output = redactSecrets(tc.output_json);
  if (output.length > MAX_OUTPUT_CHARS) output = output.slice(0, MAX_OUTPUT_CHARS) + '...';

  return { tool: tc.tool_name, input, output, order: tc.sequence_order };
}

const EXTRACTION_SYSTEM = `You are a process analyst. Given a sequence of tool calls from a completed task, create a reusable process template.

For each meaningful step, provide:
1. A plain-language description of what the step does (for a business user, not a developer)
2. The tool used
3. Which input values are likely to CHANGE between runs (parameters) vs stay the same (constants)
4. Which steps depend on outputs of earlier steps (by step order number)

For parameters, classify each as:
- "user_input": value the user provides each time (e.g., client name, specific query)
- "relative_date": time-based value that should be relative (e.g., "last month" not "March 2026")
- "context": value from the environment or previous step output

Merge consecutive tool calls that serve the same logical purpose into one step.
Skip tool calls that are just reading/exploring without producing useful output.

Return a JSON object with this exact structure:
{
  "steps": [{ "order": 0, "tool": "tool_name", "description": "plain language", "inputTemplate": {}, "dependsOn": [] }],
  "parameters": [{ "name": "param_name", "description": "what this is", "type": "string|number|date", "defaultValue": null, "source": "user_input|relative_date|context" }]
}`;

const EXTRACT_TOOL = {
  name: 'extract_process',
  description: 'Extract a reusable process template from the tool call sequence.',
  input_schema: {
    type: 'object' as const,
    properties: {
      steps: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            order: { type: 'number' as const },
            tool: { type: 'string' as const },
            description: { type: 'string' as const },
            inputTemplate: { type: 'object' as const },
            dependsOn: { type: 'array' as const, items: { type: 'number' as const } },
          },
          required: ['order', 'tool', 'description', 'inputTemplate'],
        },
      },
      parameters: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' as const },
            description: { type: 'string' as const },
            type: { type: 'string' as const, enum: ['string', 'number', 'date'] },
            defaultValue: {},
            source: { type: 'string' as const, enum: ['user_input', 'relative_date', 'context'] },
          },
          required: ['name', 'description', 'type', 'source'],
        },
      },
    },
    required: ['steps', 'parameters'],
  },
};

/**
 * Capture a process from run history tool calls.
 * Uses a lightweight Haiku call to name steps and identify parameters.
 */
export async function captureProcess(
  runId: string,
  name: string,
  toolCalls: ToolCallRecord[],
  options: CaptureOptions,
): Promise<ProcessRecord> {
  // Filter out internal tools
  const actionCalls = toolCalls.filter(tc => !INTERNAL_TOOLS.has(tc.tool_name));

  if (actionCalls.length === 0) {
    return {
      id: randomUUID(),
      name,
      description: options.description ?? '',
      sourceRunId: runId,
      steps: [],
      parameters: [],
      createdAt: new Date().toISOString(),
    };
  }

  // Sanitize for LLM consumption
  const sanitized = actionCalls.map(sanitizeToolCall);

  // Call Haiku for step naming + parameter identification
  const client = createLLMClient({ apiKey: options.apiKey, apiBaseURL: options.apiBaseURL });
  const response = await client.beta.messages.create({
    model: getModelId('haiku', getActiveProvider()),
    max_tokens: 4096,
    ...(isCustomProvider() ? {} : { betas: getBetasForProvider(getActiveProvider()) }),
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Task name: "${name}"\n\nTool call sequence:\n${JSON.stringify(sanitized, null, 2)}`,
      },
    ],
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: 'extract_process' },
  });

  // Extract from tool use response
  let steps: ProcessStep[] = [];
  let parameters: ProcessParameter[] = [];

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'extract_process') {
      const input = block.input as { steps?: unknown[]; parameters?: unknown[] };
      if (Array.isArray(input.steps)) {
        steps = input.steps as ProcessStep[];
      }
      if (Array.isArray(input.parameters)) {
        parameters = input.parameters as ProcessParameter[];
      }
    }
  }

  return {
    id: randomUUID(),
    name,
    description: options.description ?? '',
    sourceRunId: runId,
    steps,
    parameters,
    createdAt: new Date().toISOString(),
  };
}
