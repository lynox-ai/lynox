# DAG Engine

NODYN's DAG engine executes declarative JSON manifest files — graph-based workflows with parallel execution, conditions, context passing, and gate approval. Domain-agnostic: you supply agent definitions, NODYN handles orchestration.

## Quickstart

```typescript
import { runManifest, loadManifestFile, loadConfig } from '@nodyn-ai/core';

const manifest = loadManifestFile('./my.manifest.json');
const state = await runManifest(manifest, loadConfig());

console.log(state.status); // 'completed' | 'failed' | 'rejected'
for (const [stepId, output] of state.outputs) {
  console.log(stepId, output.result, output.costUsd);
}
```

```bash
# CLI
nodyn --manifest ./my.manifest.json
nodyn --manifest ./my.manifest.json  # uses LocalGateAdapter for gate points in TTY
```

---

## Manifest Format

```json
{
  "manifest_version": "1.0",
  "name": "my-pipeline",
  "triggered_by": "ci",
  "context": { "env": "production", "repo": "my-org/my-repo" },
  "agents": [
    {
      "id": "analyze",
      "agent": "code-reviewer",
      "runtime": "agent",
      "model": "sonnet"
    },
    {
      "id": "report",
      "agent": "doc-writer",
      "runtime": "agent",
      "input_from": ["analyze"],
      "conditions": [{ "path": "analyze.result", "operator": "exists" }]
    }
  ],
  "gate_points": ["report"],
  "on_failure": "stop"
}
```

### Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `manifest_version` | `"1.0"` | yes | — | Schema version |
| `name` | `string` | yes | — | Manifest identifier |
| `triggered_by` | `string` | yes | — | Who/what triggered the run |
| `context` | `object` | no | `{}` | Global context available to all steps |
| `agents` | `ManifestStep[]` | yes | — | Ordered list of steps (min 1) |
| `gate_points` | `string[]` | no | `[]` | Step IDs that require approval after execution |
| `on_failure` | `"stop" \| "continue" \| "notify"` | no | `"stop"` | Failure strategy |

### Step fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `string` | yes | Unique step identifier |
| `agent` | `string` | yes | Agent definition name (maps to `agents/{name}/index.js`) or step ID for inline |
| `runtime` | `"agent" \| "mock" \| "inline"` | yes | Execution mode |
| `task` | `string` | inline only | Task description for the inline sub-agent (required when `runtime` is `"inline"`) |
| `model` | `string` | no | Override model tier (e.g. `"sonnet"`) or full model ID |
| `role` | `string` | no | Role ID (e.g. `researcher`, `executor`) — applies the role's model, system prompt, and tool scoping to the step |
| `input_from` | `string[]` | no | Step IDs whose output to inject into context |
| `conditions` | `ManifestCondition[]` | no | AND-conditions — step skipped if any fails |
| `timeout_ms` | `number` | no | Step timeout in milliseconds (default 600,000 ms) |
| `output_schema` | `object` | no | JSON Schema for output validation (currently metadata) |
| `tool_gates` | `string[]` | no | Tool names requiring gate approval before execution |

---

## Agent Definitions

Agent definitions are ES module files at `{agentsDir}/{name}/index.js`. The default `agentsDir` is `./agents` (overridable via config or `options.agentsDir`).

```javascript
// agents/code-reviewer/index.js
export default {
  name: 'code-reviewer',
  version: '1.0.0',
  defaultTier: 'sonnet',
  systemPrompt: 'You are a senior code reviewer. Analyze code for bugs, security issues, and maintainability.',
  tools: [
    {
      name: 'read_pr_diff',
      description: 'Fetch the diff for a pull request',
      input_schema: {
        type: 'object',
        properties: { pr_number: { type: 'number' } },
        required: ['pr_number'],
      },
      execute: async ({ pr_number }) => {
        // your implementation
        return `diff for PR #${pr_number}`;
      },
    },
  ],
};
```

Agent names must match `/^[a-zA-Z0-9_-]+$/`. Path traversal and special characters are rejected.

### `AgentDef` interface

```typescript
interface AgentDef {
  name: string;
  version: string;
  defaultTier: ModelTier;   // 'opus' | 'sonnet' | 'haiku'
  systemPrompt: string;
  tools?: AgentTool[];
}

