// === Telegram Formatter ===
// Pure functions: markdown to HTML, message splitting, inline keyboards.
// Telegram Bot API supports a subset of HTML: <b>, <i>, <code>, <pre>, <a>, <blockquote>.

import { t, friendlyToolName, type Lang } from './telegram-i18n.js';

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface FollowUpSuggestion {
  label: string;
  task: string;
}

export interface PendingTool {
  name: string;
  inputPreview: string;
  success?: boolean | undefined;
  resultPreview?: string | undefined;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Business-friendly error messages
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: Array<{ match: (m: string) => boolean; en: string; de: string }> = [
  { match: m => m.includes('ENOENT'), en: 'File or folder not found.', de: 'Datei oder Ordner nicht gefunden.' },
  { match: m => m.includes('EACCES') || m.includes('EPERM'), en: 'Permission denied \u2014 cannot access that resource.', de: 'Zugriff verweigert \u2014 auf diese Ressource kann nicht zugegriffen werden.' },
  { match: m => m.includes('ETIMEDOUT') || m.includes('ETIME'), en: 'The request timed out. The server may be slow or unreachable.', de: 'Zeit\u00FCberschreitung. Der Server ist m\u00F6glicherweise langsam oder nicht erreichbar.' },
  { match: m => m.includes('ECONNREFUSED'), en: 'Connection refused \u2014 the server is not responding.', de: 'Verbindung abgelehnt \u2014 der Server antwortet nicht.' },
  { match: m => m.includes('ECONNRESET'), en: 'The connection was interrupted. Please try again.', de: 'Die Verbindung wurde unterbrochen. Bitte versuche es erneut.' },
  { match: m => m.includes('401') || m.includes('Unauthorized'), en: 'Authentication failed \u2014 check your credentials.', de: 'Authentifizierung fehlgeschlagen \u2014 pr\u00FCfe deine Zugangsdaten.' },
  { match: m => m.includes('403') || m.includes('Forbidden'), en: 'Access denied \u2014 you don\'t have permission for this.', de: 'Zugriff verweigert \u2014 du hast keine Berechtigung daf\u00FCr.' },
  { match: m => /\b429\b/.test(m) || m.includes('Too Many Requests'), en: 'Too many requests \u2014 please wait a moment and try again.', de: 'Zu viele Anfragen \u2014 bitte warte einen Moment und versuche es erneut.' },
  { match: m => /\b50[0-3]\b/.test(m) || m.includes('Internal Server Error') || m.includes('Bad Gateway') || m.includes('Service Unavailable'), en: 'The server encountered an error. Please try again later.', de: 'Der Server hat einen Fehler gemeldet. Bitte versuche es sp\u00E4ter erneut.' },
  { match: m => m.includes('ENOSPC'), en: 'Storage is full \u2014 free up disk space.', de: 'Speicher voll \u2014 bitte Speicherplatz freigeben.' },
];

/** Translate technical error messages to business-friendly language. */
export function friendlyError(message: string, lang: Lang = 'en'): string {
  for (const p of ERROR_PATTERNS) {
    if (p.match(message)) return lang === 'de' ? p.de : p.en;
  }
  // Sanitize unmatched errors: strip IP addresses, file paths, and stack traces
  // to prevent leaking internal details to Telegram users
  const sanitized = message
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, '[internal]')
    .replace(/\/[^\s:]+\.(ts|js|json|mjs)/g, '[path]')
    .replace(/at\s+\S+\s+\([^)]+\)/g, '')
    .replace(/\n\s+at\s+.*/g, '')
    .trim();
  // Cap length to avoid leaking verbose error details
  return sanitized.length > 200 ? sanitized.slice(0, 200) + '…' : sanitized;
}

// ---------------------------------------------------------------------------
// Table detection and rendering (reused from slack-formatter pattern)
// ---------------------------------------------------------------------------

