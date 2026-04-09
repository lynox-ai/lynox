import { describe, it, expect } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { ToolEntry, MCPServer, ToolScopeConfig } from '../types/index.js';

function makeTool(name: string): ToolEntry {
  return {
    definition: {
      name,
      type: 'custom' as const,
      input_schema: { type: 'object' as const, properties: {} },
    },
    handler: async () => 'ok',
  };
}

describe('ToolRegistry', () => {
  describe('register / find', () => {
    it('registers and finds a tool', () => {
      const reg = new ToolRegistry();
      const tool = makeTool('bash');
      reg.register(tool);
      expect(reg.find('bash')).toBe(tool);
    });

    it('returns undefined for unknown tool', () => {
      const reg = new ToolRegistry();
      expect(reg.find('nonexistent')).toBeUndefined();
    });

    it('supports fluent chaining', () => {
      const reg = new ToolRegistry();
      const result = reg.register(makeTool('a')).register(makeTool('b'));
      expect(result).toBe(reg);
      expect(reg.find('a')).toBeDefined();
      expect(reg.find('b')).toBeDefined();
    });

    it('overwrites tool with same name', () => {
      const reg = new ToolRegistry();
      const tool1 = makeTool('bash');
      const tool2 = makeTool('bash');
      reg.register(tool1).register(tool2);
      expect(reg.find('bash')).toBe(tool2);
    });
  });

  describe('getEntries', () => {
    it('returns copy of entries', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('a')).register(makeTool('b'));
      const entries = reg.getEntries();
      expect(entries).toHaveLength(2);
      // Mutating the returned array should not affect registry
      entries.pop();
      expect(reg.getEntries()).toHaveLength(2);
    });

    it('returns empty array initially', () => {
      const reg = new ToolRegistry();
      expect(reg.getEntries()).toEqual([]);
    });
  });

  describe('MCP servers', () => {
    it('registers and returns MCP servers', () => {
      const reg = new ToolRegistry();
      const server: MCPServer = { type: 'url', url: 'http://localhost:3000', name: 'test' };
      reg.registerMCP(server);
      const servers = reg.getMCPServers();
      expect(servers).toHaveLength(1);
      expect(servers[0]).toEqual(server);
    });

    it('supports fluent chaining for MCP', () => {
      const reg = new ToolRegistry();
      const result = reg.registerMCP({ type: 'url', url: 'http://a', name: 'a' });
      expect(result).toBe(reg);
    });

    it('returns copy of servers array', () => {
      const reg = new ToolRegistry();
      reg.registerMCP({ type: 'url', url: 'http://a', name: 'a' });
      const servers = reg.getMCPServers();
      servers.pop();
      expect(reg.getMCPServers()).toHaveLength(1);
    });

    it('returns empty array initially', () => {
      const reg = new ToolRegistry();
      expect(reg.getMCPServers()).toEqual([]);
    });
  });

  describe('scopedView', () => {
    it('filters by allowedTools whitelist', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('bash')).register(makeTool('read_file')).register(makeTool('write_file'));
      const result = reg.scopedView({ allowedTools: ['bash', 'read_file'] });
      expect(result).toHaveLength(2);
      expect(result.map(e => e.definition.name).sort()).toEqual(['bash', 'read_file']);
    });

    it('filters by deniedTools blacklist', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('bash')).register(makeTool('read_file')).register(makeTool('write_file'));
      const result = reg.scopedView({ deniedTools: ['bash'] });
      expect(result).toHaveLength(2);
      expect(result.map(e => e.definition.name).sort()).toEqual(['read_file', 'write_file']);
    });

    it('applies both allowedTools and deniedTools', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('bash')).register(makeTool('read_file')).register(makeTool('write_file'));
      const result = reg.scopedView({ allowedTools: ['bash', 'read_file'], deniedTools: ['bash'] });
      expect(result).toHaveLength(1);
      expect(result[0]!.definition.name).toBe('read_file');
    });

    it('returns all tools with empty config', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('bash')).register(makeTool('read_file'));
      const result = reg.scopedView({});
      expect(result).toHaveLength(2);
    });

    it('ignores unknown tool names in allowedTools', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('bash'));
      const result = reg.scopedView({ allowedTools: ['nonexistent', 'bash'] });
      expect(result).toHaveLength(1);
      expect(result[0]!.definition.name).toBe('bash');
    });

    it('returns filtered copy, not a reference', () => {
      const reg = new ToolRegistry();
      reg.register(makeTool('bash')).register(makeTool('read_file'));
      const result = reg.scopedView({ allowedTools: ['bash'] });
      result.pop();
      // Original registry unaffected
      expect(reg.getEntries()).toHaveLength(2);
    });
  });
});
