import type { ToolEntry, IAgent, NodynUserConfig, Playbook, PlaybookPhase, PlaybookParameter } from '../../types/index.js';
import type { RunHistory } from '../../core/run-history.js';
import { listPlaybooks, loadPlaybook, savePlaybook } from '../../core/playbooks.js';
import { getPipeline } from './pipeline.js';
import { getErrorMessage } from '../../core/utils.js';

// Dependencies accessed via agent.toolContext (runHistory, userConfig)

// === Tool-to-role heuristic for extract_playbook ===

const TOOL_TO_ROLE: Record<string, string> = {
  web_research: 'researcher',
  http_request: 'researcher',
  read_file: 'analyst',
  batch_files: 'analyst',
  data_store_query: 'analyst',
  write_file: 'executor',
  bash: 'executor',
  ask_user: 'collector',
  memory_store: 'collector',
  memory_recall: 'researcher',
  google_gmail: 'communicator',
  google_sheets: 'analyst',
  google_drive: 'researcher',
  google_docs: 'creator',
};

function inferRole(task: string): string | undefined {
  // Check if the task text mentions any tool names
  for (const [tool, role] of Object.entries(TOOL_TO_ROLE)) {
    if (task.toLowerCase().includes(tool.replace(/_/g, ' '))) return role;
  }
  // Keyword-based fallback
  if (/research|search|find|explore|investigate/i.test(task)) return 'researcher';
  if (/analy[sz]|compare|assess|evaluate|review/i.test(task)) return 'analyst';
  if (/write|create|build|implement|set up|configure/i.test(task)) return 'executor';
  if (/plan|strateg|recommend|prioriti[sz]/i.test(task)) return 'strategist';
  if (/collect|gather|ask|interview|survey/i.test(task)) return 'collector';
  if (/communicat|message|email|send|draft/i.test(task)) return 'communicator';
  return undefined;
}

// === list_playbooks ===

interface ListInput {
  // No required input
  _?: undefined;
}

export const listPlaybooksTool: ToolEntry<ListInput> = {
  definition: {
    name: 'list_playbooks',
    description: 'Show available playbooks for structured task approaches. Lists all built-in, user, and project playbooks with their descriptions and phases.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  handler: async (_input: ListInput, _agent: IAgent): Promise<string> => {
    const playbooks = listPlaybooks();

    if (playbooks.length === 0) {
      return 'No playbooks available. Create one with `/playbooks create <id>` or use `extract_playbook` after completing a workflow.';
    }

    const lines = playbooks.map(p => {
      const tags = p.tags?.length ? ` [${p.tags.join(', ')}]` : '';
      return `• **${p.id}** (${p.source}, ${p.phaseCount} phases)${tags}\n  ${p.description}`;
    });

    return `**Available Playbooks (${playbooks.length})**\n\n${lines.join('\n\n')}`;
  },
};

// === suggest_playbook ===

interface SuggestInput {
  task_description: string;
}

export const suggestPlaybookTool: ToolEntry<SuggestInput> = {
  definition: {
    name: 'suggest_playbook',
    description: 'Check if there is a proven approach for a type of task. Returns matching playbooks with their phases and parameters so you can propose the approach to the user.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        task_description: {
          type: 'string',
          description: 'What the user wants to accomplish',
        },
      },
      required: ['task_description'],
    },
  },
  handler: async (input: SuggestInput, _agent: IAgent): Promise<string> => {
    const playbooks = listPlaybooks();

    if (playbooks.length === 0) {
      return JSON.stringify({ matches: [], message: 'No playbooks available.' });
    }

    // Return all playbooks with their details — let the LLM do semantic matching
    const details = playbooks.map(p => {
      const full = loadPlaybook(p.id);
      if (!full) return null;
      return {
        id: full.id,
        name: full.name,
        description: full.description,
        applicableWhen: full.applicableWhen,
        phases: full.phases.map(ph => ({
          name: ph.name,
          description: ph.description,
          recommendedRole: ph.recommendedRole,
          verification: ph.verification,
        })),
        parameters: full.parameters?.map(param => ({
          name: param.name,
          description: param.description,
          type: param.type,
          required: param.required,
          defaultValue: param.defaultValue,
        })),
      };
    }).filter(Boolean);

    return JSON.stringify({
      task: input.task_description,
      available_playbooks: details,
      instruction: 'Match the task description against the applicableWhen field and description of each playbook. If a playbook matches, propose it to the user with its phases. Ask for required parameter values before proceeding.',
    });
  },
};

