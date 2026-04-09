import { BOLD, DIM, ITALIC, UNDERLINE, STRIKETHROUGH, BLUE, CYAN, MAGENTA, GRAY, RESET, stripAnsi, TBL } from './ansi.js';

function renderTable(headers: string[], rows: string[][]): string {
  const colCount = headers.length;
  const widths: number[] = headers.map(h => stripAnsi(h).length);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? '';
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    }
  }

  const hBorder = (l: string, m: string, r: string) =>
    l + widths.map(w => TBL.h.repeat((w ?? 0) + 2)).join(m) + r + '\n';

  const dataRow = (cells: string[], bold = false) => {
    const parts = cells.map((c, i) => {
      const w = widths[i] ?? 0;
      const pad = Math.max(0, w - stripAnsi(c).length);
      const content = bold ? `${BOLD}${c}${RESET}` : c;
      return ` ${content}${' '.repeat(pad)} `;
    });
    return `${GRAY}${TBL.v}${RESET}${parts.join(`${GRAY}${TBL.v}${RESET}`)}${GRAY}${TBL.v}${RESET}\n`;
  };

  let out = `${GRAY}${hBorder(TBL.tl, TBL.tm, TBL.tr)}${RESET}`;
  out += dataRow(headers, true);
  out += `${GRAY}${hBorder(TBL.lm, TBL.cr, TBL.rm)}${RESET}`;
  for (const row of rows) {
    const padded = Array.from({ length: colCount }, (_, i) => row[i] ?? '');
    out += dataRow(padded);
  }
  out += `${GRAY}${hBorder(TBL.bl, TBL.bm, TBL.br)}${RESET}`;
  return out;
}

export class MarkdownStreamer {
  private inBold = false;
  private inItalic = false;
  private inCode = false;
  private inCodeBlock = false;
  private inStrikethrough = false;
  private inTable = false;
  private tableLines: string[] = [];
  private buffer = '';
  private lineStart = true;
  private lastWasBlank = false;
  private codeLanguage = '';