function isTableCandidate(line: string): boolean {
  const stripped = line.trim();
  if (!stripped) return false;
  if (stripped.startsWith('>')) return false;
  return (stripped.split('|').length - 1) >= 2;
}

function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim());
}

function findTableEnd(lines: string[], start: number): number | null {
  let end = start;
  let hasSeparator = false;
  while (end < lines.length) {
    if (!isTableCandidate(lines[end]!)) break;
    if (isTableSeparator(lines[end]!)) hasSeparator = true;
    end++;
  }
  return (end - start >= 2 && hasSeparator) ? end : null;
}

function parseTableRow(line: string): string[] {
  return line.split('|').map(c => c.trim()).filter(c => c.length > 0);
}

function stripCellMarkdown(cell: string): string {
  return cell
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

function formatTableAsHtml(tableLines: string[]): string {
  const dataRows: string[][] = [];
  for (const line of tableLines) {
    if (isTableSeparator(line)) continue;
    const cells = parseTableRow(line);
    if (cells.length > 0) dataRows.push(cells.map(stripCellMarkdown));
  }
  if (dataRows.length === 0) return '';

  const colCount = Math.max(...dataRows.map(r => r.length));
  const widths: number[] = Array.from({ length: colCount }, () => 0);
  for (const row of dataRows) {
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(widths[c]!, (row[c] ?? '').length);
    }
  }

  const lines: string[] = [];
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r]!;
    const padded = widths.map((w, c) => escapeHtml(row[c] ?? '').padEnd(w));
    lines.push(padded.join('  '));
    if (r === 0 && dataRows.length > 1) {
      lines.push(widths.map(w => '\u2500'.repeat(w)).join('\u2500\u2500'));
    }
  }

  return `<pre>${lines.join('\n')}</pre>`;
}

// ---------------------------------------------------------------------------
// Markdown to Telegram HTML
// ---------------------------------------------------------------------------

export function markdownToTelegramHtml(md: string): string {
  if (!md) return md;

  let text = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split on code fences -- preserve them, convert everything else
  const parts = text.split(/(^```[^\n]*\n[\s\S]*?\n^```)/m);
  const out: string[] = [];

  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('```')) {
      // Extract language and code content
      const match = /^```(\w*)\n([\s\S]*?)\n```$/.exec(part);
      if (match) {
        const lang = match[1];
        const code = escapeHtml(match[2]!);
        out.push(lang
          ? `<pre><code class="language-${escapeHtml(lang)}">${code}</code></pre>`
          : `<pre>${code}</pre>`);
      } else {
        out.push(`<pre>${escapeHtml(part.replace(/^```\w*\n?/, '').replace(/\n?```$/, ''))}</pre>`);
      }
    } else {
      out.push(convertTextBlock(part));
    }
  }

  return out.join('');
}

function convertTextBlock(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const tableEnd = findTableEnd(lines, i);
    if (tableEnd !== null) {
      result.push(formatTableAsHtml(lines.slice(i, tableEnd)));
      i = tableEnd;
      continue;
    }
    result.push(convertLine(lines[i]!));
    i++;
  }

  return result.join('\n');
}

function convertLine(line: string): string {
  // Headers: bold uppercase
  const header = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
  if (header) {
    return `<b>${escapeHtml(header[2]!.trim()).toUpperCase()}</b>`;
  }

  // Horizontal rules: simple separator
  if (/^\s*[-*_]\s*[-*_]\s*[-*_][-_\s*]*$/.test(line)) {
    return '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501';
  }

  // Blockquotes
  const blockquote = /^>\s?(.*)$/.exec(line);
  if (blockquote) {
    return `<blockquote>${escapeHtml(blockquote[1]!)}</blockquote>`;
  }

  let s = line;

  // Protect inline code from other transformations
  const inlineCodes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
    const token = `\x00CODE${inlineCodes.length}\x00`;
    inlineCodes.push(inner);
    return token;
  });

  // Escape HTML in the rest
  s = escapeHtml(s);

  // Bold: **text** or __text__
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');

  // Italic: *text* or _text_
  s = s.replace(/(?<!\*)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, '<i>$1</i>');
  s = s.replace(/(?<!_)_(?!\s)([^_\n]+?)(?<!\s)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // Links: [text](url) -- must happen after HTML escaping
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) =>
    `<a href="${escapeHtml(url)}">${text}</a>`);

  // Restore inline code as <code>
  for (let idx = 0; idx < inlineCodes.length; idx++) {
    s = s.replace(`\x00CODE${idx}\x00`, `<code>${escapeHtml(inlineCodes[idx]!)}</code>`);
  }

  return s;
}

