import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Playbook, PlaybookSource } from '../types/index.js';
import { writeFileAtomicSync } from './atomic-write.js';
import { PlaybookSchema } from '../types/schemas.js';

// === Types ===

export type { PlaybookSource } from '../types/index.js';

export interface PlaybookListEntry {
  id: string;
  source: PlaybookSource;
  description: string;
  phaseCount: number;
  applicableWhen?: string | undefined;
  tags?: string[] | undefined;
}

// === Validation ===

const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validatePlaybookName(name: string): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid playbook name "${name}" — only letters, numbers, hyphens, underscores allowed`);
  }
}

export function parsePlaybookConfig(raw: unknown): Playbook | null {
  const result = PlaybookSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data as Playbook;
}

// === Built-in Playbooks (5) ===

// === Arc 1: Discover — "What don't I know yet?" ===

const RESEARCH: Playbook = {
  id: 'research',
  name: 'Research',
  description: 'Exploratory research — go deep on a topic, discover what you don\'t know, and synthesize findings',
  version: '1.0.0',
  applicableWhen: 'User wants to research a topic, learn about something, explore an area, do a deep-dive, or understand something they don\'t know yet',
  phases: [
    {
      name: 'Define research questions',
      description: 'Clarify what needs to be understood. What are the key questions? What would a complete answer look like? What is already known vs. unknown?',
      recommendedRole: 'collector',
      verification: 'Clear research questions with scope boundaries',
    },
    {
      name: 'Explore broadly',
      description: 'Cast a wide net across all available sources: web research, documents, data, APIs, knowledge base. Follow leads, cross-reference, note surprises. Document everything with sources.',
      recommendedRole: 'researcher',
      dependsOn: ['Define research questions'],
      verification: 'Broad coverage from multiple source types with citations',
    },
    {
      name: 'Analyze and connect',
      description: 'Structure the raw findings. Identify patterns, contradictions, and gaps. Connect dots across sources. Distinguish verified facts from inferences.',
      recommendedRole: 'analyst',
      dependsOn: ['Explore broadly'],
      verification: 'Structured analysis with patterns and gaps identified',
    },
    {
      name: 'Synthesize insights',
      description: 'Distill everything into a clear, audience-appropriate synthesis. Lead with key insights, then supporting evidence. Flag open questions and areas needing further investigation.',
      recommendedRole: 'creator',
      dependsOn: ['Analyze and connect'],
      verification: 'Complete synthesis with key insights, evidence, and open questions',
    },
  ],
  parameters: [
    { name: 'topic', description: 'What to research', type: 'string', required: true },
    { name: 'depth', description: 'How deep to go (e.g., overview, thorough, exhaustive)', type: 'string', required: false, defaultValue: 'thorough' },
  ],
  tags: ['research', 'discovery', 'universal'],
};

// === Arc 2: Evaluate — "Which option is best?" ===

// === Arc 2: Evaluate — "Which option is best?" ===

const EVALUATION: Playbook = {
  id: 'evaluation',
  name: 'Evaluation',
  description: 'Structured decision-making — research options, evaluate trade-offs, and recommend',
  version: '1.0.0',
  applicableWhen: 'User needs to make a decision, compare options, evaluate alternatives, choose a tool, select a vendor, or weigh trade-offs',
  phases: [
    {
      name: 'Clarify the decision',
      description: 'Define what needs to be decided, what the constraints are (budget, timeline, team, technical), and what success looks like. Identify who is affected.',
      recommendedRole: 'collector',
      verification: 'Decision question clearly stated with constraints and success criteria',
    },
    {
      name: 'Research options',
      description: 'Identify all viable options. For each option, gather key facts: capabilities, costs, limitations, requirements, and any dependencies.',
      recommendedRole: 'researcher',
      dependsOn: ['Clarify the decision'],
      verification: 'At least 3 options documented with factual details',
    },
    {
      name: 'Evaluate trade-offs',
      description: 'Compare options against the defined criteria. Build a comparison matrix. Identify trade-offs — what you gain and lose with each option.',
      recommendedRole: 'analyst',
      dependsOn: ['Research options'],
      verification: 'Comparison matrix with clear trade-offs per option',
    },
    {
      name: 'Recommend',
      description: 'Based on the evaluation, provide a clear recommendation with reasoning. Include risks, mitigation strategies, and next steps for implementation.',
      recommendedRole: 'strategist',
      dependsOn: ['Evaluate trade-offs'],
      verification: 'Clear recommendation with reasoning and next steps',
    },
  ],
  parameters: [
    { name: 'decision_topic', description: 'What needs to be decided', type: 'string', required: true },
    { name: 'constraints', description: 'Key constraints (budget, timeline, etc.)', type: 'string', required: false },
  ],
  tags: ['decision', 'evaluation', 'universal'],
};

// === Arc 4: Synthesize — "What do these information mean?" ===

const SYNTHESIS: Playbook = {
  id: 'synthesis',
  name: 'Synthesis',
  description: 'Structured synthesis — collect data, analyze, and present findings',
  version: '1.0.0',
  applicableWhen: 'User needs a report, summary, briefing, status update, quarterly review, or data-driven overview of a topic',
  phases: [
    {
      name: 'Define scope and audience',
      description: 'Clarify what the report covers, who will read it, what format they expect, and what questions it should answer.',
      recommendedRole: 'collector',
      verification: 'Report scope, audience, and key questions defined',
    },
    {
      name: 'Gather data',
      description: 'Collect all relevant data from available sources: files, knowledge, data stores, APIs, web research. Document sources.',
      recommendedRole: 'researcher',
      dependsOn: ['Define scope and audience'],
      verification: 'Data gathered from all relevant sources with citations',
    },
    {
      name: 'Analyze and interpret',
      description: 'Analyze the collected data. Identify patterns, trends, anomalies, and key takeaways. Quantify findings where possible.',
      recommendedRole: 'analyst',
      dependsOn: ['Gather data'],
      verification: 'Key findings identified with supporting data',
    },
    {
      name: 'Create report',
      description: 'Write the report tailored to the audience. Lead with key findings, then supporting analysis, then detailed data. Include recommendations if appropriate.',
      recommendedRole: 'creator',
      dependsOn: ['Analyze and interpret'],
      verification: 'Complete report with executive summary and structured findings',
    },
  ],
  parameters: [
    { name: 'report_topic', description: 'Subject of the report', type: 'string', required: true },
    { name: 'audience', description: 'Who will read the report (e.g., management, team, client)', type: 'string', required: false },
    { name: 'format', description: 'Report format (e.g., brief, detailed, executive summary)', type: 'string', required: false, defaultValue: 'detailed' },
  ],
  tags: ['reporting', 'analysis', 'universal'],
};

// === Arc 3: Diagnose — "What is broken and why?" ===

const DIAGNOSIS: Playbook = {
  id: 'diagnosis',
  name: 'Diagnosis',
  description: 'Systematic problem-solving — understand the issue, find root causes, and propose solutions',
  version: '1.0.0',
  applicableWhen: 'User has a problem to solve, something is broken, needs troubleshooting, root cause analysis, or wants to understand why something is not working',
  phases: [
    {
      name: 'Understand the problem',
      description: 'Define the problem precisely. What is happening? What should be happening? When did it start? Who is affected? What has been tried already?',
      recommendedRole: 'collector',
      verification: 'Problem statement with symptoms, impact, and timeline',
    },
    {
      name: 'Investigate root causes',
      description: 'Gather evidence: check logs, data, files, configurations. Identify potential causes. Rule out hypotheses systematically.',
      recommendedRole: 'researcher',
      dependsOn: ['Understand the problem'],
      verification: 'Root cause identified or narrowed to 2-3 candidates with evidence',
    },
    {
      name: 'Develop solutions',
      description: 'For each root cause, propose concrete solutions. Evaluate effort, risk, and expected impact. Consider quick fixes vs. permanent fixes.',
      recommendedRole: 'strategist',
      dependsOn: ['Investigate root causes'],
      verification: 'At least 2 solution options with effort/impact assessment',
    },
    {
      name: 'Plan resolution',
      description: 'Create an actionable resolution plan: immediate steps, preventive measures, and verification criteria to confirm the problem is solved.',
      recommendedRole: 'strategist',
      dependsOn: ['Develop solutions'],
      verification: 'Action plan with immediate fix and prevention strategy',
    },
  ],
  parameters: [
    { name: 'problem_description', description: 'What is the problem', type: 'string', required: true },
    { name: 'urgency', description: 'How urgent is this (e.g., blocking, important, nice-to-have)', type: 'string', required: false },
  ],
  tags: ['problem-solving', 'troubleshooting', 'universal'],
};

// === Arc 5: Improve — "What can be better?" ===

const ASSESSMENT: Playbook = {
  id: 'assessment',
  name: 'Assessment',
  description: 'Systematic assessment — evaluate current state, identify gaps, and plan improvements',
  version: '1.0.0',
  applicableWhen: 'User wants to audit, review, assess, improve, or optimize something existing — a process, system, content, performance, or any area that could be better',
  phases: [
    {
      name: 'Assess current state',
      description: 'Document what exists today. Map the current state objectively: what is in place, how it works, what metrics are available, what the baseline performance is.',
      recommendedRole: 'analyst',
      verification: 'Current state documented with baseline metrics',
    },
    {
      name: 'Identify gaps and issues',
      description: 'Compare the current state against best practices, goals, or standards. Identify specific gaps, inefficiencies, risks, and areas underperforming expectations.',
      recommendedRole: 'analyst',
      dependsOn: ['Assess current state'],
      verification: 'Gap analysis with specific issues quantified where possible',
    },
    {
      name: 'Research improvements',
      description: 'For each identified gap, research proven solutions: industry best practices, tools, approaches, or examples from similar contexts.',
      recommendedRole: 'researcher',
      dependsOn: ['Identify gaps and issues'],
      verification: 'Improvement options documented with references',
    },
    {
      name: 'Prioritize and plan',
      description: 'Rank improvements by impact and effort. Create a concrete plan: what to change first, expected outcomes, who needs to act, and how to measure success.',
      recommendedRole: 'strategist',
      dependsOn: ['Research improvements'],
      verification: 'Prioritized improvement plan with expected outcomes and metrics',
    },
  ],
  parameters: [
    { name: 'subject', description: 'What to audit and improve', type: 'string', required: true },
    { name: 'standard', description: 'What standard or goal to measure against', type: 'string', required: false },
  ],
  tags: ['audit', 'improvement', 'universal'],
};

// === Arc 6: Create — "What needs to be built?" ===

const CREATION: Playbook = {
  id: 'creation',
  name: 'Creation',
  description: 'Structured creation — gather requirements, research context, create, and refine',
  version: '1.0.0',
  applicableWhen: 'User needs to create something new: a document, proposal, design brief, campaign, presentation, plan document, or any deliverable that does not exist yet',
  phases: [
    {
      name: 'Gather requirements',
      description: 'Clarify what needs to be created: purpose, audience, format, tone, key messages, constraints, and examples of what good looks like.',
      recommendedRole: 'collector',
      verification: 'Clear brief with purpose, audience, format, and constraints',
    },
    {
      name: 'Research context',
      description: 'Gather supporting material: existing content to build on, reference examples, relevant data, brand guidelines, competitor examples, and domain knowledge.',
      recommendedRole: 'researcher',
      dependsOn: ['Gather requirements'],
      verification: 'Context material collected and organized',
    },
    {
      name: 'Create draft',
      description: 'Produce the first version of the deliverable. Focus on completeness and structure over perfection. Follow the brief and incorporate research findings.',
      recommendedRole: 'creator',
      dependsOn: ['Research context'],
      verification: 'Complete first draft covering all requirements',
    },
    {
      name: 'Review and refine',
      description: 'Critically review the draft against the original requirements. Check for accuracy, consistency, tone, and completeness. Refine until the deliverable meets the brief.',
      recommendedRole: 'analyst',
      dependsOn: ['Create draft'],
      verification: 'Final version reviewed against brief, ready for delivery',
    },
  ],
  parameters: [
    { name: 'deliverable', description: 'What needs to be created', type: 'string', required: true },
    { name: 'audience', description: 'Who is the target audience', type: 'string', required: false },
    { name: 'format', description: 'Desired format or medium', type: 'string', required: false },
  ],
  tags: ['creation', 'content', 'universal'],
};

// === Arc 7: Plan — "How do we get from here to there?" ===

const PLANNING: Playbook = {
  id: 'planning',
  name: 'Planning',
  description: 'Future-oriented planning — analyze the landscape, define strategy, and build a roadmap',
  version: '1.0.0',
  applicableWhen: 'User needs a strategy, plan, roadmap, or needs to figure out how to achieve a goal — quarterly planning, product strategy, go-to-market, growth plan',
  phases: [
    {
      name: 'Understand current position',
      description: 'Assess where things stand today: current capabilities, resources, constraints, recent performance, and relevant context. Gather data from all available sources.',
      recommendedRole: 'researcher',
      verification: 'Current position documented with supporting data',
    },
    {
      name: 'Analyze the landscape',
      description: 'Look at the broader context: trends, opportunities, threats, competitive dynamics, and external factors that could affect the plan.',
      recommendedRole: 'analyst',
      dependsOn: ['Understand current position'],
      verification: 'Landscape analysis with opportunities and threats identified',
    },
    {
      name: 'Define strategy',
      description: 'Based on the current position and landscape, define the strategic direction: goals, priorities, key bets, and what to say no to. Make trade-offs explicit.',
      recommendedRole: 'strategist',
      dependsOn: ['Analyze the landscape'],
      verification: 'Clear strategic direction with explicit priorities and trade-offs',
    },
    {
      name: 'Build roadmap',
      description: 'Translate strategy into a concrete, time-bound plan: milestones, deliverables, responsibilities, dependencies, and success metrics.',
      recommendedRole: 'creator',
      dependsOn: ['Define strategy'],
      verification: 'Actionable roadmap with milestones, owners, and metrics',
    },
  ],
  parameters: [
    { name: 'goal', description: 'What the strategy should achieve', type: 'string', required: true },
    { name: 'timeframe', description: 'Planning horizon (e.g., Q3, next 6 months, 2027)', type: 'string', required: false },
    { name: 'scope', description: 'What area this plan covers', type: 'string', required: false },
  ],
  tags: ['strategy', 'planning', 'universal'],
};

// === Built-in Registry (7 universal arcs) ===

const BUILTIN_PLAYBOOKS: Record<string, Playbook> = {
  'research': RESEARCH,
  'evaluation': EVALUATION,
  'diagnosis': DIAGNOSIS,
  'synthesis': SYNTHESIS,
  'assessment': ASSESSMENT,
  'creation': CREATION,
  'planning': PLANNING,
};

// === Directory Helpers ===

function getProjectPlaybooksDir(): string {
  return join(process.cwd(), '.nodyn', 'playbooks');
}

function getUserPlaybooksDir(): string {
  return join(homedir(), '.nodyn', 'playbooks');
}

// === Extends Resolution ===

function loadPlaybookRaw(id: string): Playbook | null {
  validatePlaybookName(id);

  // 1. Project playbooks
  const projectDir = getProjectPlaybooksDir();
  const projectPath = join(projectDir, `${id}.json`);
  if (existsSync(projectPath)) {
    try {
      const raw = readFileSync(projectPath, 'utf-8');
      const parsed = parsePlaybookConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // Malformed JSON — fall through
    }
  }

  // 2. User playbooks
  const userDir = getUserPlaybooksDir();
  const userPath = join(userDir, `${id}.json`);
  if (existsSync(userPath)) {
    try {
      const raw = readFileSync(userPath, 'utf-8');
      const parsed = parsePlaybookConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // Malformed JSON — fall through
    }
  }

  // 3. Built-in playbooks
  return BUILTIN_PLAYBOOKS[id] ?? null;
}

function resolveInheritanceChain(playbook: Playbook): Playbook[] {
  const chain: Playbook[] = [playbook];
  let current = playbook;
  const maxDepth = 3;
  const seen = new Set<string>([current.id]);

  while (current.extends && chain.length <= maxDepth) {
    if (seen.has(current.extends)) break; // cycle protection
    const parent = loadPlaybookRaw(current.extends);
    if (!parent) break;
    seen.add(parent.id);
    chain.unshift(parent); // parent first
    current = parent;
  }
  return chain;
}

function mergeChain(chain: Playbook[]): Playbook {
  if (chain.length === 1) return chain[0]!;

  const base = { ...chain[0]! };

  for (let i = 1; i < chain.length; i++) {
    const child = chain[i]!;

    // phases: child replaces parent (phases are a coherent sequence)
    base.phases = child.phases;

    // parameters: child replaces parent
    if (child.parameters !== undefined) {
      base.parameters = child.parameters;
    }

    // tags: union
    if (child.tags) {
      const merged = new Set([...(base.tags ?? []), ...child.tags]);
      base.tags = [...merged];
    }

    // applicableWhen: concatenate
    if (child.applicableWhen) {
      base.applicableWhen = base.applicableWhen
        ? base.applicableWhen + '\n' + child.applicableWhen
        : child.applicableWhen;
    }

    // Everything else: child overrides parent (last-write-wins)
    base.id = child.id;
    base.name = child.name;
    base.description = child.description;
    base.version = child.version;
    if (child.source !== undefined) base.source = child.source;
  }

  // Clear extends on resolved result
  delete base.extends;
  return base;
}

// === Public API ===

/**
 * Load a playbook by ID.
 * Resolution order: project `.nodyn/playbooks/` > user `~/.nodyn/playbooks/` > built-in.
 * Resolves extends chain.
 * Returns null if not found.
 */
export function loadPlaybook(id: string): Playbook | null {
  const raw = loadPlaybookRaw(id);
  if (!raw) return null;
  if (!raw.extends) return raw;
  const chain = resolveInheritanceChain(raw);
  return mergeChain(chain);
}

/**
 * List all available playbooks from all sources.
 * Project playbooks override user playbooks which override built-in.
 */
export function listPlaybooks(): PlaybookListEntry[] {
  const seen = new Map<string, PlaybookListEntry>();

  // Built-in (lowest priority — added first, overridden by user/project)
  for (const [id, pb] of Object.entries(BUILTIN_PLAYBOOKS)) {
    seen.set(id, {
      id,
      source: 'builtin',
      description: pb.description,
      phaseCount: pb.phases.length,
      applicableWhen: pb.applicableWhen,
      tags: pb.tags,
    });
  }

  // User playbooks
  const userDir = getUserPlaybooksDir();
  if (existsSync(userDir)) {
    try {
      const files = readdirSync(userDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const id = file.replace(/\.json$/, '');
        try {
          const raw = readFileSync(join(userDir, file), 'utf-8');
          const pb = parsePlaybookConfig(JSON.parse(raw));
          if (pb) {
            seen.set(id, {
              id,
              source: 'user',
              description: pb.description,
              phaseCount: pb.phases.length,
              applicableWhen: pb.applicableWhen,
              tags: pb.tags,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory read failed
    }
  }

  // Project playbooks (highest priority)
  const projectDir = getProjectPlaybooksDir();
  if (existsSync(projectDir)) {
    try {
      const files = readdirSync(projectDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const id = file.replace(/\.json$/, '');
        try {
          const raw = readFileSync(join(projectDir, file), 'utf-8');
          const pb = parsePlaybookConfig(JSON.parse(raw));
          if (pb) {
            seen.set(id, {
              id,
              source: 'project',
              description: pb.description,
              phaseCount: pb.phases.length,
              applicableWhen: pb.applicableWhen,
              tags: pb.tags,
            });
          }
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory read failed
    }
  }

  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get the IDs of all built-in playbooks.
 */
export function getBuiltinPlaybookIds(): string[] {
  return Object.keys(BUILTIN_PLAYBOOKS).sort();
}

/**
 * Save a playbook to the user playbooks directory.
 */
export function savePlaybook(playbook: Playbook): void {
  const parsed = parsePlaybookConfig(playbook);
  if (!parsed) {
    throw new Error('Playbook must have valid id, name, description, version, and at least one phase');
  }
  validatePlaybookName(parsed.id);
  const filePath = join(getUserPlaybooksDir(), `${parsed.id}.json`);
  writeFileAtomicSync(filePath, JSON.stringify(parsed, null, 2) + '\n');
}

/**
 * Export a playbook (built-in or loaded) as JSON string.
 */
export function exportPlaybook(id: string): string | null {
  const playbook = loadPlaybook(id);
  if (!playbook) return null;
  return JSON.stringify(playbook, null, 2);
}

/**
 * Import a playbook from a JSON file path into user playbooks.
 */
export function importPlaybook(filePath: string): Playbook {
  const raw = readFileSync(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid playbook JSON: ${filePath}`);
  }
  const playbook = parsePlaybookConfig(parsed);
  if (!playbook) {
    throw new Error('Playbook must have valid id, name, description, version, and at least one phase');
  }
  validatePlaybookName(playbook.id);
  savePlaybook(playbook);
  return playbook;
}

/**
 * Delete a user playbook by ID. Returns true if deleted, false if not found.
 * Cannot delete built-in playbooks (only user overrides).
 */
export function deletePlaybook(id: string): boolean {
  validatePlaybookName(id);
  const filePath = join(getUserPlaybooksDir(), `${id}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

// === System Prompt Helper ===

const MAX_INDEX_ENTRIES = 15;

/**
 * Generate a compact playbook index for the system prompt.
 * Capped at MAX_INDEX_ENTRIES to control token usage.
 */
export function formatPlaybookIndex(playbooks: PlaybookListEntry[]): string {
  if (playbooks.length === 0) return 'No playbooks available.';

  const entries = playbooks.slice(0, MAX_INDEX_ENTRIES);
  const lines = entries.map(p => {
    const when = p.applicableWhen ? ` Use when: ${p.applicableWhen.split('\n')[0]!.slice(0, 80)}` : '';
    return `- \`${p.id}\`: ${p.description.slice(0, 60)}.${when}`;
  });

  if (playbooks.length > MAX_INDEX_ENTRIES) {
    lines.push(`… and ${playbooks.length - MAX_INDEX_ENTRIES} more (use \`list_playbooks\` or \`/playbooks\` to see all)`);
  }

  return lines.join('\n');
}