interface AgentTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}
```

---

## Context & `input_from`

Each step runs with a **step context** built from:
1. Global `context` from the manifest
2. `_manifestName` injected automatically
3. Outputs from `input_from` steps (keyed by step ID)

```json
{
  "id": "report",
  "agent": "doc-writer",
  "input_from": ["analyze"]
}
```

The step context for `report` will contain:
```json
{
  "env": "production",
  "_manifestName": "my-pipeline",
  "analyze": { "result": "...", "costUsd": 0.0042 }
}
```

Skipped steps are **not** injected (missing key). Forward references throw immediately with `"has not run yet"`.

---

## Conditions

Conditions use dot-notation paths into the step context. All conditions must pass (AND semantics). A step with no conditions always runs.

```json
"conditions": [
  { "path": "score", "operator": "gt", "value": 80 },
  { "path": "env", "operator": "eq", "value": "production" },
  { "path": "feature_flag", "operator": "exists" }
]
```

### Operators

| Operator | Description | `value` required |
|----------|-------------|-----------------|
| `gt` | greater than | yes |
| `gte` | greater than or equal | yes |
| `lt` | less than | yes |
| `lte` | less than or equal | yes |
| `eq` | strict equality (`===`) | yes |
| `neq` | strict inequality (`!==`) | yes |
| `contains` | substring match (`String(actual).includes(value)`) | yes |
| `exists` | path is not `undefined` | no |
| `not_exists` | path is `undefined` | no |

Numeric operators coerce via `Number()`. Return `false` if either operand is `NaN`.

### Condition Context

Conditions can reference **any** completed step's output, not just steps listed in `input_from`. The `buildConditionContext()` function merges all non-skipped step outputs into the condition evaluation context, enabling cross-step conditional logic:

```json
{
  "id": "deploy",
  "agent": "deployer",
  "runtime": "inline",
  "task": "Deploy to production",
  "conditions": [{ "path": "analyze.result", "operator": "contains", "value": "safe" }]
}
```

Here `deploy` can check `analyze.result` even without `"input_from": ["analyze"]`.

### Task Templates

Step `task` fields support `{{path.to.value}}` template syntax, resolved before execution using the step context:

```json
{
  "id": "implement",
  "runtime": "inline",
  "task": "Implement the following plan: {{plan.result}}",
  "input_from": ["plan"]
}
```

Template values are JSON-stringified if not strings. Missing paths are left as-is (`{{missing.path}}`).

---

## Gate Points

Gate points pause execution after a step completes and wait for human approval before the run proceeds.

```json
"gate_points": ["analyze", "deploy"]
```

After step `analyze` finishes, the runner calls `gateAdapter.submit()` with step context, then blocks on `gateAdapter.waitForDecision()`.

- `approved` → run continues
- `rejected` → run stops with `status: 'rejected'`
- `timeout` → same as rejected

Gate points apply to **both** mock and real execution paths, making them testable without API calls.

### Gate adapters

**`LocalGateAdapter`** — prompts via a custom function (used for TTY runs):
```typescript
import { LocalGateAdapter } from '@nodyn-ai/core';

const adapter = new LocalGateAdapter(async (question, options) => {
  // show question to user, return answer
  return 'Yes, approve';
});
```

The CLI auto-selects the adapter based on TTY detection.

### `tool_gates`

Tool-level gates wrap individual tool handlers with approval logic — zero changes to `agent.ts`:

```json
{
  "id": "deploy",
  "agent": "deployer",
  "tool_gates": ["run_deployment", "send_alert"]
}
```

Any call to `run_deployment` or `send_alert` during step `deploy` will submit a gate request and block until a decision is received.

---

## Failure Strategy

`on_failure` controls what happens when a step throws an error (excluding gate rejections — those always halt the run):

| Value | Behavior |
|-------|----------|
| `"stop"` | Return immediately with `status: 'failed'` and `error` set |
| `"continue"` | Record the error in the step output, continue to next step |
| `"notify"` | Record error, fire `onStepNotify` hook + `nodyn:dag:notify` channel, continue to next step |

Gate rejections and timeouts always set `status: 'rejected'` regardless of `on_failure`.

---

## Programmatic API

### `runManifest(manifest, config, options?)`

```typescript
import { runManifest, loadManifestFile, validateManifest, loadConfig } from '@nodyn-ai/core';
import type { RunManifestOptions, RunState, RunHooks } from '@nodyn-ai/core';

