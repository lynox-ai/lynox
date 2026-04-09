import { describe, it, expect } from 'vitest';
import { channels, measureTool } from './observability.js';

describe('channels', () => {
  it('has toolStart channel with correct name', () => {
    expect(channels.toolStart.name).toBe('lynox:tool:start');
  });

  it('has toolEnd channel with correct name', () => {
    expect(channels.toolEnd.name).toBe('lynox:tool:end');
  });

  it('has spawnStart channel with correct name', () => {
    expect(channels.spawnStart.name).toBe('lynox:spawn:start');
  });

  it('has spawnEnd channel with correct name', () => {
    expect(channels.spawnEnd.name).toBe('lynox:spawn:end');
  });
});

describe('measureTool', () => {
  it('returns object with end method', () => {
    const m = measureTool('test');
    expect(typeof m.end).toBe('function');
  });

  it('end() returns duration >= 0', () => {
    const m = measureTool('test');
    const duration = m.end();
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('measures time between start and end', async () => {
    const m = measureTool('slow');
    // Wait a small amount to ensure measurable duration
    await new Promise(r => setTimeout(r, 5));
    const duration = m.end();
    expect(duration).toBeGreaterThan(0);
  });
});
