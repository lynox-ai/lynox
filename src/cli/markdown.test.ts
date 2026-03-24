import { describe, it, expect, beforeEach } from 'vitest';
import { MarkdownStreamer } from './markdown.js';

describe('MarkdownStreamer', () => {
  let md: MarkdownStreamer;

  beforeEach(() => {
    md = new MarkdownStreamer();
  });

  it('passes plain text through unchanged', () => {
    expect(md.push('hello world\n')).toBe('hello world\n');
  });

  describe('bold', () => {
    it('wraps **text** in BOLD', () => {
      const out = md.push('**bold**\n');
      expect(out).toContain('\x1b[1m');
      expect(out).toContain('bold');
      expect(out).toContain('\x1b[0m');
    });

    it('handles bold split across chunks', () => {
      let out = md.push('**bo');
      out += md.push('ld**\n');
      expect(out).toContain('\x1b[1m');
      expect(out).toContain('bold');
    });
  });

  describe('inline code', () => {
    it('wraps `code` in BLUE', () => {
      const out = md.push('`code`\n');
      expect(out).toContain('\x1b[34m');
      expect(out).toContain('code');
    });

    it('handles inline code split across chunks', () => {
      let out = md.push('`co');
      out += md.push('de`\n');
      expect(out).toContain('\x1b[34m');
      expect(out).toContain('code');
    });
  });

  describe('code blocks', () => {
    it('renders code block with language label', () => {
      const out = md.push('```typescript\nconsole.log("hi");\n```\n');
      expect(out).toContain('[typescript]');
      expect(out).toContain('console.log("hi");');
    });

    it('renders code block without language', () => {
      const out = md.push('```\nraw code\n```\n');
      expect(out).toContain('raw code');
      // DIM escape for code block
      expect(out).toContain('\x1b[2m');
    });

    it('handles code block split across chunks', () => {
      let out = md.push('```js\ncon');
      out += md.push('sole.log();\n``');
      out += md.push('`\n');
      expect(out).toContain('[js]');
      expect(out).toContain('console.log();');
    });
  });

  describe('headers', () => {
    it('styles # header', () => {
      const out = md.push('# Title\n');
      expect(out).toContain('Title');
      expect(out).toContain('\x1b[35m'); // MAGENTA
      expect(out).toContain('\x1b[1m');  // BOLD
    });

    it('styles ## header', () => {
      const out = md.push('## Subtitle\n');
      expect(out).toContain('Subtitle');
      expect(out).toContain('\x1b[36m'); // CYAN
      expect(out).toContain('\x1b[1m');  // BOLD
    });

    it('styles ### header', () => {
      const out = md.push('### Section\n');
      expect(out).toContain('Section');
      expect(out).toContain('\x1b[1m');  // BOLD
    });
  });

  describe('lists', () => {
    it('renders unordered list with -', () => {
      const out = md.push('- item one\n');
      expect(out).toContain('•');
      expect(out).toContain('item one');
    });

    it('renders unordered list with +', () => {
      const out = md.push('+ item two\n');
      expect(out).toContain('•');
      expect(out).toContain('item two');
    });

    it('renders unordered list with *', () => {
      const out = md.push('* item three\n');
      expect(out).toContain('•');
      expect(out).toContain('item three');
    });

    it('renders ordered list', () => {
      const out = md.push('1. first\n');
      expect(out).toContain('1.');
      expect(out).toContain('first');
    });
  });

  describe('horizontal rules', () => {
    it('renders --- as horizontal rule', () => {
      const out = md.push('---\n');
      expect(out).toContain('─'.repeat(40));
    });

    it('renders ___ as horizontal rule', () => {
      const out = md.push('___\n');
      expect(out).toContain('─'.repeat(40));
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      md.push('**open bold');
      md.reset();
      const out = md.push('clean text\n');
      expect(out).toBe('clean text\n');
    });
  });

  describe('flush', () => {
    it('returns remaining buffered content', () => {
      // Single * is ambiguous and gets buffered
      md.push('*');
      const remaining = md.flush();
      expect(remaining).toBe('*');
    });

    it('returns empty string when buffer is empty', () => {
      md.push('hello\n');
      expect(md.flush()).toBe('');
    });

    it('appends RESET when flushing with active bold formatting', () => {
      md.push('**open bold');
      const flushed = md.flush();
      expect(flushed).toContain('\x1b[0m');
    });

    it('appends RESET when flushing with active inline code', () => {
      md.push('`open code');
      const flushed = md.flush();
      expect(flushed).toContain('\x1b[0m');
    });
  });

  describe('code block closing edge case', () => {
    it('clears buffer when closing ``` has no trailing newline', () => {
      let out = md.push('```js\ncode();\n```');
      out += md.flush();
      expect(out).toContain('code();');
      // After flush, buffer should be empty
      const next = md.push('next\n');
      // Should not contain leftover from previous block
      expect(next).not.toContain('```');
    });

    it('sets lineStart after closing code block', () => {
      let out = md.push('```\ncode\n```\n');
      out += md.push('- list item\n');
      expect(out).toContain('•');
      expect(out).toContain('list item');
    });
  });

  describe('tables', () => {
    it('renders a simple table', () => {
      const input = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |\n\n';
      const out = md.push(input);
      expect(out).toContain('Name');
      expect(out).toContain('Age');
      expect(out).toContain('Alice');
      expect(out).toContain('30');
      expect(out).toContain('Bob');
      expect(out).toContain('25');
      // Box-drawing chars
      expect(out).toContain('┌');
      expect(out).toContain('┘');
      expect(out).toContain('│');
    });
  });

  describe('blockquotes', () => {
    it('renders > as blockquote with bar', () => {
      const out = md.push('> quoted text\n');
      expect(out).toContain('▎');
      expect(out).toContain('quoted text');
    });

    it('renders > without space', () => {
      const out = md.push('>no space\n');
      expect(out).toContain('▎');
      expect(out).toContain('no space');
    });
  });

  describe('links', () => {
    it('renders [text](url) as underlined text + dim URL', () => {
      const out = md.push('[Click here](https://example.com)\n');
      expect(out).toContain('\x1b[4m');  // UNDERLINE
      expect(out).toContain('Click here');
      expect(out).toContain('https://example.com');
    });
  });

  describe('strikethrough', () => {
    it('renders ~~text~~ with strikethrough', () => {
      const out = md.push('~~deleted~~\n');
      expect(out).toContain('\x1b[9m');  // STRIKETHROUGH
      expect(out).toContain('deleted');
      expect(out).toContain('\x1b[0m');  // RESET
    });
  });

  describe('nested lists', () => {
    it('renders nested unordered list with indentation', () => {
      let out = md.push('- parent\n');
      out += md.push('  - child\n');
      expect(out).toContain('parent');
      expect(out).toContain('child');
      // Both have bullet markers
      const bullets = out.match(/•/g);
      expect(bullets?.length).toBe(2);
    });
  });

  describe('inline formatting in headers', () => {
    it('renders bold inside header', () => {
      const out = md.push('# Title with **bold**\n');
      expect(out).toContain('\x1b[1m'); // BOLD (from header and inline)
      expect(out).toContain('Title with');
      expect(out).toContain('bold');
    });

    it('renders inline code inside header', () => {
      const out = md.push('## Header with `code`\n');
      expect(out).toContain('\x1b[34m'); // BLUE for inline code
      expect(out).toContain('code');
    });
  });

  describe('italic', () => {
    it('renders *text* as italic', () => {
      const out = md.push('*italic*\n');
      expect(out).toContain('\x1b[3m');  // ITALIC
      expect(out).toContain('italic');
    });
  });

  describe('bold+italic', () => {
    it('renders ***text*** as bold+italic', () => {
      const out = md.push('***both***\n');
      expect(out).toContain('\x1b[1m');  // BOLD
      expect(out).toContain('\x1b[3m');  // ITALIC
      expect(out).toContain('both');
    });
  });

  describe('streaming edge cases', () => {
    it('buffers ambiguous single *', () => {
      const out = md.push('*');
      // Should buffer, not output
      expect(out).toBe('');
    });

    it('handles empty push', () => {
      expect(md.push('')).toBe('');
    });
  });
});
