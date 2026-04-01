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

    it('HTTP redirect SSRF protection on watch fetch', () => {
      const workerContent = readFileSync(join(SRC, 'core/worker-loop.ts'), 'utf-8');
      // The fetch call in executeWatch must disable redirect following to prevent
      // SSRF via redirect to internal endpoints (e.g. 169.254.169.254, localhost)
      expect(workerContent, 'worker-loop.ts must set redirect option on fetch').toMatch(/redirect\s*:\s*['"]error['"]/);
    });

    it('memory extraction scans for injection', () => {
      const memoryContent = readFileSync(join(SRC, 'core/memory.ts'), 'utf-8');
      // Memory extraction must scan extracted entries before storing to prevent
      // injected "Remember: [malicious instruction]" from external data
      expect(memoryContent, 'memory.ts must use detectInjectionAttempt').toContain('detectInjectionAttempt');
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
      // DNS-based SSRF protection: resolves hostname and checks actual IP ranges
      expect(workerContent, 'worker-loop.ts must use DNS lookup for SSRF checks').toContain('lookup');
      expect(workerContent).toContain('private URLs are not allowed');
    });

    it('EXTERNAL_TOOLS covers all external tool handlers', () => {
      const agentContent = readFileSync(join(SRC, 'core/agent.ts'), 'utf-8');
      // Extract the EXTERNAL_TOOLS set members
      const setMatch = agentContent.match(/EXTERNAL_TOOLS\s*=\s*new\s+Set\(\[([^\]]+)\]\)/);
      expect(setMatch, 'EXTERNAL_TOOLS set must exist in agent.ts').toBeTruthy();
      const toolList = setMatch![1]!;
      // All tools that make external requests must be in EXTERNAL_TOOLS for scanToolResult
      const requiredTools = [
        'bash', 'http_request', 'web_research',
        'google_gmail', 'google_sheets', 'google_drive', 'google_calendar', 'google_docs',
      ];
      for (const tool of requiredTools) {
        expect(toolList, `EXTERNAL_TOOLS must include '${tool}'`).toContain(tool);
      }
    });
  });

  describe('File System Safety', () => {

    it('write_file has path traversal protection', () => {
      const fsContent = readFileSync(join(SRC, 'tools/builtin/fs.ts'), 'utf-8');
      // write_file must detect symlink escape (path traversal via symlink)
      expect(fsContent, 'fs.ts must use lstatSync for symlink detection').toContain('lstatSync');
      expect(fsContent, 'fs.ts must check isSymbolicLink').toContain('isSymbolicLink');
      // write_file must have workspace boundary check
      const hasWorkspaceBoundary = fsContent.includes('validatePath')
        || fsContent.includes('LYNOX_WORKSPACE')
        || fsContent.includes('isWorkspaceActive');
      expect(hasWorkspaceBoundary, 'fs.ts must have workspace boundary validation').toBe(true);
    });
  });

  describe('Pipeline Safety', () => {

    it('pipeline template resolution is single-pass', () => {
      const contextContent = readFileSync(join(SRC, 'orchestrator/context.ts'), 'utf-8');
      // resolveTaskTemplate must use String.replace() (single-pass) — NOT a while loop
      // that would re-interpret {{}} patterns injected by step results.
      // Verify it uses .replace() with the template regex, not a recursive/iterative approach.
      expect(contextContent, 'context.ts must contain resolveTaskTemplate').toContain('resolveTaskTemplate');
      expect(contextContent, 'context.ts must use .replace() for template resolution').toMatch(/\.replace\(\s*\/\\\{\\{/);
      // Ensure there is no recursive call or while loop for template resolution
      const fnMatch = contextContent.match(/function resolveTaskTemplate[\s\S]*?^}/m);
      if (fnMatch) {
        const fnBody = fnMatch[0];
        // Remove the function signature line, then check the body for recursive calls
        const bodyOnly = fnBody.replace(/^function resolveTaskTemplate[^\n]*\n/, '');
        expect(bodyOnly, 'resolveTaskTemplate must not call itself recursively').not.toContain('resolveTaskTemplate(');
        // The function should not contain a while loop for re-resolution
        expect(bodyOnly, 'resolveTaskTemplate must not use while loop').not.toMatch(/while\s*\(/);
      }
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
