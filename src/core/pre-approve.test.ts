import { describe, it, expect, vi } from 'vitest';
import {
  globToRegex,
  extractMatchString,
  matchesPreApproval,
  buildApprovalSet,
  isCriticalTool,
} from './pre-approve.js';
import type { PreApprovalPattern, PreApprovalSet, PreApproveAuditLike } from '../types/index.js';

function makeSet(
  patterns: PreApprovalPattern[],
  overrides?: Partial<PreApprovalSet>,
): PreApprovalSet {
  return {
    id: 'test-id',
    approvedAt: new Date().toISOString(),
    approvedBy: 'operator',
    taskSummary: 'test',
    patterns,
    maxUses: 0,
    ttlMs: 0,
    usageCounts: new Array(patterns.length).fill(0) as number[],
    ...overrides,
  };
}

describe('globToRegex', () => {
  it('matches "npm run *" against "npm run build"', () => {
    expect(globToRegex('npm run *').test('npm run build')).toBe(true);
  });

  it('matches "dist/**" against "dist/index.js"', () => {
    expect(globToRegex('dist/**').test('dist/index.js')).toBe(true);
  });

  it('matches "*.env" against ".env"', () => {
    expect(globToRegex('*.env').test('.env')).toBe(true);
  });

  it('does NOT match unrelated string', () => {
    expect(globToRegex('npm run *').test('git push')).toBe(false);
  });

  it('matches nested paths with **', () => {
    expect(globToRegex('src/**/*.ts').test('src/core/agent.ts')).toBe(true);
  });

  it('does not match path with / for single *', () => {
    expect(globToRegex('src/*.ts').test('src/core/agent.ts')).toBe(false);
  });

  it('escapes regex specials like dots and parens', () => {
    expect(globToRegex('file.txt').test('file.txt')).toBe(true);
    expect(globToRegex('file.txt').test('fileatxt')).toBe(false);
  });

  it('handles ? wildcard', () => {
    expect(globToRegex('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegex('file?.txt').test('file12.txt')).toBe(false);
  });
});

describe('extractMatchString', () => {
  it('extracts command from bash input', () => {
    expect(extractMatchString('bash', { command: 'npm run build' })).toBe('npm run build');
  });

  it('extracts path from write_file input', () => {
    expect(extractMatchString('write_file', { path: '/app/x.ts' })).toBe('/app/x.ts');
  });

  it('extracts path from read_file input', () => {
    expect(extractMatchString('read_file', { path: '/etc/passwd' })).toBe('/etc/passwd');
  });

  it('extracts method+url from http_request input', () => {
    expect(extractMatchString('http_request', { method: 'POST', url: 'https://api.example.com' }))
      .toBe('POST https://api.example.com');
  });

  it('extracts spawn task', () => {
    expect(extractMatchString('spawn_agent', { task: 'review code' }))
      .toBe('spawn:review code');
  });

  it('extracts batch_files operation:pattern', () => {
    expect(extractMatchString('batch_files', { operation: 'rename', pattern: '*.ts' }))
      .toBe('rename:*.ts');
  });

  it('falls back to JSON for unknown tools', () => {
    const result = extractMatchString('unknown_tool', { foo: 1 });
    expect(result).toBe('{"foo":1}');
  });

  it('returns empty for null input', () => {
    expect(extractMatchString('bash', null)).toBe('');
  });
});

describe('matchesPreApproval', () => {
  it('returns true for matching pattern', () => {
    const set = makeSet([
      { tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' },
    ]);
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(true);
  });

  it('returns false for wrong tool', () => {
    const set = makeSet([
      { tool: 'write_file', pattern: 'dist/**', label: 'dist writes', risk: 'medium' },
    ]);
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(false);
  });

  it('returns false when usage limit reached', () => {
    const set = makeSet(
      [{ tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' }],
      { maxUses: 2, usageCounts: [2] },
    );
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(false);
  });

  it('returns false when TTL expired', () => {
    const set = makeSet(
      [{ tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' }],
      { ttlMs: 1000, approvedAt: new Date(Date.now() - 2000).toISOString() },
    );
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(false);
  });

  it('allows unlimited uses when maxUses is 0', () => {
    const set = makeSet(
      [{ tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' }],
      { maxUses: 0, usageCounts: [999] },
    );
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(true);
  });

  it('increments usageCounts on match', () => {
    const set = makeSet([
      { tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' },
    ]);
    matchesPreApproval('bash', { command: 'npm run build' }, set);
    expect(set.usageCounts[0]).toBe(1);
    matchesPreApproval('bash', { command: 'npm run test' }, set);
    expect(set.usageCounts[0]).toBe(2);
  });

  it('returns false for empty patterns set', () => {
    const set = makeSet([]);
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(false);
  });

  it('matches the correct pattern among multiple', () => {
    const set = makeSet([
      { tool: 'bash', pattern: 'git *', label: 'git', risk: 'medium' },
      { tool: 'write_file', pattern: 'dist/**', label: 'dist', risk: 'medium' },
    ]);
    expect(matchesPreApproval('write_file', { path: 'dist/index.js' }, set)).toBe(true);
    expect(set.usageCounts[0]).toBe(0);
    expect(set.usageCounts[1]).toBe(1);
  });
});

describe('buildApprovalSet', () => {
  it('filters patterns matching CRITICAL_BASH', () => {
    const patterns: PreApprovalPattern[] = [
      { tool: 'bash', pattern: 'npm run *', label: 'npm', risk: 'low' },
      { tool: 'bash', pattern: 'sudo *', label: 'sudo', risk: 'high' },
      { tool: 'bash', pattern: 'rm -rf /*', label: 'rm', risk: 'high' },
    ];
    const set = buildApprovalSet(patterns);
    expect(set.patterns).toHaveLength(1);
    expect(set.patterns[0]!.pattern).toBe('npm run *');
  });

  it('sets defaults correctly', () => {
    const set = buildApprovalSet([
      { tool: 'bash', pattern: 'npm *', label: 'npm', risk: 'low' },
    ]);
    expect(set.maxUses).toBe(10);
    expect(set.ttlMs).toBe(0);
    expect(set.approvedBy).toBe('operator');
    expect(set.usageCounts).toEqual([0]);
  });

  it('accepts custom options', () => {
    const set = buildApprovalSet(
      [{ tool: 'bash', pattern: 'npm *', label: 'npm', risk: 'low' }],
      { maxUses: 5, ttlMs: 60000, taskSummary: 'Deploy' },
    );
    expect(set.maxUses).toBe(5);
    expect(set.ttlMs).toBe(60000);
    expect(set.taskSummary).toBe('Deploy');
  });

  it('returns empty patterns when all are critical', () => {
    const set = buildApprovalSet([
      { tool: 'bash', pattern: 'sudo *', label: 'sudo', risk: 'high' },
    ]);
    expect(set.patterns).toHaveLength(0);
  });
});

describe('isCriticalTool', () => {
  it('detects "sudo *" as critical', () => {
    expect(isCriticalTool('bash', 'sudo *')).toBe(true);
  });

  it('detects "rm -rf /*" as critical', () => {
    expect(isCriticalTool('bash', 'rm -rf /*')).toBe(true);
  });

  it('detects "shutdown *" as critical', () => {
    expect(isCriticalTool('bash', 'shutdown *')).toBe(true);
  });

  it('detects "reboot" as critical', () => {
    expect(isCriticalTool('bash', 'reboot')).toBe(true);
  });

  it('detects "printenv" as critical', () => {
    expect(isCriticalTool('bash', 'printenv')).toBe(true);
  });

  it('allows "npm run *" as non-critical', () => {
    expect(isCriticalTool('bash', 'npm run *')).toBe(false);
  });

  it('allows "git status" as non-critical', () => {
    expect(isCriticalTool('bash', 'git status')).toBe(false);
  });

  it('always returns false for non-bash tools', () => {
    expect(isCriticalTool('write_file', 'sudo *')).toBe(false);
  });
});

describe('matchesPreApproval — audit integration', () => {
  function makeMockAudit(): PreApproveAuditLike & { calls: Array<{ decision: string }> } {
    const calls: Array<{ decision: string }> = [];
    return {
      calls,
      recordCheck(event) { calls.push({ decision: event.decision }); },
    };
  }

  it('calls audit.recordCheck on match', () => {
    const set = makeSet([
      { tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' },
    ]);
    const audit = makeMockAudit();
    matchesPreApproval('bash', { command: 'npm run build' }, set, audit);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]!.decision).toBe('approved');
  });

  it('records exhausted when maxUses exceeded', () => {
    const set = makeSet(
      [{ tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' }],
      { maxUses: 1, usageCounts: [1] },
    );
    const audit = makeMockAudit();
    matchesPreApproval('bash', { command: 'npm run build' }, set, audit);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]!.decision).toBe('exhausted');
  });

  it('records expired when TTL elapsed', () => {
    const set = makeSet(
      [{ tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' }],
      { ttlMs: 1000, approvedAt: new Date(Date.now() - 2000).toISOString() },
    );
    const audit = makeMockAudit();
    matchesPreApproval('bash', { command: 'npm run build' }, set, audit);
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]!.decision).toBe('expired');
  });

  it('works without audit param (backward compat)', () => {
    const set = makeSet([
      { tool: 'bash', pattern: 'npm run *', label: 'npm run', risk: 'low' },
    ]);
    // No audit parameter — should not throw
    expect(matchesPreApproval('bash', { command: 'npm run build' }, set)).toBe(true);
  });
});