const hooks: RunHooks = {
  onStepStart: (stepId, agentName) => console.log(`▶ ${stepId} (${agentName})`),
  onStepComplete: (output) => console.log(`✓ ${output.stepId} — $${output.costUsd.toFixed(4)}`),
  onStepSkipped: (stepId, reason) => console.log(`⏭ ${stepId}: ${reason}`),
  onGateSubmit: (stepId, approvalId) => console.log(`⏸ Gate submitted: ${approvalId}`),
  onGateDecision: (stepId, decision) => console.log(`⏵ Gate decision: ${decision.status}`),
  onRunComplete: (state) => console.log(`Run ${state.runId} → ${state.status}`),
  onError: (stepId, error) => console.error(`✗ ${stepId}: ${error.message}`),
};

const options: RunManifestOptions = {
  agentsDir: './my-agents',
  gateAdapter: adapter,
  hooks,
};

const state: RunState = await runManifest(manifest, loadConfig(), options);
```

### `RunManifestOptions`

| Field | Type | Description |
|-------|------|-------------|
| `agentsDir` | `string` | Override agents directory (default: `config.agents_dir ?? ./agents`) |
| `gateAdapter` | `GateAdapter` | Adapter for gate point decisions |
| `hooks` | `RunHooks` | Lifecycle event callbacks |
| `mockResponses` | `Map<string, string>` | Enable mock mode: maps agent name → response string |
| `parentTools` | `ToolEntry[]` | Parent tools inherited by `inline` runtime steps |
| `cachedOutputs` | `Map<string, AgentOutput>` | Pre-populated outputs for retry (skip completed steps) |
| `depth` | `number` | Current nesting depth for workflow composition (max 3) |
| `runHistory` | `RunHistory` | SQLite history for workflow persistence |
| `parentRunId` | `string` | Parent run ID for nested workflow tracking |

### `RunState`

```typescript
interface RunState {
  runId: string;                      // UUID
  manifestName: string;
  startedAt: string;                  // ISO 8601
  completedAt?: string;
  status: 'running' | 'completed' | 'failed' | 'rejected';
  globalContext: Record<string, unknown>;
  outputs: Map<string, AgentOutput>;  // keyed by step ID
  error?: string;                     // set on failure/rejection
}

interface AgentOutput {
  stepId: string;
  result: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  skipped: boolean;
  skipReason?: string;
  error?: string;
}
```

---

## Validation

```typescript
import { validateManifest, loadManifestFile } from '@nodyn-ai/core';

// From object (throws on invalid)
const manifest = validateManifest(rawObject);

// From file
const manifest = loadManifestFile('./path/to/manifest.json');
```

Validation uses Zod v4 with descriptive error messages:
```
Invalid manifest: agents.0.runtime: Invalid enum value. Expected 'agent' | 'mock' | 'inline' | 'pipeline', received 'invalid'
```

---

## CLI Usage

```bash
# Run a manifest
nodyn --manifest ./pipeline.json

# Slash commands in REPL
/manifest run ./pipeline.json        # run with full CLI hooks
/manifest validate ./pipeline.json   # validate schema, print summary
/manifest dry-run ./pipeline.json    # run with mock responses (no API calls)
```

---

## Testing

Use `mockResponses` to test pipelines without API calls:

```typescript
import { runManifest } from '@nodyn-ai/core';

const state = await runManifest(manifest, config, {
  mockResponses: new Map([
    ['code-reviewer', 'Found 2 issues: missing error handling in auth.ts'],
    ['doc-writer', 'Documentation updated'],
  ]),
});

