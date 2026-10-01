import type { ToolEntry, ToolScopeConfig } from '../types/index.js';

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

  /**
   * ⚠ A SECOND resolution of the same allow/deny vocabulary, and it stays one on purpose.
   *
   * Routing it through `resolveTools` — the single bounding exit every live grant route uses —
   * was built and then pulled back out of the hardening change, for a reason worth keeping:
   * the two are equivalent in all four shapes (`[]` admits nothing in both, `undefined`
   * filters in neither, same for the denylist), so **no test can tell them apart** and a
   * mutant reverting the routing survives by construction. An unobservable change in a
   * security diff is a liability rather than an improvement — nobody can review what nothing
   * can witness.
   *
   * Deleting it instead is the other honest answer and is NOT available here: `ToolRegistry`
   * is public API (`src/index.ts`, and `package.json` exports `.`), so a method nothing in
   * this repo calls may still have a consumer outside it.
   *
   * What remains is the shape this duplication has: a template for the next route that
   * forgets the bound. Filed as `DEF-registry-scopedview-duplicates-grant-semantics`, where
   * the delete-or-route decision belongs — it needs an answer about external consumers that
   * this repo cannot give.
   */
  scopedView(config: ToolScopeConfig): ToolEntry[] {
    let entries = this.getEntries();
    if (config.allowedTools) {
      const allowed = new Set(config.allowedTools);
      entries = entries.filter(e => allowed.has(e.definition.name));
    }
    if (config.deniedTools) {
      const denied = new Set(config.deniedTools);
      entries = entries.filter(e => !denied.has(e.definition.name));
    }
    return entries;
  }
}