  push(chunk: string): string {
    this.buffer += chunk;
    let out = '';

    while (this.buffer.length > 0) {
      // Code block fence
      if (this.buffer.startsWith('```')) {
        if (this.inCodeBlock) {
          this.inCodeBlock = false;
          out += RESET;
          this.buffer = this.buffer.slice(3);
          const nl = this.buffer.indexOf('\n');
          if (nl !== -1) {
            this.buffer = this.buffer.slice(nl + 1);
          } else {
            this.buffer = '';
          }
          this.codeLanguage = '';
          this.lineStart = true;
          continue;
        }
        this.inCodeBlock = true;
        this.buffer = this.buffer.slice(3);
        // Capture language tag
        const nl = this.buffer.indexOf('\n');
        if (nl !== -1) {
          this.codeLanguage = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (this.codeLanguage) {
            out += `${GRAY}[${this.codeLanguage}]${RESET}\n`;
          }
          out += DIM;
        } else if (this.buffer.length > 20) {
          this.codeLanguage = this.buffer.trim();
          if (this.codeLanguage) {
            out += `${GRAY}[${this.codeLanguage}]${RESET}\n`;
          }
          out += DIM;
          this.buffer = '';
        } else {
          break;
        }
        continue;
      }

      if (this.inCodeBlock) {
        // Look for closing fence on its own line
        const fenceIdx = this.buffer.indexOf('\n```');
        if (fenceIdx !== -1) {
          // Output content up to and including the newline before fence
          out += this.buffer.slice(0, fenceIdx + 1);
          this.buffer = this.buffer.slice(fenceIdx + 1);
          // Let the loop handle the closing ``` at buffer start
          continue;
        }
        // No closing fence found — output all but keep last 3 chars
        // in case a partial ``` is at the end
        if (this.buffer.length > 3) {
          out += this.buffer.slice(0, -3);
          this.buffer = this.buffer.slice(-3);
        }
        break;
      }

      // Inline code
      if (this.buffer[0] === '`') {
        if (this.inCode) {
          this.inCode = false;
          out += RESET;
          this.buffer = this.buffer.slice(1);
          continue;
        }
        this.inCode = true;
        out += BLUE;
        this.buffer = this.buffer.slice(1);
        continue;
      }

      if (this.inCode) {
        out += this.buffer[0];
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Line-start features (must be checked before inline formatting)
      if (this.lineStart) {
        // Table handling: buffer lines starting with |
        if (this.buffer[0] === '|') {
          const nl = this.buffer.indexOf('\n');
          if (nl === -1) break; // wait for full line
          this.inTable = true;
          this.tableLines.push(this.buffer.slice(0, nl));
          this.buffer = this.buffer.slice(nl + 1);
          this.lineStart = true;
          continue;
        }

        // Flush table when we hit a non-table line
        if (this.inTable) {
          out += this.flushTable();
        }

        // Horizontal rule: ---, ***, ___ (must check before bold/italic)
        if (/^(---+|\*\*\*+|___+)\s*\n/.test(this.buffer)) {
          const nl = this.buffer.indexOf('\n');
          out += `${GRAY}${'─'.repeat(40)}${RESET}\n`;
          this.buffer = this.buffer.slice(nl + 1);
          this.lineStart = true;
          continue;
        }
        // Wait for more data for potential HR
        if (/^(---?|\*\*\*?|___?)$/.test(this.buffer)) {
          break;
        }

        // Blockquote: > text
        if (this.buffer[0] === '>') {
          const match = this.buffer.match(/^>\s?/);
          if (match) {
            out += `${GRAY}▎${RESET} `;
            this.buffer = this.buffer.slice(match[0].length);
            this.lineStart = false;
            continue;
          }
        }

        // Unordered list: - item, * item, + item (with optional leading whitespace)
        const ulMatch = this.buffer.match(/^([ \t]*)[*+-] /);
        if (ulMatch && this.buffer.length > ulMatch[0].length) {
          const indent = ulMatch[1]!;
          const depth = Math.floor(indent.length / 2);
          out += `${'  '.repeat(depth)}  ${BLUE}•${RESET} `;
          this.buffer = this.buffer.slice(ulMatch[0].length);
          this.lineStart = false;
          continue;
        }
        // Wait for more data to distinguish UL from other markers
        if (/^([ \t]*)[*+-] $/.test(this.buffer)) {
          break;
        }

        // Ordered list: 1. item (with optional leading whitespace)
        const olMatch = this.buffer.match(/^([ \t]*)(\d+)\. /);
        if (olMatch && olMatch[2] && this.buffer.length > olMatch[0].length) {
          const indent = olMatch[1]!;
          const depth = Math.floor(indent.length / 2);
          out += `${'  '.repeat(depth)}  ${DIM}${olMatch[2]}.${RESET} `;
          this.buffer = this.buffer.slice(olMatch[0].length);
          this.lineStart = false;
          continue;
        }
        // Wait for more data for potential OL
        if (/^([ \t]*)\d+\.\s?$/.test(this.buffer)) {
          break;
        }

        // Header at line start
        if (this.buffer[0] === '#') {
          const match = this.buffer.match(/^(#{1,6})\s+/);
          if (match) {
            const level = match[1]!.length;
            const nl = this.buffer.indexOf('\n');
            if (nl !== -1) {
              // Extract header text, process inline formatting, then wrap with header style
              const rawText = this.buffer.slice(match[0].length, nl);
              out += this.renderHeader(this.processInline(rawText), level);
              this.buffer = this.buffer.slice(nl);
              continue;
            }
            // No newline yet — might be streaming, wait for more
            if (this.buffer.length < 80) break;
            const rawText = this.buffer.slice(match[0].length);
            out += this.renderHeader(this.processInline(rawText), level);
            this.buffer = '';
            break;
          }
        }
      } else if (this.inTable) {
        // We were in a table but lineStart is false — shouldn't happen,
        // but flush just in case
        out += this.flushTable();
      }

      // Strikethrough ~~
      if (this.buffer.startsWith('~~')) {
        if (this.inStrikethrough) {
          this.inStrikethrough = false;
          out += RESET;
        } else {
          this.inStrikethrough = true;
          out += STRIKETHROUGH;
        }
        this.buffer = this.buffer.slice(2);
        continue;
      }
      // Ambiguous single ~ at end of buffer
      if (this.buffer === '~') {
        break;
      }

      // Link: [text](url)
      if (this.buffer[0] === '[') {
        const linkMatch = this.buffer.match(/^\[([^\]]*)\]\(([^)]*)\)/);
        if (linkMatch && linkMatch[1] !== undefined && linkMatch[2] !== undefined) {
          out += `${UNDERLINE}${linkMatch[1]}${RESET}${GRAY} (${linkMatch[2]})${RESET}`;
          this.buffer = this.buffer.slice(linkMatch[0].length);
          continue;
        }
        // Could be partial — wait if buffer is short and contains no closing
        if (this.buffer.indexOf(']') === -1 && this.buffer.length < 100) {
          break;
        }
        // Not a link, output the [
        out += '[';
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Bold+italic ***
      if (this.buffer.startsWith('***')) {
        if (this.inBold && this.inItalic) {
          this.inBold = false;
          this.inItalic = false;
          out += RESET;
        } else {
          this.inBold = true;
          this.inItalic = true;
          out += BOLD + ITALIC;
        }
        this.buffer = this.buffer.slice(3);
        continue;
      }

      // Bold **
      if (this.buffer.startsWith('**')) {
        if (this.inBold) {
          this.inBold = false;
          out += RESET;
          if (this.inItalic) out += ITALIC;
        } else {
          this.inBold = true;
          out += BOLD;
        }
        this.buffer = this.buffer.slice(2);
        continue;
      }

      // Italic * — closing: any *, opening: * followed by non-space
      if (this.buffer[0] === '*' && this.buffer[1] !== '*') {
        if (this.inItalic) {
          this.inItalic = false;
          out += RESET;
          if (this.inBold) out += BOLD;
          this.buffer = this.buffer.slice(1);
          continue;
        }
        if (this.buffer.length > 1 && this.buffer[1] !== ' ') {
          this.inItalic = true;
          out += ITALIC;
          this.buffer = this.buffer.slice(1);
          continue;
        }
      }

      // Ambiguous single * at end of buffer — wait for more
      if (this.buffer === '*') {
        break;
      }

      // Regular character
      const ch = this.buffer[0]!;
      if (ch === '\n') {
        this.lineStart = true;
        this.lastWasBlank = this.buffer.length > 1 && this.buffer[1] === '\n';
      } else {
        this.lineStart = false;
      }
      out += ch;
      this.buffer = this.buffer.slice(1);
    }

    return out;
  }

  /** Process inline formatting in a complete string (used for headers) */
  private processInline(text: string): string {
    let out = '';
    let i = 0;
    while (i < text.length) {
      // Inline code
      if (text[i] === '`') {
        const end = text.indexOf('`', i + 1);
        if (end !== -1) {
          out += `${BLUE}${text.slice(i + 1, end)}${RESET}`;
          i = end + 1;
          continue;
        }
      }
      // Strikethrough
      if (text[i] === '~' && text[i + 1] === '~') {
        const end = text.indexOf('~~', i + 2);
        if (end !== -1) {
          out += `${STRIKETHROUGH}${text.slice(i + 2, end)}${RESET}`;
          i = end + 2;
          continue;
        }
      }
      // Bold+italic ***
      if (text[i] === '*' && text[i + 1] === '*' && text[i + 2] === '*') {
        const end = text.indexOf('***', i + 3);
        if (end !== -1) {
          out += `${BOLD}${ITALIC}${text.slice(i + 3, end)}${RESET}`;
          i = end + 3;
          continue;
        }
      }
      // Bold **
      if (text[i] === '*' && text[i + 1] === '*') {
        const end = text.indexOf('**', i + 2);
        if (end !== -1) {
          out += `${BOLD}${text.slice(i + 2, end)}${RESET}`;
          i = end + 2;
          continue;
        }
      }
      // Italic *
      if (text[i] === '*' && text[i + 1] !== ' ') {
        const end = text.indexOf('*', i + 1);
        if (end !== -1) {
          out += `${ITALIC}${text.slice(i + 1, end)}${RESET}`;
          i = end + 1;
          continue;
        }
      }
      // Link [text](url)
      if (text[i] === '[') {
        const match = text.slice(i).match(/^\[([^\]]*)\]\(([^)]*)\)/);
        if (match && match[1] !== undefined && match[2] !== undefined) {
          out += `${UNDERLINE}${match[1]}${RESET}${GRAY} (${match[2]})${RESET}`;
          i += match[0].length;
          continue;
        }
      }
      out += text[i];
      i++;
    }
    return out;
  }