// ---------------------------------------------------------------------------
// Message splitting
// ---------------------------------------------------------------------------

const TELEGRAM_MAX_LENGTH = 4096;

export function splitMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const messages: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = -1;

    // Try to split at paragraph boundary
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLen);
    if (paragraphBreak > maxLen * 0.3) {
      splitAt = paragraphBreak;
    }

    // Try to split at line break
    if (splitAt === -1) {
      const lineBreak = remaining.lastIndexOf('\n', maxLen);
      if (lineBreak > maxLen * 0.3) {
        splitAt = lineBreak;
      }
    }

    // Hard split at maxLen
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    // Check if we are inside a <pre> block -- if so, close and reopen it
    const chunk = remaining.slice(0, splitAt);
    const openPre = (chunk.match(/<pre/g) ?? []).length;
    const closePre = (chunk.match(/<\/pre>/g) ?? []).length;

    if (openPre > closePre) {
      messages.push(chunk + '</pre>');
      remaining = '<pre>' + remaining.slice(splitAt).replace(/^\n+/, '');
    } else {
      messages.push(chunk);
      remaining = remaining.slice(splitAt).replace(/^\n+/, '');
    }
  }

  if (remaining.trim()) {
    messages.push(remaining);
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Status formatting
// ---------------------------------------------------------------------------

export function formatStatus(
  status: 'thinking' | 'working' | 'done' | 'error' | 'stopped',
  elapsed?: number | undefined,
  toolCount?: number | undefined,
  lang: Lang = 'en',
): string {
  const emoji: Record<string, string> = {
    thinking: '\uD83D\uDD35',
    working: '\uD83D\uDFE1',
    done: '\uD83D\uDFE2',
    error: '\uD83D\uDD34',
    stopped: '\uD83D\uDED1',
  };

  const parts = [`${emoji[status]} <b>${t(`status.${status}`, lang)}</b>`];
  if (elapsed !== undefined) {
    parts.push(`${(elapsed / 1000).toFixed(1)}s`);
  }
  if (toolCount) {
    const unit = t(toolCount > 1 ? 'status.tools_many' : 'status.tools_one', lang);
    parts.push(`${toolCount} ${unit}`);
  }
  return parts.join(' \u00B7 ');
}

// ---------------------------------------------------------------------------
// Tool group formatting
// ---------------------------------------------------------------------------

export function formatToolGroup(
  tools: Array<{ name: string; resultPreview?: string | undefined }>,
): string {
  if (tools.length === 0) return '';

  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

  const parts = [...counts.entries()].map(([name, count]) =>
    count > 1 ? `\u26A1 ${escapeHtml(name)} \u00D7${count}` : `\u26A1 ${escapeHtml(name)}`,
  );
  return parts.join('  \u00B7  ');
}

// ---------------------------------------------------------------------------
// Inline keyboards
// ---------------------------------------------------------------------------

export function buildAnswerKeyboard(options: string[]): InlineKeyboardMarkup {
  const buttons = options.map(opt => ({
    text: opt,
    callback_data: JSON.stringify({ t: 'a', v: opt }),
  }));

  // Add Stop button (always English label — callback_data is language-independent)
  buttons.push({
    text: '\uD83D\uDED1 Stop',
    callback_data: JSON.stringify({ t: 's' }),
  });

  // Arrange in rows of 2-3 buttons
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  const maxPerRow = buttons.length <= 4 ? 2 : 3;
  for (let i = 0; i < buttons.length; i += maxPerRow) {
    rows.push(buttons.slice(i, i + maxPerRow));
  }

  return { inline_keyboard: rows };
}

export function buildStopKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{
      text: '\uD83D\uDED1 Stop',
      callback_data: JSON.stringify({ t: 's' }),
    }]],
  };
}

