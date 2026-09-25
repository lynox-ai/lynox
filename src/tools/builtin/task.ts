import type { ToolEntry, IAgent, TaskPriority, TaskStatus, TriggerStatus, MemoryScopeRef } from '../../types/index.js';
import { parseScopeString } from '../../core/scope-resolver.js';
import { detectInjectionAttempt } from '../../core/data-boundary.js';
import { logErrorChain } from '../../core/utils.js';

// TaskManager accessed via agent.toolContext.taskManager

interface TaskCreateInput {
  title: string;
  description?: string | undefined;
  priority?: TaskPriority | undefined;
  assignee?: string | undefined;
  due_date?: string | undefined;
  run_at?: string | undefined;
  scope?: string | undefined;
  tags?: string[] | undefined;
  parent_task_id?: string | undefined;
  schedule?: string | undefined;
  watch_url?: string | undefined;
  watch_interval_minutes?: number | undefined;
  workflow_id?: string | undefined;
  params?: Record<string, unknown> | undefined;
}

interface TaskUpdateInput {
  task_id: string;
  status?: string | undefined;
  priority?: string | undefined;
  assignee?: string | undefined;
  due_date?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  run_at?: string | undefined;
  schedule?: string | undefined;
}

interface TaskListInput {
  scope?: string | undefined;
  status?: string | undefined;
  assignee?: string | undefined;
  due?: 'today' | 'week' | 'overdue' | undefined;
  limit?: number | undefined;
}

/** How much of a failed run's stored reason is rendered in the listing. */
const FAILURE_REASON_CHARS = 300;

/** How much of the stored parameter set is rendered. Shorter than the reason:
 *  it is a pointer to what was configured, not the configuration itself. */
const PARAMS_CHARS = 200;

/** Flattened wherever a stored value is rendered inside a one-per-line listing:
 *  a line break in it would invent a row, and the value comes from a provider. */
const UNSAFE_IN_LINE = /[\x00-\x1f\x7f\u0085\u2028\u2029]/g;

/** What separates the fields of the detail line. Named because the reason has to
 *  be stripped of it — a value that can contain the separator can invent a field. */
const FIELD_SEPARATOR = ' · ';

/** Flatten anything that could end a line or forge a field. */
const clean = (v: string): string => v.replace(UNSAFE_IN_LINE, ' ');

/** Cut at a CODEPOINT boundary. `slice` counts UTF-16 units, so a provider whose
 *  error text puts an emoji across the limit leaves a lone surrogate in the
 *  model's context — the offset is chosen by the far end, not by us. */
const cut = (v: string, max: number): string => {
  const points = [...v];
  return points.length <= max ? v : `${points.slice(0, max).join('')}…`;
};

/**
 * The second line a scheduled trigger gets when the listing alone would mislead.
 *
 * WHY IT EXISTS. `status` said `open` for a schedule that had been switched off
 * in July and for one whose last run died at the provider, and said the same
 * thing for a healthy one. The record carries the difference — `enabled`,
 * `last_run_status`, `last_run_result`, `pipeline_id` all ride on
 * {@link TriggerRecord} and reached `listTriggers` — and this function dropped
 * every one of them. Measured on a real instance (2026-09-24): three schedules
 * in `failed`, three unrelated causes, all three stored, none reachable. Asked
 * to repair them, the model wrote that it could not reconstruct the
 * configuration and replaced all three with invented ones.
 *
 * Returns '' when there is nothing to add, so an ordinary TODO and a healthy
 * schedule render exactly as before.
 */
