import type { ToolEntry, MCPServer, ToolScopeConfig } from '../types/index.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>();
  private readonly servers: MCPServer[] = [];
  private _version = 0;

  /** Incremented on every tool change — sessions compare this to detect stale tools. */
  get version(): number { return this._version; }

  register<T>(entry: ToolEntry<T>): this {
    this.tools.set(entry.definition.name, entry as ToolEntry);
    this._version++;
    return this;
  }

  registerMCP(server: MCPServer): this {
    this.servers.push(server);
    return this;
  }

  getEntries(): ToolEntry[] {
    return [...this.tools.values()];
  }

  getMCPServers(): MCPServer[] {
    return [...this.servers];
  }

  find(name: string): ToolEntry | undefined {
    return this.tools.get(name);
  }

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