expect(state.status).toBe('completed');
expect(state.outputs.get('analyze')?.result).toContain('missing error handling');
```

When `mockResponses` is provided, all steps use mock execution regardless of their `runtime` setting. Gate points still apply.

---

## Configuration

Add `agents_dir` and `manifests_dir` to your NODYN config:

```json
// .nodyn/config.json (project) or ~/.nodyn/config.json (user)
{
  "agents_dir": "./my-agents",
  "manifests_dir": "./pipelines"
}
```

Both keys are on the `PROJECT_SAFE_KEYS` allowlist — project config can set them without security restrictions.

---

## Manifest v1.1 — Parallel Execution

v1.1 adds dependency graph analysis and parallel step execution. Independent steps run concurrently via `Promise.allSettled`, grouped into execution phases by topological sort. Sequential behavior is opt-in.

### What's new in v1.1

- **`execution` field**: `'parallel'` (default) or `'sequential'`
- **Dependency graph validation**: duplicate IDs, self-loops, orphan refs, and cycles are rejected at validation time
- **Phase-based parallelism**: steps with no unresolved dependencies run in the same phase

### Example

```json
{
  "manifest_version": "1.1",
  "name": "parallel-pipeline",
  "triggered_by": "ci",
  "context": { "repo": "my-org/my-repo" },
  "agents": [
    { "id": "lint", "agent": "linter", "runtime": "agent" },
    { "id": "test", "agent": "tester", "runtime": "agent" },
    { "id": "analyze", "agent": "analyzer", "runtime": "agent" },
    { "id": "report", "agent": "reporter", "runtime": "agent", "input_from": ["lint", "test", "analyze"] }
  ],
  "gate_points": ["report"],
  "on_failure": "stop"
}
```

This produces 2 execution phases:
- **Phase 0**: `lint`, `test`, `analyze` (all run in parallel)
- **Phase 1**: `report` (waits for all three)

### Execution phases

The engine computes phases using Kahn's algorithm:
1. Phase 0 = steps with no dependencies (in-degree 0)
2. Remove phase N nodes, decrement in-degrees → next phase
3. Repeat until all steps are scheduled
4. If any steps remain (cycle) → throw `CycleError`

### Failure handling in parallel

- **`on_failure: 'stop'`**: all steps in the current phase complete, then execution halts before the next phase
- **`on_failure: 'continue'`**: error is recorded, workflow continues to next phase
- **`on_failure: 'notify'`**: error recorded + `onStepNotify` hook + `nodyn:dag:notify` channel, workflow continues
- **Gate rejections**: always halt after the current phase completes

### Migration from v1.0

Change `manifest_version` from `"1.0"` to `"1.1"`. That's it — v1.1 defaults to `execution: 'parallel'` and adds graph validation. To keep sequential behavior, add `"execution": "sequential"`.

v1.0 manifests continue to work unchanged — no graph validation, strict sequential execution.

### Programmatic API

```typescript
import { computePhases, validateGraph, CycleError } from '@nodyn-ai/core';
import type { ExecutionPhase, GraphAnalysis } from '@nodyn-ai/core';

// Analyze dependency graph
const analysis: GraphAnalysis = computePhases(manifest.agents);
for (const phase of analysis.phases) {
  console.log(`Phase ${phase.phaseIndex}: ${phase.stepIds.join(', ')}`);
}

