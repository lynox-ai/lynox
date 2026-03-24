import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseDebugFilter, initDebugSubscriber, _resetDebugSubscriber, maskTokenPatterns } from './debug-subscriber.js';

describe('parseDebugFilter', () => {
  it('returns null for falsy values', () => {
    expect(parseDebugFilter(undefined)).toBeNull();
    expect(parseDebugFilter('')).toBeNull();
    expect(parseDebugFilter('0')).toBeNull();
    expect(parseDebugFilter('false')).toBeNull();
  });

  it('returns all groups for "1", "true", "*"', () => {
    for (const val of ['1', 'true', '*']) {
      const result = parseDebugFilter(val);
      expect(result).not.toBeNull();
      expect(result!.has('tool')).toBe(true);
      expect(result!.has('spawn')).toBe(true);
      expect(result!.has('mode')).toBe(true);
      expect(result!.has('memory')).toBe(true);
      expect(result!.has('secret')).toBe(true);
      expect(result!.has('dag')).toBe(true);
    }
  });

  it('parses comma-separated groups', () => {
    const result = parseDebugFilter('tool,spawn,dag');
    expect(result).not.toBeNull();
    expect(result!.size).toBe(3);
    expect(result!.has('tool')).toBe(true);
    expect(result!.has('spawn')).toBe(true);
    expect(result!.has('dag')).toBe(true);
    expect(result!.has('mode')).toBe(false);
  });

  it('trims whitespace in groups', () => {
    const result = parseDebugFilter(' tool , spawn ');
    expect(result!.has('tool')).toBe(true);
    expect(result!.has('spawn')).toBe(true);
  });

  it('handles single group', () => {
    const result = parseDebugFilter('cost');
    expect(result!.size).toBe(1);
    expect(result!.has('cost')).toBe(true);
  });
});

describe('initDebugSubscriber', () => {
  const origEnv = { ...process.env };
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetDebugSubscriber();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    process.env = { ...origEnv };
    _resetDebugSubscriber();
    stderrSpy.mockRestore();
  });

  it('returns false when NODYN_DEBUG is not set', () => {
    delete process.env['NODYN_DEBUG'];
    expect(initDebugSubscriber()).toBe(false);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('returns true when NODYN_DEBUG=1', () => {
    process.env['NODYN_DEBUG'] = '1';
    expect(initDebugSubscriber()).toBe(true);
    expect(stderrSpy).toHaveBeenCalled();
    // Check activation message
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('[nodyn:debug] Active'))).toBe(true);
  });

  it('only initializes once (idempotent)', () => {
    process.env['NODYN_DEBUG'] = '1';
    initDebugSubscriber();
    const callCount = stderrSpy.mock.calls.length;
    initDebugSubscriber();
    // No additional activation messages
    expect(stderrSpy.mock.calls.length).toBe(callCount);
  });

  it('logs subscription confirmations for each group channel', () => {
    process.env['NODYN_DEBUG'] = 'tool';
    initDebugSubscriber();
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('subscribed: toolStart'))).toBe(true);
    expect(calls.some(c => c.includes('subscribed: toolEnd'))).toBe(true);
    // Should NOT subscribe to other groups
    expect(calls.some(c => c.includes('subscribed: spawnStart'))).toBe(false);
  });

  it('warns in production environment', () => {
    process.env['NODYN_DEBUG'] = '1';
    process.env['NODE_ENV'] = 'production';
    initDebugSubscriber();
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('production'))).toBe(true);
  });

  it('subscribes to channels and formats tool events', async () => {
    process.env['NODYN_DEBUG'] = 'tool';
    initDebugSubscriber();

    // Trigger a channel event
    const { channels: ch } = await import('./observability.js');
    ch.toolStart.publish({ name: 'bash', agent: 'main' });

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('nodyn:tool:start') && c.includes('tool=bash') && c.includes('agent=main'))).toBe(true);
  });

  it('formats spawn events correctly', async () => {
    process.env['NODYN_DEBUG'] = 'spawn';
    initDebugSubscriber();

    const { channels: ch } = await import('./observability.js');
    ch.spawnStart.publish({ agents: ['research', 'code'], parent: 'main', depth: 1 });

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('agents=[research,code]') && c.includes('parent=main'))).toBe(true);
  });

  it('formats secret access without leaking values', async () => {
    process.env['NODYN_DEBUG'] = 'secret';
    initDebugSubscriber();

    const { channels: ch } = await import('./observability.js');
    ch.secretAccess.publish({ name: 'MY_API_KEY', action: 'resolve' });

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const secretLine = calls.find(c => c.includes('nodyn:secret:access'));
    expect(secretLine).toBeDefined();
    expect(secretLine).toContain('name=MY_API_KEY');
    expect(secretLine).toContain('action=resolve');
    // Ensure no actual secret value is logged (only name + action)
    expect(secretLine).not.toContain('sk-');
  });

  it('production warning mentions sensitive data', () => {
    process.env['NODYN_DEBUG'] = '1';
    process.env['NODE_ENV'] = 'production';
    initDebugSubscriber();
    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    expect(calls.some(c => c.includes('sensitive data'))).toBe(true);
  });

  it('truncates long memory content', async () => {
    process.env['NODYN_DEBUG'] = 'memory';
    initDebugSubscriber();

    const { channels: ch } = await import('./observability.js');
    const longContent = 'A'.repeat(200);
    ch.memoryStore.publish({ namespace: 'context', content: longContent });

    const calls = stderrSpy.mock.calls.map(c => String(c[0]));
    const memLine = calls.find(c => c.includes('nodyn:memory:store'));
    expect(memLine).toBeDefined();
    // Content should be truncated (80 chars + ellipsis)
    expect(memLine!.length).toBeLessThan(250);
    expect(memLine).toContain('…');
  });
});

describe('maskTokenPatterns', () => {
  it('masks Google OAuth access tokens (ya29.*)', () => {
    const input = 'token: ya29.abc123xyz456_longtoken';
    const result = maskTokenPatterns(input);
    expect(result).toContain('ya29.***');
    expect(result).not.toContain('abc123xyz456');
  });

  it('masks JWT tokens (eyJ...)', () => {
    const input = 'jwt: eyJhbGciOiJSUzI1NiI.eyJpc3MiOiJ0ZXN0.signature_data';
    const result = maskTokenPatterns(input);
    expect(result).toContain('eyJ***');
    expect(result).not.toContain('eyJhbGciOiJSUzI1NiI');
  });

  it('leaves non-token strings untouched', () => {
    const input = 'normal log message with no tokens';
    expect(maskTokenPatterns(input)).toBe(input);
  });

  it('masks multiple tokens in one string', () => {
    const input = 'a=ya29.first_token b=ya29.second_token';
    const result = maskTokenPatterns(input);
    expect(result).toBe('a=ya29.*** b=ya29.***');
  });
});
