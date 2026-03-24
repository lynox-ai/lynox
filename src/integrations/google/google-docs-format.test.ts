import { describe, it, expect } from 'vitest';
import { docsToMarkdown, markdownToHtml } from './google-docs-format.js';
import type { DocsDocument } from './google-docs-format.js';

describe('docsToMarkdown', () => {
  it('converts headings', () => {
    const doc: DocsDocument = {
      documentId: 'test', title: 'Test',
      body: { content: [
        { startIndex: 0, endIndex: 12, paragraph: { elements: [{ startIndex: 0, endIndex: 12, textRun: { content: 'Main Title\n' } }], paragraphStyle: { namedStyleType: 'HEADING_1' } } },
        { startIndex: 12, endIndex: 24, paragraph: { elements: [{ startIndex: 12, endIndex: 24, textRun: { content: 'Sub Title\n' } }], paragraphStyle: { namedStyleType: 'HEADING_2' } } },
      ] },
    };
    expect(docsToMarkdown(doc)).toBe('# Main Title\n## Sub Title');
  });

  it('converts bold text', () => {
    const doc: DocsDocument = {
      documentId: 'test', title: 'Test',
      body: { content: [{ startIndex: 0, endIndex: 12, paragraph: { elements: [
        { startIndex: 0, endIndex: 5, textRun: { content: 'Hello ' } },
        { startIndex: 5, endIndex: 12, textRun: { content: 'World\n', textStyle: { bold: true } } },
      ], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } }] },
    };
    expect(docsToMarkdown(doc)).toBe('Hello **World**');
  });

  it('converts italic text', () => {
    const doc: DocsDocument = {
      documentId: 'test', title: 'Test',
      body: { content: [{ startIndex: 0, endIndex: 10, paragraph: { elements: [
        { startIndex: 0, endIndex: 10, textRun: { content: 'emphasis\n', textStyle: { italic: true } } },
      ] } }] },
    };
    expect(docsToMarkdown(doc)).toBe('*emphasis*');
  });

  it('converts bold+italic', () => {
    const doc: DocsDocument = {
      documentId: 'test', title: 'Test',
      body: { content: [{ startIndex: 0, endIndex: 10, paragraph: { elements: [
        { startIndex: 0, endIndex: 10, textRun: { content: 'strong\n', textStyle: { bold: true, italic: true } } },
      ] } }] },
    };
    expect(docsToMarkdown(doc)).toBe('***strong***');
  });

  it('converts links', () => {
    const doc: DocsDocument = {
      documentId: 'test', title: 'Test',
      body: { content: [{ startIndex: 0, endIndex: 12, paragraph: { elements: [
        { startIndex: 0, endIndex: 12, textRun: { content: 'Click here\n', textStyle: { link: { url: 'https://example.com' } } } },
      ] } }] },
    };
    expect(docsToMarkdown(doc)).toBe('[Click here](https://example.com)');
  });

  it('handles empty document', () => {
    const doc: DocsDocument = { documentId: 'test', title: 'Test', body: { content: [] } };
    expect(docsToMarkdown(doc)).toBe('');
  });

  it('skips non-paragraph elements', () => {
    const doc: DocsDocument = {
      documentId: 'test', title: 'Test',
      body: { content: [
        { startIndex: 0, endIndex: 1, sectionBreak: {} },
        { startIndex: 1, endIndex: 10, paragraph: { elements: [{ startIndex: 1, endIndex: 10, textRun: { content: 'Content\n' } }] } },
      ] },
    };
    expect(docsToMarkdown(doc)).toBe('Content');
  });
});

describe('markdownToHtml', () => {
  it('converts headings', () => {
    const html = markdownToHtml('# Title\n## Subtitle');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<h2>Subtitle</h2>');
  });

  it('converts bold text', () => {
    const html = markdownToHtml('Hello **World**');
    expect(html).toContain('Hello <strong>World</strong>');
  });

  it('converts italic text', () => {
    const html = markdownToHtml('Hello *world*');
    expect(html).toContain('Hello <em>world</em>');
  });

  it('converts strikethrough', () => {
    const html = markdownToHtml('~~deleted~~');
    expect(html).toContain('<s>deleted</s>');
  });

  it('converts inline code', () => {
    const html = markdownToHtml('Use `npm install`');
    expect(html).toContain('<code');
    expect(html).toContain('npm install');
  });

  it('converts code blocks', () => {
    const html = markdownToHtml('```\nconst x = 1;\n```');
    expect(html).toContain('<pre');
    expect(html).toContain('const x = 1;');
    expect(html).not.toContain('```');
  });

  it('converts links', () => {
    const html = markdownToHtml('[click](https://example.com)');
    expect(html).toContain('<a href="https://example.com">click</a>');
  });

  it('converts unordered lists', () => {
    const html = markdownToHtml('- Item one\n- Item two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>Item one</li>');
    expect(html).toContain('<li>Item two</li>');
    expect(html).toContain('</ul>');
  });

  it('converts ordered lists', () => {
    const html = markdownToHtml('1. First\n2. Second');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>First</li>');
    expect(html).toContain('<li>Second</li>');
    expect(html).toContain('</ol>');
  });

  it('converts blockquotes', () => {
    const html = markdownToHtml('> This is a quote');
    expect(html).toContain('<blockquote');
    expect(html).toContain('This is a quote');
  });

  it('converts horizontal rules', () => {
    const html = markdownToHtml('Above\n---\nBelow');
    expect(html).toContain('<hr');
  });

  it('converts tables with headers', () => {
    const html = markdownToHtml('| Name | Age |\n|---|---|\n| Alice | 30 |');
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('Name');
    expect(html).toContain('<td');
    expect(html).toContain('Alice');
    expect(html).toContain('30');
  });

  it('skips table separator rows', () => {
    const html = markdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |');
    expect(html).not.toContain('---');
  });

  it('escapes HTML entities', () => {
    const html = markdownToHtml('Use <div> & "quotes"');
    expect(html).toContain('&lt;div&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('wraps in valid HTML document', () => {
    const html = markdownToHtml('Hello');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="utf-8">');
  });

  it('handles empty input', () => {
    const html = markdownToHtml('');
    expect(html).toContain('<body');
    expect(html).toContain('</body>');
  });
});