// Validate graph structure (throws on errors)
validateGraph(manifest.agents);
```

---

## Inline Runtime & Workflow Tools

v1.1 adds the `inline` runtime type and the `run_pipeline` tool that lets the agent build and execute DAG workflows dynamically — no manifest files needed.

### Runtime Types

| Runtime | Description |
|---------|-------------|
| `agent` | Loads agent definition from disk (`{agentsDir}/{name}/index.js`) |
| `mock` | Returns preconfigured mock response (for testing) |
| `inline` | Creates agent from `task` field — no disk definition needed. Inherits parent tools. |
| `pipeline` | Nested workflow execution — defines inline sub-steps. Max depth 3. |

Inline steps require a `task` field (validated at parse time):

```json
{
  "id": "analyze",
  "agent": "analyze",
  "runtime": "inline",
  "task": "Read all TypeScript files in src/ and identify potential performance issues",
  "model": "sonnet"
}
```

Inline agents inherit the parent's tools (minus `spawn_agent` and `run_pipeline` to prevent recursion). Default model: `sonnet`.

### `run_pipeline` — Unified Workflow Execution

`run_pipeline` is the single tool for all workflow execution. It supports two modes:

#### Mode 1: Inline Steps

The agent defines workflow steps as JSON and executes them immediately:

```
run_pipeline({
  name: "refactor-pipeline",
  steps: [
    { id: "analyze", task: "Read src/auth.ts and identify code smells" },
    { id: "plan", task: "Create a refactoring plan based on the analysis", input_from: ["analyze"] },
    { id: "implement", task: "Implement the refactoring plan", input_from: ["plan"], model: "opus" },
    { id: "test", task: "Run tests and verify nothing is broken", input_from: ["implement"] }
  ],
  on_failure: "stop"
})
```

- Steps without `input_from` dependencies run in parallel automatically
- Max 20 steps per workflow
- Step results truncated at 50KB (configurable via `pipeline_step_result_limit`)
- Returns structured `PipelineResult` with per-step results, costs, and timing

#### Mode 2: Stored Workflow

Executes a previously planned workflow (e.g. from `plan_task`), with optional modifications and retry:

```
run_pipeline({
  pipeline_id: "abc-123",
  modifications: [
    { step_id: "deploy", action: "remove" },
    { step_id: "test", action: "update_task", value: "Run unit tests only, skip integration" },
    { step_id: "analyze", action: "update_model", value: "haiku" }
  ],
  on_failure: "continue"
})
```

Modification types:
- `remove` — Remove a step (cleans up `input_from` references in other steps)
- `update_task` — Change a step's task description
- `update_model` — Change a step's model tier (`opus`, `sonnet`, `haiku`)

The workflow is re-validated after modifications (graph structure may change). Double execution is prevented — plan a new workflow for re-runs.

#### Step Retry & Partial Re-execution

Execute a stored workflow with `retry: true` to skip completed steps and re-execute only failed ones:

```
run_pipeline({ pipeline_id: "abc-123", retry: true })
```

Completed steps are served from cache, failed/skipped steps are re-executed. The `onStepRetrySkipped` hook fires for each cached step.

### Workflow Composition (`runtime: 'pipeline'`)

A step with `runtime: 'pipeline'` invokes another workflow as its execution:

```
run_pipeline({
  name: "composed-pipeline",
  steps: [
    { id: "data", task: "Fetch data", runtime: "inline" },
    {
      id: "process",
      task: "Process data",
      runtime: "pipeline",
      pipeline: [
        { id: "validate", task: "Validate data format" },
        { id: "transform", task: "Transform data", input_from: ["validate"] }
      ],
      input_from: ["data"]
    },
    { id: "report", task: "Generate report", input_from: ["process"] }
  ]
})
```

The `pipeline` field accepts an array of step objects (inline sub-workflow).

Max nesting depth: 3 (prevents infinite recursion).

### Cost Estimation

`plan_task` and `run_pipeline` include cost estimates in their output. Simple per-step lookup by model tier:

```typescript
import { estimatePipelineCost } from '@nodyn-ai/core';

const estimate = estimatePipelineCost(steps);
// { steps: [{ stepId, model, estimatedCostUsd }], totalCostUsd }
```


### Streaming Progress Events

Workflow execution emits `pipeline_progress` stream events:

```typescript
{ type: 'pipeline_progress', stepId: 'analyze', status: 'started', agent: 'pipeline' }
{ type: 'pipeline_progress', stepId: 'analyze', status: 'completed', durationMs: 1234, agent: 'pipeline' }
```

Statuses: `started`, `completed`, `skipped`, `failed`.

### DAG Visualization

`DagVisualizer` renders live ASCII workflow status in the terminal:

```
Workflow: refactor-auth

