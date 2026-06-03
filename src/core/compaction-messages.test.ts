import { describe, it, expect } from 'vitest';
import { buildPostCompactionMessages } from './compaction-messages.js';

describe('buildPostCompactionMessages', () => {
  it('frames the summary as an authoritative user-anchored record', () => {
    const msgs = buildPostCompactionMessages('decisions: X; open task: Y', []);
    expect(msgs).toHaveLength(2);
    // Summary lives in a USER message (faithful record) so the agent trusts it
    // as ground truth rather than disowning it as its own un-backed claim.
    expect(msgs[0]!.role).toBe('user');
    expect(msgs[0]!.content).toContain('FAITHFUL, AUTHORITATIVE record');
    expect(msgs[0]!.content).toContain('decisions: X; open task: Y');
    expect(msgs[1]!.role).toBe('assistant');
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
    expect(text.indexOf('[Conversation summary')).toBeLessThan(text.indexOf('[Recallable tool results]'));
    expect(text.indexOf('[Recallable tool results]')).toBeLessThan(text.indexOf('[Post-compaction check]'));
  });
});
