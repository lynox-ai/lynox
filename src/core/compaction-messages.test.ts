import { describe, it, expect } from 'vitest';
import type {
  BetaMessageParam,
  BetaImageBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js';
import { buildPostCompactionMessages } from './compaction-messages.js';

/** A base64 image block with the given payload. */
function img(data: string): BetaImageBlockParam {
  return { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
}

/** The base64 payload of an image block (typesafe over the source union). */
function dataOf(block: BetaImageBlockParam): string {
  return block.source.type === 'base64' ? block.source.data : '';
}

/** Every image block carried inside a message's content array. */
function imagesOf(msg: BetaMessageParam): BetaImageBlockParam[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((b): b is BetaImageBlockParam => b.type === 'image');
}

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

describe('buildPostCompactionMessages — carried images (#4 big-image preserve)', () => {
  it('re-attaches carried images as a user image message right after the summary ack', () => {
    const msgs = buildPostCompactionMessages('summary', [], { carriedImages: [img('AAA'), img('BBB')] });
    // summary(2) + carried-images(2)
    expect(msgs).toHaveLength(4);
    expect(msgs[0]!.role).toBe('user');       // summary
    expect(msgs[1]!.role).toBe('assistant');  // summary ack
    expect(msgs[2]!.role).toBe('user');       // carried images
    expect(msgs[3]!.role).toBe('assistant');  // image ack

    // The images ride a real user message, in chronological order, behind a label.
    const carried = imagesOf(msgs[2]!);
    expect(carried.map(dataOf)).toEqual(['AAA', 'BBB']);
    const content = msgs[2]!.content;
    expect(Array.isArray(content) && content[0]!.type === 'text').toBe(true);
    expect(JSON.stringify(content)).toContain('carried across the summary');
    expect(String(msgs[3]!.content)).toContain('2 image(s)');
  });

  it('keeps valid role alternation with images + handles + scope steer all present', () => {
    const msgs = buildPostCompactionMessages(
      'summary',
      [{ id: 'tr-1', descriptor: 'web_research: dental' }],
      { carriedImages: [img('X')], confirmScope: true },
    );
    // summary(2) + images(2) + recall(2) + steer(2)
    expect(msgs).toHaveLength(8);
    // Strict user/assistant alternation → no Anthropic 400 role error.
    msgs.forEach((m, i) => expect(m.role).toBe(i % 2 === 0 ? 'user' : 'assistant'));
  });

  it('coexists with tool-result recall handles (both sections survive)', () => {
    const msgs = buildPostCompactionMessages(
      'summary',
      [{ id: 'tr-1', descriptor: 'web_research: x' }],
      { carriedImages: [img('Y')] },
    );
    // summary(2) + images(2) + recall(2)
    expect(msgs).toHaveLength(6);
    const hasImage = msgs.some(m => imagesOf(m).length > 0);
    const hasRecall = msgs.some(m => typeof m.content === 'string' && m.content.includes('[Recallable tool results]'));
    expect(hasImage).toBe(true);
    expect(hasRecall).toBe(true);
    // Image section precedes the recall section.
    const imgIdx = msgs.findIndex(m => imagesOf(m).length > 0);
    const recallIdx = msgs.findIndex(m => typeof m.content === 'string' && m.content.includes('[Recallable tool results]'));
    expect(imgIdx).toBeLessThan(recallIdx);
  });

  it('is byte-identical to the no-image output when no images are carried (regression)', () => {
    const withEmpty = buildPostCompactionMessages('summary', [{ id: 'tr-1', descriptor: 'd' }], { carriedImages: [] });
    const without = buildPostCompactionMessages('summary', [{ id: 'tr-1', descriptor: 'd' }]);
    expect(withEmpty).toEqual(without);
    expect(withEmpty.some(m => imagesOf(m).length > 0)).toBe(false);
  });
});