// === extract_playbook ===

interface ExtractInput {
  pipeline_id: string;
  name: string;
  description?: string | undefined;
}

export const extractPlaybookTool: ToolEntry<ExtractInput> = {
  definition: {
    name: 'extract_playbook',
    description: 'Create a reusable playbook from a completed workflow. Extracts the strategic approach (phases, roles, verification) from a pipeline, independent of specific tool calls.',
    eager_input_streaming: true,
    input_schema: {
      type: 'object' as const,
      properties: {
        pipeline_id: {
          type: 'string',
          description: 'ID of the completed pipeline/workflow to extract from',
        },
        name: {
          type: 'string',
          description: 'Name for the new playbook (e.g., "quarterly-report")',
        },
        description: {
          type: 'string',
          description: 'Brief description of what this playbook approach achieves',
        },
      },
      required: ['pipeline_id', 'name'],
    },
  },
  handler: async (input: ExtractInput, agent: IAgent): Promise<string> => {
    try {
      // Look up the pipeline
      const pipeline = getPipeline(input.pipeline_id, agent.toolContext.runHistory);
      if (!pipeline) {
        return JSON.stringify({ error: `Pipeline "${input.pipeline_id}" not found. Use a pipeline_id from a completed workflow.` });
      }

      // Convert pipeline steps to playbook phases
      const phases: PlaybookPhase[] = pipeline.steps.map((step, idx) => {
        const role = step.role ?? inferRole(step.task);
        const prevStep = idx > 0 ? pipeline.steps[idx - 1] : undefined;
        return {
          name: step.id.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()),
          description: step.task,
          recommendedRole: role,
          dependsOn: step.input_from ?? (prevStep ? [prevStep.id.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase())] : undefined),
        };
      });

      // Detect parameters from {{template}} patterns in step tasks
      const paramPattern = /\{\{(\w+)\}\}/g;
      const paramNames = new Set<string>();
      for (const step of pipeline.steps) {
        let match: RegExpExecArray | null;
        while ((match = paramPattern.exec(step.task)) !== null) {
          paramNames.add(match[1]!);
        }
      }

      const parameters: PlaybookParameter[] = [...paramNames].map(name => ({
        name,
        description: `Parameter: ${name}`,
        type: 'string' as const,
        required: true,
      }));

      // Build and save playbook
      const playbookId = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const playbook: Playbook = {
        id: playbookId,
        name: input.name,
        description: input.description ?? pipeline.goal ?? input.name,
        version: '1.0.0',
        phases,
        parameters: parameters.length > 0 ? parameters : undefined,
        tags: ['extracted'],
      };

      savePlaybook(playbook);

      return JSON.stringify({
        playbook_id: playbookId,
        name: input.name,
        phases: phases.length,
        parameters: parameters.length,
        phase_summary: phases.map(p => `${p.name}${p.recommendedRole ? ` (${p.recommendedRole})` : ''}`).join(' → '),
        message: `Playbook "${playbookId}" created with ${phases.length} phases. It will be suggested automatically when similar tasks come up. Edit at ~/.nodyn/playbooks/${playbookId}.json to refine.`,
      });
    } catch (err: unknown) {
      return JSON.stringify({ error: `Failed to extract playbook: ${getErrorMessage(err)}` });
    }
  },
};
