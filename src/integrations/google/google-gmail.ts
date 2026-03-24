import type { ToolEntry, IAgent } from '../../types/index.js';
import type { GoogleAuth } from './google-auth.js';
import { SCOPES } from './google-auth.js';
import { getErrorMessage } from '../../core/utils.js';
import { wrapUntrustedData } from '../../core/data-boundary.js';

// === Types ===

interface GmailInput {
  action: 'search' | 'read' | 'send' | 'reply' | 'draft' | 'archive' | 'mark_read' | 'labels';
  query?: string | undefined;
  message_id?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  cc?: string | undefined;
  bcc?: string | undefined;
  thread_id?: string | undefined;
  label_ids?: string[] | undefined;
  max_results?: number | undefined;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    mimeType: string;
    body?: { data?: string; size: number };
    parts?: GmailPart[];
  };
  internalDate: string;
}

interface GmailPart {
  mimeType: string;
  body?: { data?: string; size: number };
  parts?: GmailPart[];
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate: number;
}

interface GmailLabel {
  id: string;
  name: string;
  type: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

// === Constants ===

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// Actions that require user confirmation
const CONFIRM_ACTIONS = new Set(['send', 'reply', 'archive', 'draft']);

// Actions requiring write scopes
const WRITE_ACTIONS = new Set(['send', 'reply', 'draft', 'archive', 'mark_read']);

// === Helpers ===

function getHeader(headers: Array<{ name: string; value: string }>, name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function base64urlDecode(data: string): string {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function base64urlEncode(data: string): string {
  return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function extractBody(payload: GmailMessage['payload']): string {
  // Try to get plain text body
  if (payload.body?.data) {
    if (payload.mimeType === 'text/plain') {
      return base64urlDecode(payload.body.data);
    }
    if (payload.mimeType === 'text/html') {
      return stripHtml(base64urlDecode(payload.body.data));
    }
  }

  // Search parts for text/plain first, then text/html
  if (payload.parts) {
    const textPart = findPart(payload.parts, 'text/plain');
    if (textPart?.body?.data) return base64urlDecode(textPart.body.data);

    const htmlPart = findPart(payload.parts, 'text/html');
    if (htmlPart?.body?.data) return stripHtml(base64urlDecode(htmlPart.body.data));
  }

  return '(No readable body)';
}

function findPart(parts: GmailPart[], mimeType: string): GmailPart | undefined {
  for (const part of parts) {
    if (part.mimeType === mimeType) return part;
    if (part.parts) {
      const found = findPart(part.parts, mimeType);
      if (found) return found;
    }
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    // Remove content-bearing dangerous elements entirely (including hidden text)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Remove HTML comments — can hide injection payloads
    .replace(/<!--[\s\S]*?-->/g, '')
    // Remove CDATA sections
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    // Remove hidden elements (display:none, visibility:hidden, opacity:0) — can hide injection text
    .replace(/<[^>]+(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    // Strip all remaining tags
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildRfc2822(to: string, subject: string, body: string, options?: {
  cc?: string | undefined;
  bcc?: string | undefined;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  threadId?: string | undefined;
}): string {
  const lines: string[] = [];
  lines.push(`To: ${to}`);
  if (options?.cc) lines.push(`Cc: ${options.cc}`);
  if (options?.bcc) lines.push(`Bcc: ${options.bcc}`);
  lines.push(`Subject: ${subject}`);
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push('MIME-Version: 1.0');
  if (options?.inReplyTo) lines.push(`In-Reply-To: ${options.inReplyTo}`);
  if (options?.references) lines.push(`References: ${options.references}`);
  lines.push('');
  lines.push(body);
  return lines.join('\r\n');
}

function formatDate(internalDate: string): string {
  const date = new Date(parseInt(internalDate, 10));
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

async function gmailFetch(auth: GoogleAuth, path: string, options?: RequestInit): Promise<Response> {
  const token = await auth.getAccessToken();
  const url = `${GMAIL_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    signal: options?.signal ?? AbortSignal.timeout(30_000),
  });
  return response;
}

// === Tool Creation ===

export function createGmailTool(auth: GoogleAuth): ToolEntry<GmailInput> {
  return {
    definition: {
      name: 'google_gmail',
      description: 'Interact with Gmail: search emails, read messages, send/reply, create drafts, archive, manage labels. Use action "search" with a query to find emails, "read" with message_id to get full content, "send" to compose new email (requires confirmation), "reply" to respond to a thread, "draft" to save without sending, "archive" to remove from inbox, "mark_read" to mark as read, "labels" to list all labels.',
      eager_input_streaming: true,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'read', 'send', 'reply', 'draft', 'archive', 'mark_read', 'labels'],
            description: 'Gmail action to perform',
          },
          query: {
            type: 'string',
            description: 'Gmail search query (action: search). Supports Gmail search syntax: from:, to:, subject:, is:unread, after:, before:, has:attachment, etc.',
          },
          message_id: {
            type: 'string',
            description: 'Message ID (required for: read, reply, archive, mark_read)',
          },
          to: {
            type: 'string',
            description: 'Recipient email address (required for: send, reply)',
          },
          subject: {
            type: 'string',
            description: 'Email subject line (required for: send)',
          },
          body: {
            type: 'string',
            description: 'Email body text (required for: send, reply, draft)',
          },
          cc: {
            type: 'string',
            description: 'CC recipients (comma-separated)',
          },
          bcc: {
            type: 'string',
            description: 'BCC recipients (comma-separated)',
          },
          thread_id: {
            type: 'string',
            description: 'Thread ID for reply threading',
          },
          max_results: {
            type: 'number',
            description: 'Max results for search (default: 10, max: 50)',
          },
        },
        required: ['action'],
      },
    },
    handler: async (input: GmailInput, agent: IAgent): Promise<string> => {
      try {
        // Check write scope
        if (WRITE_ACTIONS.has(input.action)) {
          const writeScope = input.action === 'send' || input.action === 'reply' || input.action === 'draft'
            ? SCOPES.GMAIL_SEND
            : SCOPES.GMAIL_MODIFY;
          if (!auth.hasScope(writeScope)) {
            return `Error: This action requires additional permissions (${writeScope}). Run /google auth to grant write access.`;
          }
        }

        // Email body secret scanning — block if body contains credentials/API keys
        if ((input.action === 'send' || input.action === 'reply' || input.action === 'draft') && input.body) {
          const { detectSecretInContent } = await import('../../tools/builtin/http.js');
          const secretMatch = detectSecretInContent(input.body);
          if (secretMatch) {
            return `Blocked: email body appears to contain a ${secretMatch}. Sending secrets via email is not allowed.`;
          }
        }

        // Confirmation for destructive/external actions — fail-safe: block if no prompt available
        if (CONFIRM_ACTIONS.has(input.action) && !agent.promptUser) {
          return `Error: "${input.action}" requires user confirmation but no interactive prompt is available (autonomous/background mode). Use assistant mode for this action.`;
        }
        if (CONFIRM_ACTIONS.has(input.action) && agent.promptUser) {
          let confirmMsg = '';
          if (input.action === 'send') {
            confirmMsg = `Send email to ${input.to ?? '(no recipient)'}?\nSubject: ${input.subject ?? '(no subject)'}\nBody preview: ${(input.body ?? '').slice(0, 200)}`;
          } else if (input.action === 'reply') {
            confirmMsg = `Reply to message ${input.message_id ?? '(unknown)'}?\nBody preview: ${(input.body ?? '').slice(0, 200)}`;
          } else if (input.action === 'archive') {
            confirmMsg = `Archive message ${input.message_id ?? '(unknown)'}?`;
          } else if (input.action === 'draft') {
            confirmMsg = `Create draft email?\nTo: ${input.to ?? '(no recipient)'}\nSubject: ${input.subject ?? '(no subject)'}\nBody preview: ${(input.body ?? '').slice(0, 200)}`;
          }
          const answer = await agent.promptUser(confirmMsg, ['Yes', 'No']);
          if (answer.toLowerCase() !== 'yes' && answer !== '1') {
            return 'Action cancelled by user.';
          }
        }

        switch (input.action) {
          case 'search': return await handleSearch(auth, input);
          case 'read': return await handleRead(auth, input);
          case 'send': return await handleSend(auth, input);
          case 'reply': return await handleReply(auth, input);
          case 'draft': return await handleDraft(auth, input);
          case 'archive': return await handleArchive(auth, input);
          case 'mark_read': return await handleMarkRead(auth, input);
          case 'labels': return await handleLabels(auth);
          default: return `Error: Unknown action "${input.action}". Valid actions: search, read, send, reply, draft, archive, mark_read, labels.`;
        }
      } catch (err: unknown) {
        return `Gmail error: ${getErrorMessage(err)}`;
      }
    },
  };
}

// === Action Handlers ===

async function handleSearch(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.query) return 'Error: "query" is required for action "search".';

  const maxResults = Math.min(input.max_results ?? 10, 50);
  const params = new URLSearchParams({ q: input.query, maxResults: String(maxResults) });
  const response = await gmailFetch(auth, `/messages?${params}`);

  if (!response.ok) {
    return `Error: Gmail search failed (${response.status}).`;
  }

  const data = await response.json() as GmailListResponse;
  if (!data.messages || data.messages.length === 0) {
    return 'No messages found.';
  }

  // Fetch metadata for each message
  const summaries: string[] = [];
  const fetches = data.messages.slice(0, maxResults).map(async (msg) => {
    const metaResponse = await gmailFetch(auth, `/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
    if (!metaResponse.ok) return null;
    return metaResponse.json() as Promise<GmailMessage>;
  });

  const results = await Promise.allSettled(fetches);
  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const msg = result.value;
    const from = getHeader(msg.payload.headers, 'From');
    const subject = getHeader(msg.payload.headers, 'Subject');
    const date = formatDate(msg.internalDate);
    const unread = msg.labelIds?.includes('UNREAD') ? ' [UNREAD]' : '';
    summaries.push(`**${subject || '(no subject)'}**${unread}\n  From: ${from}\n  Date: ${date}\n  ID: ${msg.id}`);
  }

  return `Found ${data.resultSizeEstimate} results (showing ${summaries.length}):\n\n${summaries.join('\n\n')}`;
}

async function handleRead(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.message_id) return 'Error: "message_id" is required for action "read".';

  const response = await gmailFetch(auth, `/messages/${input.message_id}?format=full`);
  if (!response.ok) {
    return `Error: Failed to read message (${response.status}).`;
  }

  const msg = await response.json() as GmailMessage;
  const from = getHeader(msg.payload.headers, 'From');
  const to = getHeader(msg.payload.headers, 'To');
  const subject = getHeader(msg.payload.headers, 'Subject');
  const date = getHeader(msg.payload.headers, 'Date');
  const messageId = getHeader(msg.payload.headers, 'Message-ID');
  const body = extractBody(msg.payload);

  // Wrap email body as untrusted — emails are the #1 external attacker-controlled data source
  const wrappedBody = wrapUntrustedData(body, `gmail:${from}`);

  const parts = [
    `**${subject || '(no subject)'}**`,
    `From: ${from}`,
    `To: ${to}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    `Thread: ${msg.threadId}`,
    '',
    wrappedBody,
  ];

  return parts.join('\n');
}

async function handleSend(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.to) return 'Error: "to" is required for action "send".';
  if (!input.subject) return 'Error: "subject" is required for action "send".';
  if (!input.body) return 'Error: "body" is required for action "send".';

  const raw = buildRfc2822(input.to, input.subject, input.body, {
    cc: input.cc,
    bcc: input.bcc,
  });

  const response = await gmailFetch(auth, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: base64urlEncode(raw) }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to send email (${response.status}): ${text}`;
  }

  const result = await response.json() as { id: string; threadId: string };
  return `Email sent successfully.\nMessage ID: ${result.id}\nThread ID: ${result.threadId}`;
}

async function handleReply(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.message_id) return 'Error: "message_id" is required for action "reply".';
  if (!input.body) return 'Error: "body" is required for action "reply".';

  // First, read the original message to get headers
  const origResponse = await gmailFetch(auth, `/messages/${input.message_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=References`);
  if (!origResponse.ok) return `Error: Could not read original message (${origResponse.status}).`;

  const origMsg = await origResponse.json() as GmailMessage;
  const origFrom = getHeader(origMsg.payload.headers, 'From');
  const origSubject = getHeader(origMsg.payload.headers, 'Subject');
  const origMessageId = getHeader(origMsg.payload.headers, 'Message-ID');
  const origReferences = getHeader(origMsg.payload.headers, 'References');

  const replyTo = input.to ?? origFrom;
  const replySubject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;
  const references = origReferences ? `${origReferences} ${origMessageId}` : origMessageId;

  const raw = buildRfc2822(replyTo, replySubject, input.body, {
    cc: input.cc,
    inReplyTo: origMessageId,
    references,
  });

  const response = await gmailFetch(auth, '/messages/send', {
    method: 'POST',
    body: JSON.stringify({
      raw: base64urlEncode(raw),
      threadId: input.thread_id ?? origMsg.threadId,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to send reply (${response.status}): ${text}`;
  }

  const result = await response.json() as { id: string; threadId: string };
  return `Reply sent successfully.\nMessage ID: ${result.id}\nThread ID: ${result.threadId}`;
}

async function handleDraft(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.body) return 'Error: "body" is required for action "draft".';

  const raw = buildRfc2822(
    input.to ?? '',
    input.subject ?? '(Draft)',
    input.body,
    { cc: input.cc, bcc: input.bcc },
  );

  const response = await gmailFetch(auth, '/drafts', {
    method: 'POST',
    body: JSON.stringify({
      message: { raw: base64urlEncode(raw), threadId: input.thread_id },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return `Error: Failed to create draft (${response.status}): ${text}`;
  }

  const result = await response.json() as { id: string; message: { id: string } };
  return `Draft created.\nDraft ID: ${result.id}\nMessage ID: ${result.message.id}`;
}

async function handleArchive(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.message_id) return 'Error: "message_id" is required for action "archive".';

  const response = await gmailFetch(auth, `/messages/${input.message_id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['INBOX'] }),
  });

  if (!response.ok) {
    return `Error: Failed to archive message (${response.status}).`;
  }

  return `Message ${input.message_id} archived (removed from Inbox).`;
}

async function handleMarkRead(auth: GoogleAuth, input: GmailInput): Promise<string> {
  if (!input.message_id) return 'Error: "message_id" is required for action "mark_read".';

  const response = await gmailFetch(auth, `/messages/${input.message_id}/modify`, {
    method: 'POST',
    body: JSON.stringify({ removeLabelIds: ['UNREAD'] }),
  });

  if (!response.ok) {
    return `Error: Failed to mark message as read (${response.status}).`;
  }

  return `Message ${input.message_id} marked as read.`;
}

async function handleLabels(auth: GoogleAuth): Promise<string> {
  const response = await gmailFetch(auth, '/labels');
  if (!response.ok) {
    return `Error: Failed to fetch labels (${response.status}).`;
  }

  const data = await response.json() as { labels: GmailLabel[] };
  const lines = data.labels
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(l => {
      const counts = l.messagesTotal !== undefined
        ? ` (${l.messagesTotal} total, ${l.messagesUnread ?? 0} unread)`
        : '';
      return `- **${l.name}** [${l.type}]${counts} — ID: ${l.id}`;
    });

  return `Gmail Labels:\n\n${lines.join('\n')}`;
}