export function triggerDetailLine(t: {
  enabled?: number | undefined;
  last_run_status?: string | undefined;
  last_run_result?: string | undefined;
  last_run_at?: string | undefined;
  pipeline_id?: string | undefined;
  pipeline_params?: string | undefined;
  effect?: string | undefined;
}): string {
  const parts: string[] = [];
  // `enabled` is a 0/1 column and ABSENT means enabled — the column defaults to
  // 1, so `=== 0` is the test, not falsiness. A todo has no such field at all.
  if (t.enabled === 0) parts.push('SCHEDULE OFF — it will not fire');
  // NOT a whitelist of failure words. The writer stores 'success', 'failed' and
  // 'timeout' (task-manager: "preserves the actual outcome ('failed' vs
  // 'timeout')"), and an earlier draft here checked for 'failed' or 'error' —
  // a word nothing writes — while missing 'timeout', a word something does. A
  // whitelist also fails in the wrong DIRECTION: a status added later would
  // render as healthy. Anything recorded that is not success is a run the
  // reader needs to see; absent means never run, which is not a failure.
  const failed = t.last_run_status !== undefined && t.last_run_status !== 'success';
  if (failed) {
    const when = t.last_run_at ? ` (${clean(t.last_run_at).slice(0, 16)})` : '';
    // The FIELD SEPARATOR is neutralised inside the reason, not only line
    // breaks. `parts.join(' · ')` means a reason carrying ` · workflow X` reads
    // as another field — two workflow attributions on one line, at the moment
    // the reader is deciding which workflow a repair must preserve. It costs a
    // middle dot in a provider's prose and removes the ambiguity entirely.
    const raw = clean(t.last_run_result ?? '').split(FIELD_SEPARATOR).join(' - ').trim();
    const reason = raw.length === 0 ? 'no reason was stored' : cut(raw, FAILURE_REASON_CHARS);
    parts.push(`last run FAILED${when}: ${reason}`);
  }
  // The WORKFLOW ID IS NOT THE FIELD TO LEAN ON, and an earlier revision of
  // this comment claimed the opposite — "the thing a repair has to preserve".
  // `target_workflow_id` is `REFERENCES workflows(id) ON DELETE SET NULL`, so
  // deleting the workflow NULLS it: in the one cause that names a missing
  // workflow, the id is already gone by the time anyone reads the row. Measured
  // on a real instance — the schedule that reported "target workflow no longer
  // exists" had an empty id, and I first read that as "it never had one".
  //
  // `params_json` has no foreign key and SURVIVES. It is the stored
  // configuration — the thing that was actually lost when a repair rewrote
  // three schedules from scratch — so it is rendered too, and its absence is
  // reported rather than inferred: an empty id beside stored params is a fact
  // the reader can act on, not a conclusion this line should draw.
  //
  // Both are cleaned like every other rendered field. Neither is reachable with
  // a line break today, but each is safe because of an invariant enforced two
  // modules away for a different reason and written down nowhere near here.
  if (t.pipeline_id) parts.push(`workflow ${clean(t.pipeline_id)}`);
  // A schedule whose EFFECT is to run a workflow and which has none is broken
  // as a matter of its own record, not by inference: the WorkerLoop dispatches
  // on `effect`, so this one dispatches to a workflow that is not there.
  //
  // Keyed on the effect and NOT on stored params, which was the first attempt
  // and would have missed the real case. Checked against the instance that
  // started this: of its three failing schedules, exactly the one reporting
  // "target workflow no longer exists" has effect=run_workflow with an empty
  // id — its params are `{}`. The other two are effect=run_agent and need no
  // workflow at all, so a params-keyed test would have said nothing about the
  // broken one and something about the healthy ones.
  else if (t.effect === 'run_workflow') parts.push('NO WORKFLOW LINKED — it dispatches to one and has none');
  if (t.pipeline_params) parts.push(`params ${cut(clean(t.pipeline_params), PARAMS_CHARS)}`);
  return parts.length === 0 ? '' : `\n    ↳ ${parts.join(FIELD_SEPARATOR)}`;
}

// Accepts both a TODO (TaskRecord: has priority + due_date) and an agent-trigger
// (TriggerRecord: neither) since v42 split them — priority/due_date are optional
// so a trigger renders without them.
function formatTaskLine(
  t: { id: string; title: string; status: string; assignee: string | null; scope_type: string; scope_id: string; priority?: string | undefined; due_date?: string | null | undefined; enabled?: number | undefined; last_run_status?: string | undefined; last_run_result?: string | undefined; last_run_at?: string | undefined; pipeline_id?: string | undefined; pipeline_params?: string | undefined; effect?: string | undefined },
  // Callers used to append their own suffix to the RESULT of this function.
  // That was harmless while the result was one line; with a detail line it put
  // "— next run: …" underneath "workflow <id>", where it reads as a property of
  // the workflow. The suffix belongs on the head line, so it is passed in
  // rather than concatenated on.
  suffix = '',
): string {
  const scope = t.scope_type === 'context' && !t.scope_id ? '' : ` (${t.scope_type}:${t.scope_id})`;
  const due = t.due_date ? ` — due ${t.due_date}` : '';
  const assign = t.assignee ? ` @${t.assignee}` : '';
  const prio = t.priority ? `[${t.priority.toUpperCase()}] ` : '';
  return `${prio}${t.id} ${t.title}${assign}${scope}${due} [${t.status}]${suffix}${triggerDetailLine(t)}`;
}

