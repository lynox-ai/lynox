import type { ManifestStep } from './types.js';

export interface ExecutionPhase {
  phaseIndex: number;
  stepIds: string[];
}

export interface GraphAnalysis {
  phases: ExecutionPhase[];
  stepOrder: string[];
}

export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' → ')}`);
    this.name = 'CycleError';
  }
}

/**
 * Build an adjacency map from `input_from` references.
 * Key = step ID, value = set of step IDs it depends on.
 */
export function buildDependencyGraph(steps: ManifestStep[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const step of steps) {
    adj.set(step.id, new Set(step.input_from ?? []));
  }
  return adj;
}

/**
 * DFS three-color cycle detection.
 * Returns the cycle path if found, null otherwise.
 */
export function detectCycle(adjacency: Map<string, Set<string>>): string[] | null {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const id of adjacency.keys()) {
    color.set(id, WHITE);
  }

  for (const start of adjacency.keys()) {
    if (color.get(start) !== WHITE) continue;

    const stack: string[] = [start];
    parent.set(start, null);

    while (stack.length > 0) {
      const node = stack[stack.length - 1]!;

      if (color.get(node) === WHITE) {
        color.set(node, GRAY);
        const deps = adjacency.get(node) ?? new Set();
        for (const dep of deps) {
          if (!adjacency.has(dep)) continue; // orphan ref, skip (validated elsewhere)
          if (color.get(dep) === GRAY) {
            // Found cycle — reconstruct path
            const cycle = [dep, node];
            let cur = node;
            while (cur !== dep) {
              const p = parent.get(cur);
              if (p === null || p === undefined) break;
              cycle.push(p);
              cur = p;
            }
            cycle.reverse();
            return cycle;
          }
          if (color.get(dep) === WHITE) {
            parent.set(dep, node);
            stack.push(dep);
          }
        }
      } else {
        color.set(node, BLACK);
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Compute parallel execution phases using Kahn's algorithm.
 * Phase 0 = steps with no dependencies, etc.
 */
export function computePhases(steps: ManifestStep[] | undefined): GraphAnalysis {
  // A persisted-then-replayed pipeline manifest can land here with no agents
  // (DB JSON stripped/legacy/empty), and `steps.map` would NPE deep in the
  // worker loop. Empty graph is the only sensible answer for empty input.
  if (!steps || steps.length === 0) {
    return { phases: [], stepOrder: [] };
  }
  const ids = new Set(steps.map(s => s.id));
  const adj = buildDependencyGraph(steps);

  // Compute in-degree (only count deps that are actual step IDs)
  const inDegree = new Map<string, number>();
  for (const step of steps) {
    let deg = 0;
    for (const dep of step.input_from ?? []) {
      if (ids.has(dep)) deg++;
    }
    inDegree.set(step.id, deg);
  }

  const phases: ExecutionPhase[] = [];
  const stepOrder: string[] = [];
  const remaining = new Set(ids);

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) === 0) {
        ready.push(id);
      }
    }

    if (ready.length === 0) {
      // All remaining nodes have deps → cycle
      const subAdj = new Map<string, Set<string>>();
      for (const id of remaining) {
        const deps = adj.get(id) ?? new Set();
        subAdj.set(id, new Set([...deps].filter(d => remaining.has(d))));
      }
      const cycle = detectCycle(subAdj);
      throw new CycleError(cycle ?? [...remaining]);
    }

    // Sort for deterministic ordering
    ready.sort();
    phases.push({ phaseIndex: phases.length, stepIds: ready });
    stepOrder.push(...ready);

    // Remove ready nodes, decrement in-degrees
    for (const id of ready) {
      remaining.delete(id);
    }
    for (const id of remaining) {
      const deps = adj.get(id) ?? new Set();
      for (const r of ready) {
        if (deps.has(r)) {
          inDegree.set(id, (inDegree.get(id) ?? 1) - 1);
        }
      }
    }
  }

  return { phases, stepOrder };
}

/**
 * Validate graph structure for v1.1 manifests:
 * duplicate IDs, self-loops, orphan refs, cycles.
 */
export function validateGraph(steps: ManifestStep[]): void {
  // Duplicate IDs
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) {
      throw new Error(`Duplicate step ID: "${step.id}"`);
    }
    ids.add(step.id);
  }

  // Self-loops
  for (const step of steps) {
    if (step.input_from?.includes(step.id)) {
      throw new Error(`Self-loop: step "${step.id}" references itself in input_from`);
    }
  }

  // Orphan refs
  for (const step of steps) {
    for (const dep of step.input_from ?? []) {
      if (!ids.has(dep)) {
        throw new Error(`Orphan reference: step "${step.id}" references unknown step "${dep}"`);
      }
    }
  }

  // Cycles
  const adj = buildDependencyGraph(steps);
  const cycle = detectCycle(adj);
  if (cycle !== null) {
    throw new CycleError(cycle);
  }
}
