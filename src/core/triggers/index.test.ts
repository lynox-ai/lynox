import { describe, it, expect, vi } from 'vitest';

// Mock node:fs to prevent real filesystem access from FileTrigger/GitTrigger constructors
vi.mock('node:fs', () => ({
  watch: vi.fn(() => ({ close: vi.fn() })),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const { createTrigger } = await import('./index.js');

describe('createTrigger', () => {
  it('creates FileTrigger for type "file"', () => {
    const trigger = createTrigger({ type: 'file', dir: '/tmp' });
    expect(trigger.type).toBe('file');
  });

  it('creates HttpTrigger for type "http"', () => {
    const trigger = createTrigger({ type: 'http', port: 3000 });
    expect(trigger.type).toBe('http');
  });

  it('creates CronTrigger for type "cron"', () => {
    const trigger = createTrigger({ type: 'cron', expression: '30s' });
    expect(trigger.type).toBe('cron');
  });

  it('creates GitTrigger for type "git"', () => {
    const trigger = createTrigger({ type: 'git', hook: 'post-commit' });
    expect(trigger.type).toBe('git');
  });

  it('each trigger has the correct type field', () => {
    const fileTrigger = createTrigger({ type: 'file', dir: '/tmp' });
    const httpTrigger = createTrigger({ type: 'http', port: 0 });
    const cronTrigger = createTrigger({ type: 'cron', expression: '5m' });
    const gitTrigger = createTrigger({ type: 'git', hook: 'post-merge' });

    expect(fileTrigger.type).toBe('file');
    expect(httpTrigger.type).toBe('http');
    expect(cronTrigger.type).toBe('cron');
    expect(gitTrigger.type).toBe('git');
  });

  it('returns objects with start and stop methods', () => {
    const trigger = createTrigger({ type: 'cron', expression: '1h' });
    expect(typeof trigger.start).toBe('function');
    expect(typeof trigger.stop).toBe('function');
  });
});