// Catches an LLM output failure mode where the model emits an escaped close-quote
// mid-string, causing the intended next JSON keys to land inside `description`
// (or `title`) as literal text (e.g. `...strategy.","schedule":"0 2 * * 4"`).
// Strict schema validation can't catch this — the JSON parses fine, the string
// just contains garbage.
//
// Pattern: close-quote + comma + open-quote + known task_create key + close-quote
// + colon + value-start. Value-start covers strings (`"`), arrays (`[`),
// numbers (`0-9`), and booleans (`t`/`f`) — `tags` smuggles as `","tags":[...]`
// so the value-side has to be permissive. Specific enough on the key-side to
// keep false positives away from legitimate prose. JSON keys are always
// double-quoted in real payloads, so the single-quote branch was dead weight.
const EMBEDDED_TASK_PARAMS_PATTERN =
  /"\s*,\s*"(schedule|priority|assignee|due_date|parent_task_id|watch_url|watch_interval_minutes|workflow_id|scope|tags|title)"\s*:\s*["[\dtf]/i;

function detectEmbeddedParams(field: string, value: string | undefined): string | null {
  if (!value) return null;
  const match = value.match(EMBEDDED_TASK_PARAMS_PATTERN);
  if (!match) return null;
  const paramName = match[1];
  return `Error: ${field} contains what looks like escaped JSON fragments of other task_create parameters (matched: "${paramName}"). These must be passed as separate top-level parameters, not embedded inside ${field}. Retry the call with schedule, priority, assignee, tags, etc. as their own fields.`;
}

/**
 * The sentence a reported row owes the reader when the scheduler will NOT run it
 * yet.
 *
 * Drawn over the BEHAVIOUR, not over the branch: `getDue` holds back every
 * `run_agent` row with no `confirmed_at`, with no carve-out for how it was made
 * (`trigger-store.ts`). Each branch used to speak for itself — one said
 * "watching <url> every 60min", others reported a next run — and each was wrong
 * the same way for the same reason. One predicate, appended wherever a row is
 * reported, is the only shape that cannot drift apart again: a branch that
 * forgets it says nothing extra, and a row that is not held back gets no
 * sentence it does not deserve. A workflow trigger is NOT held back by this gate
 * (its consent sits on the workflow), and an edit that changes what a trigger
 * runs clears the stamp, so the update path needs it too.
 */
function pendingConsent(task: object): string {
  // Takes the union both creators return (a TODO has neither field) and reads
  // the two fields the gate reads. Narrowed here rather than cast per call site:
  // a caller that has to shape its argument is a caller that can shape it wrong.
  const row = task as { effect?: unknown; confirmed_at?: unknown };
  return row.effect === 'run_agent' && !row.confirmed_at
    ? ' — it runs once you confirm it in Triggers.'
    : '';
}