Phase 0  [ analyze ✓ ]  [ lint ✓ ]
              |
Phase 1  [ implement ◉ ]
              |
Phase 2  [ test ○ ]
```

Status indicators: `○` pending, `◉` running (blue), `✓` done (green), `✗` failed (red), `⊘` skipped (dim), `↺` cached. In-place TTY update via ANSI escape codes.

### SQLite Workflow Persistence

Workflow runs are persisted to `~/.nodyn/history.db` (v7 migration):
- `pipeline_runs` — run metadata (status, duration, cost, tokens)
- `pipeline_step_results` — per-step results (status, result, error, cost)

Query via `RunHistory` methods: `insertPipelineRun()`, `getRecentPipelineRuns()`, `getPipelineStepResults()`.

### Auto-DAG in Autopilot Mode

In autopilot mode with `--auto-dag`, goals are automatically decomposed into DAG workflows:

```bash
nodyn --mode autopilot --goal "Refactor auth module" --auto-dag --budget 5
```

Flow:
1. `planDAG(goal)` generates workflow steps
2. Approval dialog shown (unless `--skip-dag-approval`)
3. Subtasks registered with GoalTracker
4. Workflow executed, results injected into agent context as `<auto_dag_results>`
5. Agent reviews results and completes remaining work

### When to Use What

| Scenario | Tool |
|----------|------|
| ≤2 independent parallel tasks | `spawn_agent` |
| ≥3 steps with data flow | `run_pipeline` (inline steps) |
| Complex goal, decomposition unclear | `plan_task` → `run_pipeline` (stored workflow) |
| Repeatable, versioned workflow | Manifest file (`/manifest run`) |

### DAG Planner

The planner (`src/core/dag-planner.ts`) uses a single fast-tier API call with forced tool use (`propose_dag`). 15s timeout. Failure-safe — always returns `null` on error, never throws.

`plan_task` auto-generates plans via `planDAG()` when the user provides no phases or steps — the planner decomposes the goal into workflow steps automatically.

```typescript
import { planDAG } from '@nodyn-ai/core';

const plan = await planDAG('Migrate auth to sessions', {
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxSteps: 10,
  projectContext: 'TypeScript + Express.js',
});

if (plan) {
  console.log(plan.steps);     // InlinePipelineStep[] (workflow steps)
  console.log(plan.reasoning); // Decomposition explanation
  console.log(plan.estimatedCost); // USD estimate
}
```

---

## Source

```
src/orchestrator/
├── types.ts            All orchestrator types (Manifest, AgentDef, RunState, GateAdapter, RunHooks, ...)
├── validate.ts         validateManifest() + loadManifestFile() via Zod v4 — v1.0/v1.1 discriminated union
├── graph.ts            buildDependencyGraph(), detectCycle(), computePhases(), validateGraph()
├── conditions.ts       shouldRunStep(), evaluateCondition(), getByPath(), buildConditionContext() — 9 operators
├── context.ts          buildStepContext() — input_from resolution + resolveTaskTemplate() — {{path}} syntax
├── agent-registry.ts   loadAgentDef() — dynamic import with path traversal guard
├── gates.ts            LocalGateAdapter
├── runtime-adapter.ts  convertAgentTools(), wrapWithGate(), spawnViaAgent(), spawnInline(), spawnMock(), spawnPipeline()
└── runner.ts           runManifest() / retryManifest() → runSequential() / runParallel() with shared executeStep()

src/core/
├── dag-planner.ts      planDAG() + estimatePipelineCost() — fast-tier planning + cost estimation
├── run-history.ts              v7 migration: pipeline_runs + pipeline_step_results tables
├── run-history-analytics.ts    9 read-only stats/advisor query functions
└── run-history-persistence.ts  44 domain-specific persistence functions (scopes, embeddings, pipelines, tasks, processes)

src/cli/
└── dag-visualizer.ts   DagVisualizer — ASCII DAG rendering with ANSI colors + in-place TTY update

src/tools/builtin/
└── pipeline.ts         run_pipeline (workflow execution) + streaming + retry + persistence
```
