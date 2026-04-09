/**
 * Markdown to/from Google Docs JSON format conversion.
 *
 * For reading: Docs JSON → Markdown
 * For creating: Markdown → HTML (uploaded via Drive API, Google converts to Docs natively)
 *
 * Using HTML as intermediate format is far more reliable than Docs batchUpdate requests,
 * especially for tables, nested lists, and code blocks.
 */

// === Types ===

interface DocsTextRun {
  content: string;
  textStyle?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    link?: { url: string };
  };
}

interface DocsParagraphElement {
  startIndex: number;
  endIndex: number;
  textRun?: DocsTextRun;
  inlineObjectElement?: { inlineObjectId: string };
}

interface DocsParagraph {
  elements: DocsParagraphElement[];
  paragraphStyle?: {
    namedStyleType?: string;
    headingId?: string;
  };
}

interface DocsStructuralElement {
  startIndex: number;
  endIndex: number;
  paragraph?: DocsParagraph;
  table?: unknown;
  sectionBreak?: unknown;
}

export interface DocsDocument {
  documentId: string;
  title: string;
  body: {
    content: DocsStructuralElement[];
  };
}

// === Docs JSON → Markdown ===

export function docsToMarkdown(doc: DocsDocument): string {
  const lines: string[] = [];

  for (const element of doc.body.content) {
    if (!element.paragraph) continue;
    const para = element.paragraph;

    const styleType = para.paragraphStyle?.namedStyleType ?? 'NORMAL_TEXT';
    const headingMatch = /^HEADING_(\d)$/.exec(styleType);
    const headingLevel = headingMatch ? parseInt(headingMatch[1]!, 10) : 0;

    let lineText = '';
    for (const el of para.elements) {
      if (!el.textRun) continue;
      const run = el.textRun;
      let text = run.content;
      if (text.endsWith('\n')) text = text.slice(0, -1);
      if (!text) continue;

      if (run.textStyle?.bold && run.textStyle?.italic) {
        text = `***${text}***`;
      } else if (run.textStyle?.bold) {
        text = `**${text}**`;
      } else if (run.textStyle?.italic) {
        text = `*${text}*`;
      }
      if (run.textStyle?.strikethrough) text = `~~${text}~~`;
      if (run.textStyle?.link?.url) text = `[${text}](${run.textStyle.link.url})`;
      lineText += text;
    }

    if (headingLevel > 0) lineText = '#'.repeat(headingLevel) + ' ' + lineText;
    lines.push(lineText);
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// === Markdown → HTML (for Google Docs import) ===

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Convert inline markdown formatting to HTML.
 * Handles: bold+italic, bold, italic, strikethrough, inline code, links.
 */
function inlineToHtml(text: string): string {
  return text
    // Links: [text](url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    // Bold+Italic: ***text***
    .replace(/\*{3}(.+?)\*{3}/g, '<strong><em>$1</em></strong>')
    // Bold: **text**
    .replace(/\*{2}(.+?)\*{2}/g, '<strong>$1</strong>')
    // Italic: *text*
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, '<s>$1</s>')
    // Inline code: `text`
    .replace(/`([^`]+)`/g, '<code style="background-color:#f0f0f0;font-family:Courier New,monospace;padding:1px 4px">$1</code>');
}

/**
 * Convert markdown to HTML suitable for Google Docs import.
 * Google's HTML→Docs converter handles tables, lists, headings, etc. natively.
 */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let inList: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let inTable = false;

  const closeList = () => {
    if (inList) { html.push(`</${inList}>`); inList = null; }
  };
  const closeBlockquote = () => {
    if (inBlockquote) { html.push('</blockquote>'); inBlockquote = false; }
  };
  const closeTable = () => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
    }
  };

  for (const line of lines) {
    // Code block fence
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        closeList(); closeBlockquote(); closeTable();
        inCodeBlock = true;
        codeLines = [];
        continue;
      } else {
        inCodeBlock = false;
        html.push(`<pre style="background-color:#f5f5f5;padding:12px;font-family:Courier New,monospace;font-size:10pt;border:1px solid #e0e0e0;border-radius:4px">${escapeHtml(codeLines.join('\n'))}</pre>`);
        continue;
      }
    }
    if (inCodeBlock) { codeLines.push(line); continue; }

    // Table row
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());

      // Separator row
      if (cells.every(c => /^[-:]+$/.test(c))) {
        continue;
      }

      closeList(); closeBlockquote();

      if (!inTable) {
        // Header row
        inTable = true;
        html.push('<table style="border-collapse:collapse;width:100%">');
        html.push('<thead><tr>');
        for (const cell of cells) {
          html.push(`<th style="border:1px solid #ccc;padding:8px;background-color:#f5f5f5;font-weight:bold;text-align:left">${inlineToHtml(escapeHtml(cell))}</th>`);
        }
        html.push('</tr></thead><tbody>');
        continue;
      }

      // Data row
      html.push('<tr>');
      for (const cell of cells) {
        html.push(`<td style="border:1px solid #ccc;padding:8px">${inlineToHtml(escapeHtml(cell))}</td>`);
      }
      html.push('</tr>');
      continue;
    }

    // Non-table line — close table if open
    if (inTable) closeTable();

    // Empty line
    if (!line.trim()) {
      closeList(); closeBlockquote();
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      closeList(); closeBlockquote();
      html.push('<hr style="border:none;border-top:1px solid #ccc;margin:16px 0">');
      continue;
    }

    // Heading
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      closeList(); closeBlockquote();
      const level = headingMatch[1]!.length;
      html.push(`<h${level}>${inlineToHtml(escapeHtml(headingMatch[2]!))}</h${level}>`);
      continue;
    }

    // Blockquote
    const bqMatch = /^>\s?(.*)$/.exec(line);
    if (bqMatch) {
      closeList();
      if (!inBlockquote) {
        html.push('<blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#555;margin:8px 0">');
        inBlockquote = true;
      }
      const content = bqMatch[1] ?? '';
      if (content.trim()) html.push(`<p>${inlineToHtml(escapeHtml(content))}</p>`);
      continue;
    }
    if (inBlockquote) closeBlockquote();

    // Unordered list
    const ulMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (inList !== 'ul') { closeList(); html.push('<ul>'); inList = 'ul'; }
      html.push(`<li>${inlineToHtml(escapeHtml(ulMatch[2]!))}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (olMatch) {
      if (inList !== 'ol') { closeList(); html.push('<ol>'); inList = 'ol'; }
      html.push(`<li>${inlineToHtml(escapeHtml(olMatch[2]!))}</li>`);
      continue;
    }

    // Regular paragraph
    closeList();
    html.push(`<p>${inlineToHtml(escapeHtml(line))}</p>`);
  }

  // Close unclosed blocks
  if (inCodeBlock && codeLines.length > 0) {
    html.push(`<pre style="background-color:#f5f5f5;padding:12px;font-family:Courier New,monospace;font-size:10pt">${escapeHtml(codeLines.join('\n'))}</pre>`);
  }
  closeList();
  closeBlockquote();
  closeTable();

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;font-size:11pt">${html.join('\n')}</body></html>`;
}
