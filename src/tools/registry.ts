import type { ToolEntry, ToolScopeConfig } from '../types/index.js';
import { resolveTools } from './resolve-tools.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private _version = 0;

  /** Incremented on every tool change — sessions compare this to detect stale tools. */
  get version(): number { return this._version; }

  register<T>(entry: ToolEntry<T>): this {
    this.tools.set(entry.definition.name, entry as ToolEntry);
    this._version++;
    return this;
  }

  getEntries(): ToolEntry[] {
    return [...this.tools.values()];
  }

  find(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

  scopedView(config: ToolScopeConfig): ToolEntry[] {
    // Routed through `resolveTools` rather than resolving here a second time. An allow/deny
    // pair becoming a tool list is one operation, and it has one home that bounds at a single
    // exit; a copy of the vocabulary beside it is a template for the next route that forgets
    // the bound — which is the whole reason to route a method nobody calls.
    //
    // Faithful in all four shapes, checked one by one: `allowedTools: []` admits nothing in
    // both (an empty array is truthy, so each takes its filter branch), `undefined` filters
    // nothing in both, and the same for `deniedTools`. The profile literal carries no
    // `allowedTools` key, so no ceiling is added. ⚠ "No caller sees a different answer" would
    // be true and empty: there is no production caller at all. The equivalence is asserted
    // against the TESTS, not against a user.
    return resolveTools(config.allowedTools, { deniedTools: config.deniedTools }, this.getEntries());
  }
}
