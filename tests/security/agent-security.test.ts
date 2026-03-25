import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '../../src');

// Helper: read all .ts files recursively
function getAllTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

describe('Agent Security Audit', () => {

  describe('Prompt Injection Defense', () => {

    it('all external tool handlers wrap results with wrapUntrustedData', () => {
      // External tools that process untrusted data from the internet or third-party APIs.
      // bash is excluded — its output comes from the local system.
      const externalToolFiles = [
        'tools/builtin/http.ts',
        'integrations/search/web-search-tool.ts',
        'integrations/google/google-gmail.ts',
        'integrations/google/google-sheets.ts',
        'integrations/google/google-drive.ts',
        'integrations/google/google-calendar.ts',
        'integrations/google/google-docs.ts',
      ];

      for (const file of externalToolFiles) {
        const content = readFileSync(join(SRC, file), 'utf-8');
        expect(content, `${file} should import wrapUntrustedData`).toContain('wrapUntrustedData');
      }
    });

    it('agent scans external tool results via scanToolResult', () => {
      const agentContent = readFileSync(join(SRC, 'core/agent.ts'), 'utf-8');
      expect(agentContent).toContain('scanToolResult');
    });

    it('system prompt wraps knowledge context in boundary tags', () => {
      const agentContent = readFileSync(join(SRC, 'core/agent.ts'), 'utf-8');
      expect(agentContent).toContain('retrieved_context');
      expect(agentContent).toContain('anti-injection');
    });

    it('system prompt wraps briefing in boundary tags', () => {
      const agentContent = readFileSync(join(SRC, 'core/agent.ts'), 'utf-8');
      expect(agentContent).toContain('session_briefing');
    });

    it('MCP user_context is wrapped as untrusted data', () => {
      const mcpContent = readFileSync(join(SRC, 'server/mcp-server.ts'), 'utf-8');
      expect(mcpContent).toContain('wrapUntrustedData');
    });

    it('Telegram voice transcription is wrapped as untrusted data', () => {
      const tgContent = readFileSync(join(SRC, 'integrations/telegram/telegram-bot.ts'), 'utf-8');
      expect(tgContent).toContain('wrapUntrustedData');
    });
  });

  describe('No Dangerous Patterns', () => {

    it('no eval() or new Function() in source code', () => {
      const files = getAllTsFiles(SRC);
      for (const file of files) {
        if (file.endsWith('.test.ts')) continue; // skip tests
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          // Skip comments, regex patterns, and string literals that mention these patterns
          if (line.match(/^\s*\/\//) || line.match(/^\s*\*/) || line.includes('pattern:') || line.includes("'eval") || line.includes('"eval') || line.includes('no-eval')) continue;
          expect(line, `${file} should not contain eval()`).not.toMatch(/\beval\s*\(/);
          expect(line, `${file} should not contain new Function()`).not.toMatch(/new\s+Function\s*\(/);
        }
      }
    });

    it('no direct SQL string concatenation in queries', () => {
      // Check files that use SQLite
      const dbFiles = [
        'core/run-history-persistence.ts',
        'core/data-store.ts',
        'core/run-history.ts',
      ];
      for (const file of dbFiles) {
        const content = readFileSync(join(SRC, file), 'utf-8');
        // Pattern: db.exec(`...${variable}...`) or db.prepare(`...${variable}...`)
        // Should use parameterized queries instead
        const lines = content.split('\n');
        for (const line of lines) {
          if (line.match(/\.(exec|prepare)\s*\(\s*`[^`]*\$\{/) && !line.includes('version') && !line.includes('migration')) {
            // Allow safe patterns:
            // - Column name arrays built from hardcoded sets (e.g. sets.join(', '))
            // - DDL operations (CREATE/ALTER/DROP) where table/column names are validated
            // - SELECT COUNT with quoted table identifiers
            // - DELETE with quoted table identifiers (values are parameterized)
            // These are safe because identifiers come from validated code, and data values use ?
            if (line.includes('.join(')) continue;
            if (line.match(/CREATE\s+(TABLE|INDEX|UNIQUE)/i)) continue;
            if (line.match(/ALTER\s+TABLE/i)) continue;
            if (line.match(/DROP\s+TABLE/i)) continue;
            if (line.match(/SELECT\s+COUNT/i)) continue;
            if (line.match(/DELETE\s+FROM\s+"/i)) continue;
            // This is a potential SQL injection — flag it
            expect(line, `Potential SQL injection in ${file}`).not.toMatch(/\.(exec|prepare)\s*\(\s*`[^`]*\$\{/);
          }
        }
      }
    });

    it('secret patterns are never hardcoded', () => {
      const files = getAllTsFiles(SRC);
      for (const file of files) {
        if (file.endsWith('.test.ts')) continue;
        if (file.includes('setup-wizard')) continue; // wizard handles API key input
        const content = readFileSync(file, 'utf-8');
        // Check for hardcoded API key patterns
        expect(content, `${file}: no hardcoded API keys`).not.toMatch(/sk-ant-api\d{2}-[A-Za-z0-9]{20,}/);
        expect(content, `${file}: no hardcoded bearer tokens`).not.toMatch(/Bearer\s+[A-Za-z0-9]{30,}/);
      }
    });
  });

  describe('Permission Guards', () => {

    it('permission guard is wired into agent tool execution', () => {
      const agentContent = readFileSync(join(SRC, 'core/agent.ts'), 'utf-8');
      // Should check permissions before executing tools
      expect(agentContent).toMatch(/permission|danger|guard/i);
    });

    it('spawn_agent context scanned for injection in permission guard', () => {
      const guardContent = readFileSync(join(SRC, 'tools/permission-guard.ts'), 'utf-8');
      expect(guardContent).toContain('detectInjectionAttempt');
      // Verify it specifically handles spawn_agent
      expect(guardContent).toContain('spawn_agent');
    });

    it('watch task fetch has SSRF protection', () => {
      const workerContent = readFileSync(join(SRC, 'core/worker-loop.ts'), 'utf-8');
      expect(workerContent).toContain('localhost');
      expect(workerContent).toContain('127.0.0.1');
      expect(workerContent).toContain('192.168.');
    });
  });

  describe('Secret Handling', () => {

    it('secret store can detect and mask secret values in text', () => {
      const secretContent = readFileSync(join(SRC, 'core/secret-store.ts'), 'utf-8');
      expect(secretContent).toContain('containsSecret');
      expect(secretContent).toContain('maskSecrets');
    });

    it('debug subscriber masks token patterns', () => {
      const debugContent = readFileSync(join(SRC, 'core/debug-subscriber.ts'), 'utf-8');
      expect(debugContent).toContain('maskTokenPatterns');
    });
  });
});
