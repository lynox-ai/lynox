import { describe, it, expect } from 'vitest';
import { buildPostCompactionMessages } from './compaction-messages.js';

describe('buildPostCompactionMessages', () => {
  it('wraps the summary as a user/assistant pair', () => {
    const msgs = buildPostCompactionMessages('decisions: X; open task: Y', []);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: 'user', content: 'What have we discussed so far?' });
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.content).toContain('[Conversation summary]');
    expect(msgs[1]!.content).toContain('decisions: X; open task: Y');
  });

  it('appends a recall block (one line per handle) when blobs were evicted', () => {
    const msgs = buildPostCompactionMessages('summary', [
      { id: 'tr-1', descriptor: 'web_research: dental software CH' },
      { id: 'tr-2', descriptor: 'read_file: report.md' },
    ]);
    expect(msgs).toHaveLength(4);
    const recall = msgs[3]!.content as string;
    expect(recall).toContain('[Recallable tool results]');
    expect(recall).toContain('recall_tool_result("tr-1") — web_research: dental software CH');
    expect(recall).toContain('recall_tool_result("tr-2") — read_file: report.md');
  });

  it('omits the recall block when there are no handles', () => {
    const msgs = buildPostCompactionMessages('summary', []);
    expect(msgs.every(m => !String(m.content).includes('[Recallable tool results]'))).toBe(true);
  });

  it('adds the scope-confirm steer only when confirmScope is set', () => {
    const without = buildPostCompactionMessages('summary', []);
    expect(without.some(m => String(m.content).includes('[Post-compaction check]'))).toBe(false);

    const withSteer = buildPostCompactionMessages('summary', [], { confirmScope: true });
    const steer = withSteer.find(m => String(m.content).includes('[Post-compaction check]'));
    expect(steer).toBeDefined();
    expect(steer!.role).toBe('assistant');
    expect(String(steer!.content)).toMatch(/restate the current task|confirm that's still the right scope/);
  });

  it('orders summary → recall → steer', () => {
    const msgs = buildPostCompactionMessages('summary', [{ id: 'tr-1', descriptor: 'd' }], { confirmScope: true });
    const text = msgs.map(m => String(m.content)).join('\n');
    expect(text.indexOf('[Conversation summary]')).toBeLessThan(text.indexOf('[Recallable tool results]'));
    expect(text.indexOf('[Recallable tool results]')).toBeLessThan(text.indexOf('[Post-compaction check]'));
  });
});
