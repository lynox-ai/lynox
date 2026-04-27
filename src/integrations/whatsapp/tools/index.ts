// === WhatsApp tool — one entry with an action enum ===
//
// Phase 0: agent-facing surface for the Inbox feature. All outbound sending is
// approval-gated (requiresConfirmation + agent.promptUser in the handler).

import type { IAgent, ToolEntry } from '../../../types/index.js';
import type { WhatsAppContext } from '../context.js';
import type { WhatsAppMessage, WhatsAppThreadSummary } from '../types.js';
import { threadIdForPhone } from '../webhook-parser.js';

export interface WhatsAppToolInput {
  action: 'list_inbox' | 'get_thread' | 'send_message' | 'mark_read';
  /** Thread ID (whatsapp-<digits>) OR phone (E.164, with/without '+'). */
  thread_id?: string | undefined;
  /** Alternative to thread_id — phone in E.164 (e.g. "+41791234567" or "41791234567"). */
  to?: string | undefined;
  /** Text body for send_message. */
  body?: string | undefined;
  /** Max results for list_inbox (default 25, max 100). */
  limit?: number | undefined;
}

export function createWhatsAppTool(ctx: WhatsAppContext): ToolEntry<WhatsAppToolInput> {
  return {
    definition: {
      name: 'whatsapp',
      description:
        'WhatsApp Business inbox tool. Actions: ' +
        '"list_inbox" (show recent threads with unread counts), ' +
        '"get_thread" (read a thread\'s messages incl. voice-note transcripts — pass thread_id or to), ' +
        '"send_message" (send a reply — REQUIRES user confirmation; pass thread_id or to + body), ' +
        '"mark_read" (mark inbound messages in a thread as read). ' +
        'This tool reads and replies on behalf of the user\'s own WhatsApp Business number. ' +
        'It is NOT a chatbot channel — every outbound send is shown to the user for approval first.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['list_inbox', 'get_thread', 'send_message', 'mark_read'],
            description: 'WhatsApp action to perform',
          },
          thread_id: {
            type: 'string',
            description: 'Thread ID in the form "whatsapp-<phone-digits>". Optional — if omitted, "to" is used.',
          },
          to: {
            type: 'string',
            description: 'Recipient phone in E.164 (e.g. "+41791234567"). Alternative to thread_id.',
          },
          body: {
            type: 'string',
            description: 'Text body (required for send_message)',
          },
          limit: {
            type: 'number',
            description: 'Max results for list_inbox (default 25, max 100)',
          },
        },
        required: ['action'],
      },
    },
    requiresConfirmation: true,
    handler: async (input: WhatsAppToolInput, agent: IAgent): Promise<string> => {
      if (!ctx.isConfigured()) {
        return 'WhatsApp not configured. Add Access Token, WABA-ID, Phone-Number-ID and App-Secret in Settings → Integrations → WhatsApp.';
      }

      switch (input.action) {
        case 'list_inbox': return handleListInbox(ctx, input);
        case 'get_thread': return handleGetThread(ctx, input);
        case 'mark_read': return handleMarkRead(ctx, input);
        case 'send_message': return handleSendMessage(ctx, input, agent);
        default: return `Error: unknown action "${String((input as { action: string }).action)}"`;
      }
    },
  };
}

// ── handlers ──

function handleListInbox(ctx: WhatsAppContext, input: WhatsAppToolInput): string {
  const limit = clampInt(input.limit, 25, 1, 100);
  const threads = ctx.getStateDb().listThreadSummaries(limit);
  if (threads.length === 0) return 'Inbox empty.';
  const lines = threads.map(formatThreadSummary);
  return lines.join('\n');
}

function handleGetThread(ctx: WhatsAppContext, input: WhatsAppToolInput): string {
  const threadId = resolveThreadId(input);
  if (!threadId) return 'Error: pass either thread_id or to.';
  const messages = ctx.getStateDb().getMessagesForThread(threadId, 100);
  if (messages.length === 0) return `No messages in ${threadId}.`;
  const contact = ctx.getStateDb().getContact(threadId.replace(/^whatsapp-/, ''));
  const header = contact?.displayName
    ? `Thread with ${contact.displayName} (${contact.phoneE164})`
    : `Thread ${threadId}`;
  return [header, '', ...messages.map(formatMessage)].join('\n');
}

