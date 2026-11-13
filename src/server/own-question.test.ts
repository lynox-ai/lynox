import { describe, it, expect } from 'vitest';
import { awaitsOwnQuestion } from './own-question.js';

describe('awaitsOwnQuestion', () => {
  const run = (started_at?: string | null) => ({ status: 'running', started_at });

  it('a question asked after the run started is the run\'s own: waiting', () => {
    expect(awaitsOwnQuestion(run('2026-11-08 10:00:00'), { created_at: '2026-11-08 10:00:05' })).toBe(true);
  });

  it('a question asked before the run started is not: the run is working', () => {
    expect(awaitsOwnQuestion(run('2026-11-08 10:00:00'), { created_at: '2026-11-08 09:59:59' })).toBe(false);
  });

  it('the same second reads as waiting, as before', () => {
    expect(awaitsOwnQuestion(run('2026-11-08 10:00:00'), { created_at: '2026-11-08 10:00:00' })).toBe(true);
  });

  it('a missing stamp on either side reads as waiting, as before', () => {
    expect(awaitsOwnQuestion(run(null), { created_at: '2026-11-08 09:00:00' })).toBe(true);
    expect(awaitsOwnQuestion(run(''), { created_at: '2026-11-08 09:00:00' })).toBe(true);
    expect(awaitsOwnQuestion(run('2026-11-08 10:00:00'), { created_at: null })).toBe(true);
    expect(awaitsOwnQuestion(run('2026-11-08 10:00:00'), {})).toBe(true);
  });

  it('no question, or a run that is not running: not waiting', () => {
    expect(awaitsOwnQuestion(run('2026-11-08 10:00:00'), undefined)).toBe(false);
    expect(awaitsOwnQuestion({ status: 'interrupted', started_at: '2026-11-08 10:00:00' }, { created_at: '2026-11-08 10:00:05' })).toBe(false);
  });
});
