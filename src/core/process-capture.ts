import { randomUUID } from 'node:crypto';
import { getBetasForProvider, getModelId } from '../types/index.js';
import { createLLMClient, getActiveProvider, isBedrockEuOnly, isCustomProvider } from './llm-client.js';
import type { ProcessRecord, ProcessStep, ProcessParameter } from '../types/index.js';
import type { ToolCallRecord } from './run-history.js';

/** Tools that are internal bookkeeping — excluded from process capture */
const INTERNAL_TOOLS = new Set([
  'memory_store', 'memory_recall', 'memory_delete', 'memory_update', 'memory_list', 'memory_promote',
  'ask_user', 'plan_task', 'capture_process', 'promote_process',
]);

const MAX_INPUT_CHARS = 500;
const MAX_OUTPUT_CHARS = 200;

interface CaptureOptions {
  apiKey: string;
  apiBaseURL?: string | undefined;
  description?: string | undefined;
}

/** Sanitize tool call for LLM consumption — strip secrets, truncate */
function sanitizeToolCall(tc: ToolCallRecord): { tool: string; input: string; output: string; order: number } {
  let input = tc.input_json;
  // Strip anything that looks like a secret/key/token
  input = input.replace(/"(api_?key|token|secret|password|authorization)":\s*"[^"]*"/gi, '"$1": "[REDACTED]"');
  if (input.length > MAX_INPUT_CHARS) input = input.slice(0, MAX_INPUT_CHARS) + '...';

  let output = tc.output_json;
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
    model: getModelId('haiku', getActiveProvider(), isBedrockEuOnly()),
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