export const taskCreateTool: ToolEntry<TaskCreateInput> = {
  definition: {
    name: 'task_create',
    description: 'Create a task for a concrete deliverable with a deadline or assignee. Not for general notes (use memory_store with status namespace). Only create tasks when the user requests it or a clear action item emerges.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority level. Default: medium' },
        assignee: { type: 'string', description: 'Who is responsible: "user" (the human), "lynox" (the agent), or a custom name. Default: unassigned.' },
        due_date: { type: 'string', description: 'Soft deadline (YYYY-MM-DD). Does NOT trigger execution. For one-shot future execution use run_at.' },
        run_at: { type: 'string', description: 'ISO 8601 datetime for one-shot future execution, ALWAYS in UTC with a `Z` suffix (e.g. "2026-04-25T07:00:00Z" for 9am Europe/Zurich in summer). The user phrases requests in their LOCAL clock ("tomorrow 9am", "in 2 hours") — convert to UTC by adding the offset shown in the `[Now: …; user local …]` marker before writing. Without run_at, lynox-assignee tasks fire immediately. Mutually exclusive with schedule.' },
        scope: { type: 'string', description: 'Scope as "type:id" (e.g., "client:acme"). Default: current project scope.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
        parent_task_id: { type: 'string', description: 'Parent task ID for subtasks' },
        schedule: { type: 'string', description: 'Cron schedule for recurring tasks. Standard cron (e.g. \'0 8 * * *\' for daily at 8am) or shorthand (\'30m\', \'1h\', \'6h\', \'1d\'). For a one-shot future task use run_at instead.' },
        watch_url: { type: 'string', description: 'URL to monitor for changes. Creates a watch task that checks periodically.' },
        watch_interval_minutes: { type: 'number', minimum: 5, description: 'How often to check the watched URL (in minutes). Default: 60. Minimum: 5.' },
        workflow_id: { type: 'string', description: 'ID of a stored workflow to execute on this schedule.' },
        params: { type: 'object', description: 'Values for the workflow\'s {{params.<name>}} placeholders, re-targeting THIS firing (needs workflow_id).' },
      },
      required: ['title'],
    },
  },
  handler: async (input: TaskCreateInput, agent: IAgent): Promise<string> => {
    const managerRef = agent.toolContext.taskManager;
    if (!managerRef) return 'Error: Task manager not available.';

    const embeddedErr = detectEmbeddedParams('description', input.description)
      ?? detectEmbeddedParams('title', input.title);
    if (embeddedErr) return embeddedErr;

    // `params` only reaches a workflow run. Silently dropping it would look like
    // a successful batch schedule that in fact re-targets nothing.
    if (input.params !== undefined && !input.workflow_id) {
      return 'Error: `params` re-targets a stored workflow and only applies together with `workflow_id`. Pass the workflow to run, or drop `params`.';
    }

    // Injection defense-in-depth (triggers-consent / SEC leg): an agent that
    // ingested poisoned content (mail / web / doc) could be steered into SCHEDULING
    // a trigger whose instruction IS the attack, which then runs autonomously under
    // the weaker background guard. The consent gate stops it from RUNNING unattended
    // (agent-created run_agent triggers land unconfirmed); this additionally refuses
    // to CREATE a *firing* trigger whose title/description carries injection markers,
    // so a poisoned schedule never lands (and never presents a tempting "confirm" to
    // the human). Scoped to firing triggers (schedule / watch / run_at / lynox
    // auto-trigger) — a plain user-TODO fires nothing, so it isn't gated (no FP on a
    // legit "mail X to a@b.com" reminder). The human HTTP create route is NOT scanned
    // (the human is the trusted author + the confirmer).
    //
    // `workflow_id` joins the list because a pipeline task FIRES: createPipelineTask
    // forces `assignee: 'lynox'` internally, and a lynox-assignee task with no
    // run_at fires immediately — so a caller who passed neither assignee nor
    // schedule slipped past this scan while creating a firing trigger. Pre-existing;
    // surfaced by adding `params`, which is the payload that makes it worth having.
    const willFire = Boolean(input.schedule) || Boolean(input.watch_url)
      || Boolean(input.run_at) || input.assignee === 'lynox' || Boolean(input.workflow_id);
    if (willFire) {
      // `params` is scanned with the rest: its values are interpolated into the
      // step tasks of a workflow that then runs UNATTENDED, so it is the same
      // channel the title/description scan exists to close — an agent that
      // ingested poisoned content must not be able to steer a confirmed workflow
      // through its re-target values. The patterns are instruction- and
      // marker-shaped (the exfil one needs a URL verb clause, the mail one an
      // `@`), so an ordinary batch range or API base URL matches nothing.
      const scan = detectInjectionAttempt(
        `${input.title}\n${input.description ?? ''}\n${input.params !== undefined ? JSON.stringify(input.params) : ''}`,
      );
      if (scan.detected) {
        return `Error: refused to schedule this trigger — its title/description/params matched prompt-injection patterns (${scan.patterns.join(', ')}). A scheduled agent action runs unattended, so it cannot carry instruction-like or exfiltration-like content. If this is legitimate, set it up from the Triggers page (a human-confirmed schedule) or rephrase without embedded instructions/addresses.`;
      }
    }

    let scopeType = 'context';
    let scopeId = '';
    if (input.scope) {
      const parsed = parseScopeString(input.scope);
      if (!parsed) return `Invalid scope: "${input.scope}". Format: "type:name" (e.g., "client:acme", "project:website").`;
      if (agent.activeScopes) {
        const valid = agent.activeScopes.some(s => s.type === parsed.type && s.id === parsed.id);
        if (!valid) return `Unauthorized scope: "${input.scope}".`;
      }
      scopeType = parsed.type;
      scopeId = parsed.id;
    } else if (agent.activeScopes) {
      const projectScope = agent.activeScopes.find(s => s.type === 'context');
      if (projectScope) scopeId = projectScope.id;
    }

    try {
      const baseParams = {
        title: input.title,
        description: input.description,
        priority: input.priority,
        assignee: input.assignee,
        scopeType,
        scopeId,
        dueDate: input.due_date,
        tags: input.tags,
        parentTaskId: input.parent_task_id,
      };

      if (input.workflow_id) {
        // The tool param is `workflow_id`; the TaskManager + DB column remain
        // `pipelineId` / `tasks.pipeline_id` (no migration — see PRD §6.6).
        // Re-target values for THIS firing. The column, the TaskManager field and
        // the WorkerLoop read (`task.pipeline_params` → bindWorkflowParameters)
        // all existed already; only the agent-facing surface did not, so an agent
        // could schedule "run workflow X" but never "run workflow X for batch 3"
        // — which is the whole shape of a batched bulk job.
        //
        // Serialised here rather than in the manager because the storage contract
        // is a JSON string.
        //
        // An EMPTY object needs no special case: the trigger store already
        // round-trips '{}' back to `undefined` on read (trigger-store.ts), which is
        // what the WorkerLoop money-path guard `if (task.pipeline_params)` reads. A
        // guard here for that case survived its own mutation test — it changed
        // nothing — so it is not written.
        const pipelineParams = input.params !== undefined ? JSON.stringify(input.params) : undefined;
        const task = managerRef.createPipelineTask({
          ...baseParams,
          pipelineId: input.workflow_id,
          scheduleCron: input.schedule,
          ...(pipelineParams !== undefined ? { pipelineParams } : {}),
        });
        const nextRun = task.next_run_at ? ` — next run: ${task.next_run_at}` : '';
        const scheduleInfo = input.schedule ? ` (schedule: ${input.schedule})` : '';
        return `Workflow task created: ${formatTaskLine(task, `${nextRun}${scheduleInfo}${pendingConsent(task)}`)}`;
      }

      if (input.schedule) {
        const task = managerRef.createScheduled({
          ...baseParams,
          scheduleCron: input.schedule,
        });
        const nextRun = task.next_run_at ? ` — next run: ${task.next_run_at}` : '';
        return `Scheduled task created: ${formatTaskLine(task, `${nextRun}${pendingConsent(task)}`)}`;
      }

      if (input.watch_url) {
        // Floor the interval at 5 min: the JSON-schema `minimum` is only advisory
        // for an LLM-supplied arg, so clamp defensively to bound fetch + LLM spend.
        const intervalMinutes = Math.max(5, input.watch_interval_minutes ?? 60);
        const task = managerRef.createWatch({
          ...baseParams,
          watchUrl: input.watch_url,
          watchIntervalMinutes: intervalMinutes,
        });
        return `Watch task created: ${formatTaskLine(task, ` — it checks ${input.watch_url} every ${String(intervalMinutes)}min${pendingConsent(task)}`)}`;
      }

      if (input.run_at) {
        if (Number.isNaN(Date.parse(input.run_at))) {
          return `Error: invalid run_at "${input.run_at}". Use ISO 8601 datetime (e.g. "2026-04-25T09:00:00").`;
        }
        const task = managerRef.create({ ...baseParams, nextRunAt: input.run_at });
        return `Task scheduled for ${input.run_at}: ${formatTaskLine(task, pendingConsent(task))}`;
      }

      const task = managerRef.create(baseParams);
      return `Task created: ${formatTaskLine(task, pendingConsent(task))}`;
    } catch (e: unknown) {
      logErrorChain('task_create', e);
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

export const taskUpdateTool: ToolEntry<TaskUpdateInput> = {
  definition: {
    name: 'task_update',
    description: 'Update task fields including its execution schedule. Use `run_at` to reschedule a one-shot task ("move it to tomorrow 9am") or `schedule` to switch a recurring cadence — preferred over delete-and-recreate.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        task_id: { type: 'string', description: 'Task ID (or prefix)' },
        status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'failed'], description: 'New status. `failed` is a terminal state set by the worker for one-shot tasks whose execution permanently errored (no retries remaining); humans normally use `completed`.' },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'New priority' },
        assignee: { type: 'string', description: 'New assignee: "user", "lynox", custom name, or empty string to clear' },
        due_date: { type: 'string', description: 'New due date (YYYY-MM-DD), or empty string to clear' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tags (replaces existing)' },
        run_at: { type: 'string', description: 'Reschedule a one-shot task to a new ISO 8601 datetime, ALWAYS in UTC with a `Z` suffix (e.g. "2026-04-25T07:00:00Z"). User phrasings like "verschiebe auf 9am" / "in 10 minuten" reference the user\'s LOCAL clock — convert via the `[Now: …; user local …]` marker before writing. Empty string un-schedules (keeps task open). Mutually exclusive with `schedule`.' },
        schedule: { type: 'string', description: 'Reschedule a recurring task to a new cron (\'0 8 * * *\') or shorthand (\'30m\', \'1h\', \'1d\'). Empty string clears recurrence. Mutually exclusive with `run_at`. Recomputes the next run automatically.' },
      },
      required: ['task_id'],
    },
  },
  handler: async (input: TaskUpdateInput, agent): Promise<string> => {
    const managerRef = agent.toolContext.taskManager;
    if (!managerRef) return 'Error: Task manager not available.';

    // Scope guard. The persistence layer's getTask resolves via
    // `id = ? OR id LIKE ?`, so a sub-agent in one scope could otherwise
    // mutate a task in another scope just by guessing a short prefix.
    // The scopeFilter is threaded into the SAME SQL WHERE used by the
    // UPDATE (see run-history-persistence.ts), so check and mutation
    // commit atomically — no TOCTOU window between resolve and write.
    // Single-user installs leave activeScopes undefined and skip entirely.
    const scopeFilter = agent.activeScopes && agent.activeScopes.length > 0
      ? agent.activeScopes
      : undefined;

    try {
      if (input.status === 'completed') {
        const task = managerRef.complete(input.task_id, scopeFilter);
        if (!task) return `Task not found: ${input.task_id}`;
        return `Task completed: ${formatTaskLine(task)}`;
      }

      const task = managerRef.update(input.task_id, {
        title: input.title,
        description: input.description,
        status: input.status as TaskStatus | undefined,
        priority: input.priority as 'low' | 'medium' | 'high' | 'urgent' | undefined,
        assignee: input.assignee,
        dueDate: input.due_date,
        tags: input.tags,
        nextRunAt: input.run_at,
        scheduleCron: input.schedule,
      }, scopeFilter);
      if (!task) return `Task not found: ${input.task_id}`;
      // Surface the new schedule when it changed so the agent can confirm
      // the reschedule landed (mirrors the create path's "scheduled for …"
      // string, which the LLM is already trained to read back).
      // Only a trigger (TriggerRecord) carries a schedule — narrow via `in`
      // since the v42 split removed these columns from the TODO (TaskRecord).
      const scheduleNote = 'next_run_at' in task && task.next_run_at
        ? ` — next run: ${task.next_run_at}`
        : 'schedule_cron' in task && task.schedule_cron
          ? ` — schedule: ${task.schedule_cron}`
          : '';
      // An edit can re-open consent: changing what a trigger RUNS clears the stamp
      // (`trigger-store.ts`), so the row just edited may be held back again — and
      // this report is the only place that says so.
      return `Task updated: ${formatTaskLine(task, `${scheduleNote}${pendingConsent(task)}`)}`;
    } catch (e: unknown) {
      logErrorChain('task_update', e);
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

export const taskListTool: ToolEntry<TaskListInput> = {
  definition: {
    name: 'task_list',
    description: 'List tasks filtered by scope, status, assignee, or due date.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        scope: { type: 'string', description: 'Filter by scope ("client:acme"). Omit for all active scopes.' },
        // `waiting` is READABLE but not SETTABLE, and the split is deliberate.
        // A parked trigger renders as `[waiting]` in the lines below, so without
        // it here the model can see a state it cannot ask for — the one shape a
        // filter enum must never have. `task_update`'s enum (above) does NOT get
        // it: parking is the engine's to do, and `TaskManager.update` rejects the
        // value outright.
        status: { type: 'string', enum: ['open', 'in_progress', 'completed', 'failed', 'waiting'], description: 'Filter by status. `waiting` = a trigger paused on an unanswered question.' },
        assignee: { type: 'string', description: 'Filter by assignee: "user", "lynox", or custom name' },
        due: { type: 'string', enum: ['today', 'week', 'overdue'], description: 'Filter by due date range' },
        limit: { type: 'number', description: 'Max results. Default: 20' },
      },
      required: [],
    },
  },
  handler: async (input: TaskListInput, agent: IAgent): Promise<string> => {
    const managerRef = agent.toolContext.taskManager;
    if (!managerRef) return 'Error: Task manager not available.';

    if (input.due) {
      const scopes = agent.activeScopes;
      if (input.due === 'overdue') {
        // Use the history directly for overdue
        const overdue = managerRef.getWeekSummary(scopes).overdue;
        if (overdue.length === 0) return 'No overdue tasks.';
        return overdue.map(t => formatTaskLine(t)).join('\n');
      }
      if (input.due === 'today') {
        const summary = managerRef.getWeekSummary(scopes);
        const tasks = [...summary.overdue, ...summary.dueToday];
        if (tasks.length === 0) return 'No tasks due today (and none overdue).';
        return tasks.map(t => formatTaskLine(t)).join('\n');
      }
      if (input.due === 'week') {
        const summary = managerRef.getWeekSummary(scopes);
        const tasks = [...summary.overdue, ...summary.dueToday, ...summary.dueThisWeek];
        if (tasks.length === 0) return 'No tasks due this week.';
        return tasks.map(t => formatTaskLine(t)).join('\n');
      }
    }

    let scope: MemoryScopeRef | undefined;
    if (input.scope) {
      const parsed = parseScopeString(input.scope);
      if (!parsed) return `Invalid scope format: "${input.scope}".`;
      scope = parsed;
    }

    // v42 split user-TODOs (`tasks`) and agent-triggers (`triggers`) into two
    // tables. task_list shows the agent's FULL picture — its own scheduled
    // triggers plus the user-TODOs. An explicit assignee filter narrows:
    // triggers are all 'lynox', so a non-lynox assignee filter drops them.
    // No user-TODO is ever parked — `waiting` lives on the trigger type only
    // (§0 E1a). Filtering for it must therefore return NO todos, which is not the
    // same as passing the value down: `list` types its filter `TaskStatus`, and
    // casting a non-member through it would be a lie that happens to work.
    const todos = input.status === 'waiting'
      ? []
      : managerRef.list({
        status: input.status as TaskStatus | undefined,
        assignee: input.assignee,
        scope,
      });
    const triggers = input.assignee === undefined || input.assignee === 'lynox'
      ? managerRef.listTriggers({ status: input.status as TriggerStatus | undefined, scope })
      : [];
    // Triggers FIRST: the agent's active scheduled work is fewer rows and more
    // relevant to surface. Appending them after the todos would let an install
    // with ≥20 TODOs truncate every trigger off the default-20 slice below;
    // putting them first guarantees they're never starved by the limit. Any
    // overflowing TODOs are still accounted for by the "... and N more" line.
    const tasks = [...triggers, ...todos];

    const limited = tasks.slice(0, input.limit ?? 20);
    if (limited.length === 0) return 'No tasks found.';

    const lines = limited.map(t => formatTaskLine(t));
    if (tasks.length > limited.length) {
      lines.push(`... and ${tasks.length - limited.length} more`);
    }
    return lines.join('\n');
  },
};