function handleMarkRead(ctx: WhatsAppContext, input: WhatsAppToolInput): string {
  const threadId = resolveThreadId(input);
  if (!threadId) return 'Error: pass either thread_id or to.';
  ctx.getStateDb().markThreadRead(threadId);
  // Also mark-read via Meta API for the latest inbound message, if any
  const msgs = ctx.getStateDb().getMessagesForThread(threadId, 100);
  const latestInbound = [...msgs].reverse().find(m => m.direction === 'inbound');
  const client = ctx.getClient();
  if (latestInbound && client) {
    // Fire-and-forget; the Meta side is a UX signal, not state we depend on.
    client.markRead(latestInbound.id).catch(() => { /* ignored */ });
  }
  return `Marked ${threadId} as read.`;
}

async function handleSendMessage(ctx: WhatsAppContext, input: WhatsAppToolInput, agent: IAgent): Promise<string> {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (body.length === 0) return 'Error: body is required for send_message.';
  const { toPhone, threadId } = resolveTarget(input);
  if (!toPhone) return 'Error: pass either thread_id or to.';

  // Block the LLM from leaking credentials into an outbound WhatsApp message.
  // Same secret-scan layer used by the mail tools before SMTP/Gmail send.
  const { detectSecretInContent } = await import('../../../tools/builtin/http.js');
  const secretMatch = detectSecretInContent(body);
  if (secretMatch) {
    return `Blocked: message body appears to contain a ${secretMatch}. Sending secrets via WhatsApp is not allowed.`;
  }

  // Approval gate — Phase 1 principle: no outbound send without explicit user action.
  if (agent.promptUser) {
    const preview = body.length > 280 ? `${body.slice(0, 277)}…` : body;
    const contact = ctx.getStateDb().getContact(toPhone);
    const name = contact?.displayName ?? toPhone;
    const answer = await agent.promptUser(
      `Send this WhatsApp message to ${name}?\n\n${preview}`,
      ['Send', 'Cancel'],
    );
    if (answer.toLowerCase() !== 'send') return 'Cancelled.';
  }
  // Non-interactive / autonomous mode: refuse. Phase 2 introduces per-contact
  // auto-send whitelists; for now silence is the safe default.
  else {
    return 'Error: send_message requires interactive confirmation. Autonomous send is disabled in Phase 0.';
  }

  const client = ctx.getClient();
  if (!client) return 'WhatsApp not configured.';
  try {
    const result = await client.sendText(toPhone, body);
    // Persist the outbound message locally so the inbox reflects it immediately.
    ctx.getStateDb().upsertMessage({
      id: result.messageId,
      threadId,
      phoneE164: toPhone,
      direction: 'outbound',
      kind: 'text',
      text: body,
      mediaId: null,
      transcript: null,
      mimeType: null,
      timestamp: Math.floor(Date.now() / 1000),
      isEcho: false,
      rawJson: JSON.stringify({ source: 'lynox-send', messageId: result.messageId }),
    });
    return `Sent to ${toPhone}. Message ID: ${result.messageId}`;
  } catch (err) {
    return `Meta API error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── helpers ──

function resolveThreadId(input: WhatsAppToolInput): string | null {
  if (typeof input.thread_id === 'string' && input.thread_id.startsWith('whatsapp-')) {
    return input.thread_id;
  }
  if (typeof input.to === 'string') {
    const digits = input.to.replace(/[^0-9]/g, '');
    if (digits.length > 0) return threadIdForPhone(digits);
  }
  return null;
}

function resolveTarget(input: WhatsAppToolInput): { toPhone: string | null; threadId: string } {
  if (typeof input.to === 'string') {
    const digits = input.to.replace(/[^0-9]/g, '');
    if (digits.length > 0) return { toPhone: digits, threadId: threadIdForPhone(digits) };
  }
  if (typeof input.thread_id === 'string' && input.thread_id.startsWith('whatsapp-')) {
    const digits = input.thread_id.slice('whatsapp-'.length);
    if (digits.length > 0) return { toPhone: digits, threadId: input.thread_id };
  }
  return { toPhone: null, threadId: '' };
}

function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function formatThreadSummary(t: WhatsAppThreadSummary): string {
  const name = t.displayName ?? t.phoneE164;
  const unread = t.unreadCount > 0 ? ` (${t.unreadCount} unread)` : '';
  const voice = t.hasVoiceNote ? ' 🎤' : '';
  const dateStr = new Date(t.lastMessageAt * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return `- ${name}${unread}${voice} — ${dateStr}\n  ${t.lastMessagePreview}`;
}

function formatMessage(m: WhatsAppMessage): string {
  const who = m.direction === 'inbound' ? '← them' : (m.isEcho ? '→ me (mobile)' : '→ me');
  const dateStr = new Date(m.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' ');
  const body = m.transcript
    ? `🎤 ${m.transcript}`
    : m.text && m.text.length > 0
      ? m.text
      : `[${m.kind}]`;
  return `[${dateStr}] ${who}: ${body}`;
}
