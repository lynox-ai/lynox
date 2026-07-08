import { describe, it, expect } from 'vitest';
import { WallClockBudget } from './wall-clock-budget.js';

// The load-bearing invariant behind the #77 fix: a run's wall-clock counts
// ONLY active compute-time, never the time it sits parked awaiting a human
// answer. These tests drive the budget with explicit timestamps (no real
// timers) so the pause/resume math is proven in isolation.
describe('WallClockBudget', () => {
  const THIRTY_MIN = 30 * 60_000;

  it('arms with the full budget on first arm', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    expect(b.remaining).toBe(THIRTY_MIN);
    expect(b.paused).toBe(true); // not yet armed
    expect(b.arm(0)).toBe(THIRTY_MIN);
    expect(b.paused).toBe(false);
  });

  it('banks only the compute-time consumed since arm on pause', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    b.arm(1_000);
    b.pause(4_000); // 3s of compute
    expect(b.remaining).toBe(THIRTY_MIN - 3_000);
    expect(b.paused).toBe(true);
  });

  it('EXCLUDES human-wait time from the budget (the #77 invariant)', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    // Compute 5s, then a human thinks for 95s while parked on a prompt,
    // then compute another 5s.
    b.arm(0);
    b.pause(5_000);                       // 5s compute → remaining = total-5s
    const rearmDelay = b.arm(100_000);    // human waited 95s (5_000→100_000)
    expect(rearmDelay).toBe(THIRTY_MIN - 5_000); // re-arm delay unaffected by the 95s wait
    b.pause(105_000);                     // another 5s compute
    // Total consumed = 10s of COMPUTE only; the 95s human wait never counted.
    expect(b.remaining).toBe(THIRTY_MIN - 10_000);
  });

  it('handles many interleaved compute/human intervals — only compute accrues', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    let t = 0;
    let expectedConsumed = 0;
    // 4 rounds of: compute `c`, then park (human waits `h`).
    for (const [c, h] of [[2_000, 60_000], [3_000, 120_000], [1_500, 10_000], [4_000, 300_000]]) {
      b.arm(t);
      t += c!;                 // compute
      b.pause(t);
      expectedConsumed += c!;
      t += h!;                 // human wait (must NOT count)
    }
    expect(b.remaining).toBe(THIRTY_MIN - expectedConsumed);
  });

  it('re-arm delay after a pause equals the remaining budget', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    b.arm(0);
    b.pause(600_000); // 10 min of compute
    const delay = b.arm(9_999_999); // resumed far in the future
    expect(delay).toBe(THIRTY_MIN - 600_000); // 20 min left, wait-time ignored
    expect(delay).toBeGreaterThan(0); // never fires synchronously on resume
  });

  it('double-pause is idempotent — never double-subtracts', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    b.arm(0);
    b.pause(1_000);
    const afterFirst = b.remaining;
    b.pause(50_000); // second pause with no active interval
    expect(b.remaining).toBe(afterFirst);
    expect(b.remaining).toBe(THIRTY_MIN - 1_000);
  });

  it('pause before any arm is a no-op', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    b.pause(10_000);
    expect(b.remaining).toBe(THIRTY_MIN);
    expect(b.paused).toBe(true);
  });

  it('floors the re-arm delay at minRearmMs when the budget overran', () => {
    const b = new WallClockBudget(5_000, 100); // 5s budget, 100ms floor
    b.arm(0);
    b.pause(6_000); // compute overran the budget by 1s
    expect(b.remaining).toBe(-1_000);
    // A resumed run still gets a minimal slice, not a zero/negative delay that
    // would fire synchronously in the middle of prompt-settle.
    expect(b.arm(7_000)).toBe(100);
  });

  it('a run that computes the whole budget (no prompts) still exhausts it', () => {
    const b = new WallClockBudget(THIRTY_MIN);
    b.arm(0);
    b.pause(THIRTY_MIN); // 30 min of straight compute
    expect(b.remaining).toBe(0);
    // Re-arm floors at the default minRearm (1s) so a hung run still gets aborted.
    expect(b.arm(THIRTY_MIN)).toBe(1_000);
  });
});