// ---------------------------------------------------------------------------
// Detailed output: thinking summary
// ---------------------------------------------------------------------------

export function formatThinkingSummary(summary: string): string {
  const MAX_LEN = 200;
  const trimmed = summary.length > MAX_LEN ? summary.slice(0, MAX_LEN) + '…' : summary;
  return `💭 <i>${escapeHtml(trimmed)}</i>`;
}

// ---------------------------------------------------------------------------
// Rich status message (progressive edits — thinking + tool details in one msg)
// ---------------------------------------------------------------------------

const MAX_VISIBLE_TOOLS = 6;

export function buildRichStatus(
  headerOverride: string | undefined,
  status: 'thinking' | 'working' | 'done' | 'error' | 'stopped',
  elapsed: number,
  toolCount: number,
  thinkingSummary: string,
  trackedTools: PendingTool[],
  lang: Lang = 'en',
): string {
  const header = headerOverride ?? formatStatus(status, elapsed, toolCount || undefined, lang);
  const lines = [header];

  // Thinking summary — only shown while still thinking (before tools)
  if (thinkingSummary && trackedTools.length === 0) {
    lines.push(formatThinkingSummary(thinkingSummary));
  }

  // Tool list (cap at MAX_VISIBLE_TOOLS to stay within 4096 char limit)
  if (trackedTools.length > MAX_VISIBLE_TOOLS) {
    const hidden = trackedTools.length - MAX_VISIBLE_TOOLS;
    const unit = t(hidden > 1 ? 'status.earlier_many' : 'status.earlier_one', lang);
    lines.push(`<i>… ${hidden} ${unit}</i>`);
  }
  const visible = trackedTools.slice(-MAX_VISIBLE_TOOLS);
  for (const tool of visible) {
    const icon = tool.success === undefined ? '⏳' : tool.success ? '✅' : '❌';
    const preview = tool.inputPreview
      ? ` — <code>${escapeHtml(tool.inputPreview.slice(0, 50))}</code>`
      : '';
    lines.push(`${icon} ${escapeHtml(friendlyToolName(tool.name, lang))}${preview}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Detailed output: tool input preview
// ---------------------------------------------------------------------------

export function toolInputPreview(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return String(input ?? '');
  const obj = input as Record<string, unknown>;
  switch (name) {
    case 'bash': {
      if (typeof obj['command'] !== 'string') return '';
      const lines = (obj['command'] as string).split('\n');
      const firstCmd = lines.find(l => l.trim() && !l.trim().startsWith('#'));
      return firstCmd?.trim() ?? lines[0]?.trim() ?? '';
    }
    case 'read_file':
    case 'write_file':
      return typeof obj['path'] === 'string' ? obj['path'] : '';
    case 'http_request':
      return typeof obj['url'] === 'string' ? `${String(obj['method'] ?? 'GET')} ${obj['url']}` : '';
    case 'memory_store':
      return typeof obj['content'] === 'string'
        ? `${String(obj['namespace'] ?? '')} — ${(obj['content'] as string).slice(0, 60)}`
        : String(obj['namespace'] ?? '');
    case 'memory_recall':
    case 'memory_list':
      return String(obj['namespace'] ?? obj['scope'] ?? '');
    case 'spawn_agent': {
      const agents = Array.isArray(obj['agents']) ? obj['agents'] as Record<string, unknown>[] : [];
      if (agents.length === 0) return '';
      const names = agents.map(a => String(a['name'] ?? a['task'] ?? '')).filter(Boolean);
      return names.length > 0
        ? `${agents.length} role${agents.length > 1 ? 's' : ''}: ${names.join(', ').slice(0, 80)}`
        : `${agents.length} role${agents.length > 1 ? 's' : ''}`;
    }
    case 'ask_user':
      return typeof obj['question'] === 'string' ? (obj['question'] as string).slice(0, 80) : '';
    case 'run_pipeline':
      return String(obj['name'] ?? obj['pipeline_id'] ?? '');
    case 'task_create':
      return typeof obj['title'] === 'string' ? (obj['title'] as string).slice(0, 80) : '';
    default: {
      const first = Object.entries(obj).find(([, v]) => typeof v === 'string');
      return first ? (first[1] as string).slice(0, 80) : '';
    }
  }
}

// ---------------------------------------------------------------------------
// Detailed output: follow-up suggestions (agent-generated)
// ---------------------------------------------------------------------------

const FOLLOW_UP_RE = /<follow_ups>\s*([\s\S]*?)\s*<\/follow_ups>/;
const MAX_FOLLOW_UPS = 4;
const MAX_LABEL_LENGTH = 24;

export interface ParsedFollowUps {
  suggestions: FollowUpSuggestion[];
  cleanText: string;
}

/**
 * Extract agent-generated follow-up suggestions from the response text.
 * The agent includes a `<follow_ups>[...]</follow_ups>` block at the end.
 * Returns parsed suggestions + response text with the block stripped.
 */
export function parseFollowUps(responseText: string): ParsedFollowUps {
  const match = FOLLOW_UP_RE.exec(responseText);
  if (!match) return { suggestions: [], cleanText: responseText };

  const cleanText = responseText.replace(FOLLOW_UP_RE, '').trimEnd();
  let suggestions: FollowUpSuggestion[] = [];

  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(parsed)) return { suggestions: [], cleanText };

    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj['label'] !== 'string' || typeof obj['task'] !== 'string') continue;
      if (!obj['label'].trim() || !obj['task'].trim()) continue;
      suggestions.push({
        label: obj['label'].trim().slice(0, MAX_LABEL_LENGTH),
        task: obj['task'].trim(),
      });
    }
  } catch {
    return { suggestions: [], cleanText };
  }

  // Deduplicate by label
  const seen = new Set<string>();
  suggestions = suggestions.filter(s => {
    if (seen.has(s.label)) return false;
    seen.add(s.label);
    return true;
  });

  return { suggestions: suggestions.slice(0, MAX_FOLLOW_UPS), cleanText };
}

/**
 * Minimal fallback follow-ups for error/abort cases where the agent
 * didn't produce a response (and thus no `<follow_ups>` block).
 */
export function fallbackFollowUps(
  originalTask: string,
  lang: Lang = 'en',
  error?: string | undefined,
): FollowUpSuggestion[] {
  const retryLabel = t('followup.retry', lang);
  const suggestions: FollowUpSuggestion[] = [
    { label: retryLabel, task: originalTask },
  ];
  if (error) {
    const explainLabel = t('followup.explain', lang);
    suggestions.push({
      label: explainLabel,
      task: `Explain what went wrong and suggest a fix. The error was: ${error}`,
    });
  }
  return suggestions;
}

// ---------------------------------------------------------------------------
// Detailed output: follow-up inline keyboard
// ---------------------------------------------------------------------------

export function formatFollowUpKeyboard(suggestions: FollowUpSuggestion[]): InlineKeyboardMarkup {
  const buttons = suggestions.map((s, i) => ({
    text: s.label,
    callback_data: JSON.stringify({ t: 'f', i }),
  }));

  // Arrange in rows of 2
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }

  return { inline_keyboard: rows };
}
