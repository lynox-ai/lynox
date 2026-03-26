import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { RunHistory } from '../../core/run-history.js';
import { TaskManager } from '../../core/task-manager.js';
import { handleSchedule } from './task.js';
import type { Session } from '../../core/session.js';
import type { CLICtx } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect everything written to ctx.stdout into a string. */
function makeCtx(): CLICtx & { output: () => string } {
  const chunks: string[] = [];
  const stdout = new Writable({
    write(chunk: Buffer | string, _encoding: string, cb: () => void) {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return {
    stdout,
    output: () => chunks.join(''),
  };
}

function makeSession(history: RunHistory): Session {
  return {
    getRunHistory: vi.fn(() => history),
    getActiveScopes: vi.fn(() => []),
  } as unknown as Session;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleSchedule', () => {
  let dir: string;
  let history: RunHistory;
  let tm: TaskManager;
  let session: Session;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-schedule-test-'));
    history = new RunHistory(join(dir, 'test.db'));
    tm = new TaskManager(history);
    session = makeSession(history);
  });

  afterEach(() => {
    history.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // /schedule list — with scheduled tasks
  // -------------------------------------------------------------------------

  it('/schedule list — with scheduled tasks prints table', async () => {
    tm.createScheduled({
      title: 'Daily Report',
      scheduleCron: '0 8 * * *',
    });

    const ctx = makeCtx();
    await handleSchedule(['schedule', 'list'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Daily Report');
    expect(out).toContain('scheduled');
    expect(out).toContain('0 8 * * *');
    expect(out).toContain('ID');
    expect(out).toContain('Type');
    expect(out).toContain('Schedule');
  });

  // -------------------------------------------------------------------------
  // /schedule list — with no tasks
  // -------------------------------------------------------------------------

  it('/schedule list — with no tasks prints empty message', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'list'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('No active scheduled or watch tasks');
  });

  // -------------------------------------------------------------------------
  // /schedule details <id> — with valid task
  // -------------------------------------------------------------------------

  it('/schedule details <id> — with valid task prints details', async () => {
    const task = tm.createScheduled({
      title: 'Weekly Sync',
      scheduleCron: '0 9 * * 1',
      notificationChannel: 'telegram',
    });

    const ctx = makeCtx();
    await handleSchedule(['schedule', 'details', task.id], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Weekly Sync');
    expect(out).toContain('scheduled');
    expect(out).toContain('0 9 * * 1');
    expect(out).toContain('Type:');
    expect(out).toContain('Schedule:');
    expect(out).toContain('Retries:');
    expect(out).toContain('telegram');
  });

  // -------------------------------------------------------------------------
  // /schedule details <id> — with unknown id
  // -------------------------------------------------------------------------

  it('/schedule details <id> — with unknown id prints error', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'details', 'nonexistent'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Task not found');
    expect(out).toContain('nonexistent');
  });

  // -------------------------------------------------------------------------
  // /schedule cancel <id> — completes the task
  // -------------------------------------------------------------------------

  it('/schedule cancel <id> — completes the task', async () => {
    const task = tm.createScheduled({
      title: 'Nightly Backup',
      scheduleCron: '0 2 * * *',
    });

    const ctx = makeCtx();
    await handleSchedule(['schedule', 'cancel', task.id], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Scheduled task cancelled');
    expect(out).toContain('Nightly Backup');

    // Verify the task is actually completed in the DB
    const updated = history.getTask(task.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // /schedule test <cron> — prints next 5 occurrences
  // -------------------------------------------------------------------------

  it('/schedule test 0 8 * * * — prints next 5 occurrences', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'test', '0', '8', '*', '*', '*'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Next 5 occurrences');
    expect(out).toContain('0 8 * * *');
    // Should contain numbered lines 1-5
    expect(out).toContain('1.');
    expect(out).toContain('2.');
    expect(out).toContain('3.');
    expect(out).toContain('4.');
    expect(out).toContain('5.');
    // Each occurrence should be an ISO date string
    const isoMatches = out.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g);
    expect(isoMatches).toBeTruthy();
    expect(isoMatches!.length).toBe(5);
  });

  // -------------------------------------------------------------------------
  // /schedule test invalid — prints validation error
  // -------------------------------------------------------------------------

  it('/schedule test invalid — prints validation error', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'test', 'invalid'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Invalid cron expression');
    expect(out).toContain('invalid');
  });

  // -------------------------------------------------------------------------
  // /schedule (no subcommand) — same as list
  // -------------------------------------------------------------------------

  it('/schedule with no subcommand acts as list', async () => {
    // With no tasks should show empty message (same as list)
    const ctx = makeCtx();
    await handleSchedule(['schedule'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('No active scheduled or watch tasks');
  });

  it('/schedule with no subcommand and tasks shows table', async () => {
    tm.createScheduled({
      title: 'Hourly Check',
      scheduleCron: '0 * * * *',
    });

    const ctx = makeCtx();
    await handleSchedule(['schedule'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Hourly Check');
    expect(out).toContain('scheduled');
    expect(out).toContain('ID');
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('/schedule cancel with unknown id prints error', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'cancel', 'missing'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Task not found');
  });

  it('/schedule details without id prints usage', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'details'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Usage:');
    expect(out).toContain('schedule details');
  });

  it('/schedule cancel without id prints usage', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'cancel'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Usage:');
    expect(out).toContain('schedule cancel');
  });

  it('/schedule test without expression prints usage', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'test'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Usage:');
    expect(out).toContain('schedule test');
  });

  it('/schedule unknown subcommand prints error', async () => {
    const ctx = makeCtx();
    await handleSchedule(['schedule', 'foobar'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Unknown subcommand');
    expect(out).toContain('foobar');
  });

  it('returns true when history is unavailable', async () => {
    const noHistorySession = {
      getRunHistory: vi.fn(() => null),
      getActiveScopes: vi.fn(() => []),
    } as unknown as Session;

    const ctx = makeCtx();
    const result = await handleSchedule(['schedule'], noHistorySession, ctx);

    expect(result).toBe(true);
    expect(ctx.output()).toContain('Run history not available');
  });

  it('/schedule list shows watch tasks with interval', async () => {
    tm.createWatch({
      title: 'Monitor Pricing Page',
      watchUrl: 'https://example.com/pricing',
      watchIntervalMinutes: 30,
    });

    const ctx = makeCtx();
    await handleSchedule(['schedule', 'list'], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Monitor Pricing Page');
    expect(out).toContain('watch');
    expect(out).toContain('every 30m');
  });

  it('/schedule details for watch task shows URL', async () => {
    const task = tm.createWatch({
      title: 'Check Competitors',
      watchUrl: 'https://example.com/products',
      watchIntervalMinutes: 60,
    });

    const ctx = makeCtx();
    await handleSchedule(['schedule', 'details', task.id], session, ctx);

    const out = ctx.output();
    expect(out).toContain('Check Competitors');
    expect(out).toContain('every 60m');
    expect(out).toContain('https://example.com/products');
  });
});