  private flushTable(): string {
    const lines = this.tableLines;
    this.tableLines = [];
    this.inTable = false;

    if (lines.length === 0) return '';

    const parseLine = (line: string): string[] =>
      line.split('|').slice(1, -1).map(c => c.trim());

    // Detect and skip separator line (|---|---|...)
    const isSeparator = (line: string): boolean =>
      /^\|[\s:]*-+[\s:]*(\|[\s:]*-+[\s:]*)*\|?\s*$/.test(line);

    const dataLines = lines.filter(l => !isSeparator(l));
    if (dataLines.length === 0) return lines.join('\n') + '\n';

    const headers = parseLine(dataLines[0]!);
    const rows = dataLines.slice(1).map(parseLine);

    return renderTable(headers, rows);
  }

  private renderHeader(text: string, level: number): string {
    switch (level) {
      case 1:
        return `${BOLD}${MAGENTA}${UNDERLINE}${text}${RESET}`;
      case 2:
        return `${BOLD}${CYAN}${text}${RESET}`;
      case 3:
        return `${BOLD}${text}${RESET}`;
      default:
        return `${DIM}${BOLD}${text}${RESET}`;
    }
  }

  flush(): string {
    let out = '';
    // Handle incomplete table line in buffer (no trailing newline)
    if (this.inTable && this.buffer.startsWith('|')) {
      this.tableLines.push(this.buffer);
      this.buffer = '';
    }
    if (this.inTable) {
      out += this.flushTable();
    }
    const remaining = this.buffer;
    this.buffer = '';
    if (this.inBold || this.inItalic || this.inCode || this.inCodeBlock || this.inStrikethrough) {
      return out + remaining + RESET;
    }
    return out + remaining;
  }

  reset(): void {
    this.inBold = false;
    this.inItalic = false;
    this.inCode = false;
    this.inCodeBlock = false;
    this.inStrikethrough = false;
    this.inTable = false;
    this.tableLines = [];
    this.buffer = '';
    this.lineStart = true;
    this.lastWasBlank = false;
    this.codeLanguage = '';
  }
}
