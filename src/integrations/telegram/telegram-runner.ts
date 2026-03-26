// === Telegram Runner ===
// Manages run execution lifecycle. One active run at a time per chat.
// Rich status mode: thinking + tool details shown via status message edits.
// Follow-up suggestion buttons after completion.

import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import type { Telegraf } from 'telegraf';
import type { StreamEvent } from '../../types/index.js';
import {
  markdownToTelegramHtml,
  escapeHtml,
  splitMessage,
  formatStatus,
  buildAnswerKeyboard,
  buildStopKeyboard,
  buildRichStatus,
  toolInputPreview,
  parseFollowUps,
  fallbackFollowUps,
  formatFollowUpKeyboard,
  friendlyError,
} from './telegram-formatter.js';
import type { PendingTool } from './telegram-formatter.js';
import { getErrorMessage } from '../../core/utils.js';
import { runQueue } from './telegram-session.js';
import type { TelegramSession } from './telegram-session.js';
import { t, type Lang } from './telegram-i18n.js';
import { setChatFollowUps, getChatFollowUp, clearChatFollowUps, clearAll as clearCallbackStore } from './telegram-callbacks.js';

// Sliding window: keep last 20 messages per chat to prevent unbounded growth
const MAX_MESSAGES_PER_CHAT = 20;

// ---------------------------------------------------------------------------
// Sentry opt-in prompt — shown once after first successful run
// ---------------------------------------------------------------------------

let _sentryPrompted = false;
const SENTRY_FLAG_PATH = join(homedir(), '.lynox', '.sentry-prompted');

function shouldPromptSentry(): boolean {
  if (_sentryPrompted) return false;
  try {
    if (existsSync(SENTRY_FLAG_PATH)) { _sentryPrompted = true; return false; }
    // Don't prompt if Sentry is already configured
    if (process.env['LYNOX_SENTRY_DSN']) { _sentryPrompted = true; return false; }
    return true;
  } catch { return false; }
}

function markSentryPrompted(): void {
  _sentryPrompted = true;
  try { writeFileSync(SENTRY_FLAG_PATH, new Date().toISOString(), 'utf-8'); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Support prompt — shown once after N successful runs
// ---------------------------------------------------------------------------

const SUPPORT_URL = 'https://donate.stripe.com/eVq00ibbKemX61g5Mp8g000';
const SUPPORT_THRESHOLD = 10; // show after 10 successful tasks
const SUPPORT_FLAG_PATH = join(homedir(), '.lynox', '.support-prompted');
let _supportPrompted = false;
let _successCount = 0;

function shouldPromptSupport(): boolean {
  if (_supportPrompted) return false;
  try {
    if (existsSync(SUPPORT_FLAG_PATH)) { _supportPrompted = true; return false; }
  } catch { return false; }
  _successCount++;
  return _successCount >= SUPPORT_THRESHOLD;
}

function markSupportPrompted(): void {
  _supportPrompted = true;
  try { writeFileSync(SUPPORT_FLAG_PATH, new Date().toISOString(), 'utf-8'); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Telegram API error helpers
// ---------------------------------------------------------------------------

function isTelegramMessageUnchanged(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const msg = 'message' in err && typeof (err as { message?: unknown }).message === 'string'
    ? (err as { message: string }).message
    : '';
  return msg.includes('message is not modified');
}

function getTelegramRetryAfterMs(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const resp = (err as { response?: { parameters?: { retry_after?: unknown } } }).response;
  const retryAfter = resp?.parameters?.retry_after;
  if (typeof retryAfter === 'number' && retryAfter > 0) return retryAfter * 1000;
  const code = (err as { code?: unknown }).code;
  if (code === 429) return 5000;
  return null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_EDIT_INTERVAL_MS = 3000;
const STALE_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_CHECK_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ActiveRun {
  chatId: number;
  statusMessageId: number;
  startedAt: number;
  toolCount: number;
  lastEditAt: number;
  backoffUntil: number;
  lastActivityAt: number;
  writtenFiles: string[];
  pendingInput: {
    resolve: (answer: string) => void;
    question: string;
    options?: string[] | undefined;
  } | null;
  // Rich status fields
  thinkingBuffer: string;
  thinkingSummary: string;
  trackedTools: PendingTool[];
  toolNames: string[];
  aborted: boolean;
  lang: Lang;
}

const activeRuns = new Map<number, ActiveRun>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentRichStatus(run: ActiveRun, headerOverride?: string): string {
  const elapsed = Date.now() - run.startedAt;
  return buildRichStatus(
    headerOverride,
    run.toolCount > 0 ? 'working' : 'thinking',
    elapsed,
    run.toolCount,
    run.thinkingSummary,
    run.trackedTools,
    run.lang,
  );
}

async function editStatus(
  bot: Telegraf,
  run: ActiveRun,
  statusText: string,
  options?: { force?: boolean | undefined },
): Promise<void> {
  const now = Date.now();
  if (!options?.force && now - run.lastEditAt < MIN_EDIT_INTERVAL_MS) return;
  if (!options?.force && now < run.backoffUntil) return;

  try {
    await bot.telegram.editMessageText(
      run.chatId,
      run.statusMessageId,
      undefined,
      statusText,
      {
        parse_mode: 'HTML',
        reply_markup: buildStopKeyboard(),
      },
    );
    run.lastEditAt = now;
  } catch (err: unknown) {
    if (isTelegramMessageUnchanged(err)) return;
    const retryAfterMs = getTelegramRetryAfterMs(err);
    if (retryAfterMs !== null) {
      run.backoffUntil = Date.now() + retryAfterMs;
      process.stderr.write(`LYNOX Telegram rate limited; backing off ${Math.ceil(retryAfterMs / 1000)}s\n`);
    } else {
      process.stderr.write(`LYNOX Telegram editStatus failed: ${getErrorMessage(err)}\n`);
    }
  }
}

function isToolSuccess(result: string): boolean {
  return !result.startsWith('Error:') && !result.startsWith('Permission denied');
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function hasActiveRun(chatId: number): boolean {
  return activeRuns.has(chatId);
}

export function resolveInput(chatId: number, answer: string): boolean {
  const run = activeRuns.get(chatId);
  if (!run?.pendingInput) return false;
  run.pendingInput.resolve(answer);
  run.pendingInput = null;
  return true;
}

export async function abortRun(chatId: number, session: TelegramSession, bot?: Telegraf): Promise<void> {
  const run = activeRuns.get(chatId);
  if (!run) return;
  run.aborted = true;
  session.abort();
  // If waiting for input, resolve with abort signal
  if (run.pendingInput) {
    run.pendingInput.resolve('[ABORTED]');
    run.pendingInput = null;
  }
  // Immediately show stopped status
  if (bot) {
    const elapsed = Date.now() - run.startedAt;
    const stoppedStatus = buildRichStatus(
      undefined, 'stopped', elapsed, run.toolCount,
      '', run.trackedTools, run.lang,
    );
    try {
      await bot.telegram.editMessageText(
        chatId, run.statusMessageId, undefined,
        stoppedStatus, { parse_mode: 'HTML' },
      );
    } catch {
      // ignore
    }
  }
}

export function getFollowUpTask(chatId: number, index: number): string | null {
  return getChatFollowUp(chatId, index)?.task ?? null;
}

export async function executeRun(
  bot: Telegraf,
  session: TelegramSession,
  chatId: number,
  task: string | unknown[],
  lang: Lang = 'en',
): Promise<void> {
  if (hasActiveRun(chatId)) {
    await bot.telegram.sendMessage(chatId, t('msg.busy', lang));
    return;
  }

  // 1. Send status message immediately (before queue — user sees instant feedback)
  const statusMsg = await bot.telegram.sendMessage(
    chatId,
    formatStatus('thinking'),
    {
      parse_mode: 'HTML',
      reply_markup: buildStopKeyboard(),
    },
  );

  const now = Date.now();
  const run: ActiveRun = {
    chatId,
    statusMessageId: statusMsg.message_id,
    startedAt: now,
    toolCount: 0,
    lastEditAt: now,
    backoffUntil: 0,
    lastActivityAt: now,
    writtenFiles: [],
    pendingInput: null,
    // Rich status fields
    thinkingBuffer: '',
    thinkingSummary: '',
    trackedTools: [],
    toolNames: [],
    aborted: false,
    lang,
  };
  activeRuns.set(chatId, run);

  // Clear any previous follow-ups for this chat
  clearChatFollowUps(chatId);

  // 2. Serialize via queue — prevents concurrent API calls (single-user Core)
  await runQueue.enqueue(async () => {
    await executeRunInner(bot, session, chatId, task, run);

    // Sliding window: keep last N messages to prevent unbounded growth
    const msgs = session.saveMessages();
    if (msgs.length > MAX_MESSAGES_PER_CHAT) {
      // Adjust boundary to avoid splitting tool_use/tool_result pairs
      // (an orphaned tool_use without matching tool_result causes API 400)
      let keep = MAX_MESSAGES_PER_CHAT;
      while (keep < msgs.length) {
        const boundary = msgs[msgs.length - keep] as { role?: string; content?: unknown } | undefined;
        if (!boundary || boundary.role !== 'user' || typeof boundary.content === 'string') break;
        const hasToolResult = Array.isArray(boundary.content)
          && (boundary.content as Array<{ type: string }>).some(b => b.type === 'tool_result');
        if (!hasToolResult) break;
        keep++; // include the preceding assistant(tool_use) message
      }
      session.reset();
      session.loadMessages(msgs.slice(-keep));
    }
  });
}

/** Inner run logic — called within the serialized queue. */
async function executeRunInner(
  bot: Telegraf,
  session: TelegramSession,
  chatId: number,
  task: string | unknown[],
  run: ActiveRun,
): Promise<void> {

  // Stale timeout — abort if no stream events for 5 minutes
  const staleTimer = setInterval(() => {
    if (Date.now() - run.lastActivityAt > STALE_TIMEOUT_MS) {
      clearInterval(staleTimer);
      process.stderr.write(`LYNOX Telegram: run stale for chat ${chatId}, aborting\n`);
      session.abort();
      void bot.telegram.sendMessage(chatId, t('msg.timeout', run.lang)).catch(() => {});
    }
  }, STALE_CHECK_INTERVAL_MS);

  // 2. Save original handlers to restore later
  const prevOnStream = session.onStream;
  const prevPromptUser = session.promptUser;

  // 3. Set promptUser → sends question to Telegram
  session.promptUser = (question: string, options?: string[]): Promise<string> => {
    return new Promise<string>((resolve) => {
      run.pendingInput = { resolve, question, options };

      const questionHtml = `❓ <b>${markdownToTelegramHtml(question)}</b>`;

      const sendQuestion = async (): Promise<void> => {
        try {
          if (options && options.length > 0) {
            await bot.telegram.sendMessage(chatId, questionHtml, {
              parse_mode: 'HTML',
              reply_markup: buildAnswerKeyboard(options),
            });
          } else {
            await bot.telegram.sendMessage(chatId, questionHtml + '\n\n<i>Reply with your answer.</i>', {
              parse_mode: 'HTML',
            });
          }
        } catch {
          // HTML formatting failed — retry as plain text
          const plain = `❓ ${question}${options ? '\n\nOptions: ' + options.join(', ') : '\n\nReply with your answer.'}`;
          try {
            if (options && options.length > 0) {
              await bot.telegram.sendMessage(chatId, plain, { reply_markup: buildAnswerKeyboard(options) });
            } else {
              await bot.telegram.sendMessage(chatId, plain);
            }
          } catch {
            // Complete failure — question is lost
          }
        }
      };
      void sendQuestion();
    });
  };

  // 4. Set stream handler — rich status via edits
  session.onStream = (event: StreamEvent): void => {
    run.lastActivityAt = Date.now();

    switch (event.type) {
      case 'thinking':
        run.thinkingBuffer += event.thinking;
        // Extract last meaningful line as summary
        {
          const tLines = run.thinkingBuffer.split('\n').filter(l => l.trim());
          run.thinkingSummary = tLines[tLines.length - 1] ?? '';
        }
        void editStatus(bot, run, currentRichStatus(run));
        break;

      case 'thinking_done':
        // Final thinking summary already set from accumulation
        void editStatus(bot, run, currentRichStatus(run));
        break;

      case 'text':
        // Ignored — final result posted as one clean message after run
        break;

      case 'tool_call': {
        run.toolCount++;
        run.toolNames.push(event.name);
        const preview = toolInputPreview(event.name, event.input);
        run.trackedTools.push({ name: event.name, inputPreview: preview });
        void editStatus(bot, run, currentRichStatus(run));
        break;
      }

      case 'tool_result': {
        // Track files created by write_file
        if (event.name === 'write_file' && typeof event.result === 'string') {
          const match = /^Written to (.+)$/.exec(event.result);
          if (match?.[1]) run.writtenFiles.push(match[1]);
        }
        // Mark tracked tool as resolved
        const tracked = run.trackedTools.find(
          t => t.name === event.name && t.success === undefined,
        );
        if (tracked) {
          tracked.success = isToolSuccess(event.result);
          tracked.resultPreview = event.result.slice(0, 80);
        }
        void editStatus(bot, run, currentRichStatus(run));
        break;
      }

      case 'turn_end':
        void editStatus(bot, run, currentRichStatus(run), { force: true });
        break;

      case 'spawn':
        // Covered by spawn_agent tool_call — no separate message needed
        break;

      case 'error':
        void editStatus(bot, run, currentRichStatus(run, formatStatus('error', Date.now() - run.startedAt, run.toolCount)), { force: true });
        break;

      case 'continuation':
        void editStatus(bot, run, currentRichStatus(
          run,
          `🔄 <b>Iteration ${event.iteration}/${event.max}</b> · ${((Date.now() - run.startedAt) / 1000).toFixed(1)}s · ${run.toolCount} tools`,
        ));
        break;

      case 'cost_warning':
        void bot.telegram.sendMessage(chatId,
          `⚠️ <b>Cost warning:</b> $${event.snapshot.estimatedCostUSD.toFixed(4)} (${event.snapshot.budgetPercent.toFixed(0)}% of budget)`,
          { parse_mode: 'HTML' },
        );
        break;
    }
  };

  // 5. Execute
  try {
    const result = await session.run(task);
    const elapsed = Date.now() - run.startedAt;
    const originalTask = typeof task === 'string' ? task : '[image]';

    if (run.aborted) {
      // Aborted — show retry button via fallback
      const followUps = fallbackFollowUps(originalTask, run.lang);
      setChatFollowUps(chatId, followUps);
      const followUpKeyboard = formatFollowUpKeyboard(followUps);
      const stoppedStatus = buildRichStatus(
        undefined, 'stopped', elapsed, run.toolCount, '', run.trackedTools, run.lang,
      );
      try {
        await bot.telegram.editMessageText(
          chatId, run.statusMessageId, undefined,
          stoppedStatus,
          { parse_mode: 'HTML', reply_markup: followUpKeyboard },
        );
      } catch {
        // ignore
      }
    } else {
      // Normal completion — parse agent-generated follow-ups from response
      const { suggestions: followUps, cleanText } = parseFollowUps(result);
      let followUpKeyboard: ReturnType<typeof formatFollowUpKeyboard> | undefined;
      if (followUps.length > 0) {
        setChatFollowUps(chatId, followUps);
        followUpKeyboard = formatFollowUpKeyboard(followUps);
      }

      // Edit status to Done
      const doneStatus = buildRichStatus(
        undefined, 'done', elapsed, run.toolCount, '', run.trackedTools, run.lang,
      );
      try {
        await bot.telegram.editMessageText(
          chatId, run.statusMessageId, undefined,
          doneStatus, { parse_mode: 'HTML' },
        );
      } catch {
        // ignore
      }

      // Send clean result (follow-up block stripped) — attach keyboard to last message
      if (cleanText && cleanText.trim()) {
        const html = markdownToTelegramHtml(cleanText);
        const parts = splitMessage(html).filter(p => p.trim());
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          try {
            await bot.telegram.sendMessage(chatId, parts[i]!, {
              parse_mode: 'HTML',
              ...(isLast && followUpKeyboard ? { reply_markup: followUpKeyboard } : {}),
            });
          } catch {
            const plainResult = cleanText.slice(0, 4096);
            if (plainResult.trim()) {
              await bot.telegram.sendMessage(chatId, plainResult);
            }
            break;
          }
        }
      } else if (followUpKeyboard) {
        // No result text but have follow-ups — attach to done status
        try {
          await bot.telegram.editMessageText(
            chatId, run.statusMessageId, undefined,
            doneStatus,
            { parse_mode: 'HTML', reply_markup: followUpKeyboard },
          );
        } catch {
          // ignore
        }
      }

      // Sentry opt-in prompt — once, after first successful run
      if (shouldPromptSentry()) {
        markSentryPrompted();
        try {
          await bot.telegram.sendMessage(chatId, t('sentry.prompt', run.lang), {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: t('sentry.yes', run.lang), callback_data: 'sentry:yes' },
                { text: t('sentry.no', run.lang), callback_data: 'sentry:no' },
              ]],
            },
          });
        } catch { /* non-critical */ }
      }

      // Support prompt — once, after N successful runs
      if (shouldPromptSupport()) {
        markSupportPrompted();
        try {
          await bot.telegram.sendMessage(chatId, t('support.prompt', run.lang), {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: t('support.yes', run.lang), url: SUPPORT_URL },
                { text: t('support.no', run.lang), callback_data: 'support:no' },
              ]],
            },
          });
        } catch { /* non-critical */ }
      }

      // Send written files as documents
      for (const filePath of run.writtenFiles) {
        try {
          if (!existsSync(filePath)) continue;
          await bot.telegram.sendDocument(chatId, {
            source: createReadStream(filePath),
            filename: basename(filePath),
          });
        } catch {
          await bot.telegram.sendMessage(chatId,
            `📎 <code>${escapeHtml(basename(filePath))}</code>`,
            { parse_mode: 'HTML' },
          );
        }
      }
    }
  } catch (err: unknown) {
    const elapsed = Date.now() - run.startedAt;
    const message = getErrorMessage(err);
    const originalTask = typeof task === 'string' ? task : '[image]';

    // Error/abort: use minimal fallback (retry + explain)
    const followUps = fallbackFollowUps(
      originalTask, run.lang,
      run.aborted ? undefined : message,
    );
    setChatFollowUps(chatId, followUps);
    const followUpKeyboard = formatFollowUpKeyboard(followUps);

    if (run.aborted) {
      // Stopped — attach follow-up buttons to status message
      const stoppedStatus = buildRichStatus(
        undefined, 'stopped', elapsed, run.toolCount, '', run.trackedTools, run.lang,
      );
      try {
        await bot.telegram.editMessageText(
          chatId, run.statusMessageId, undefined,
          stoppedStatus,
          { parse_mode: 'HTML', reply_markup: followUpKeyboard },
        );
      } catch {
        // ignore
      }
    } else {
      // Real error — update status and show error with follow-up buttons
      const errorStatus = buildRichStatus(
        undefined, 'error', elapsed, run.toolCount, '', run.trackedTools, run.lang,
      );
      try {
        await bot.telegram.editMessageText(
          chatId, run.statusMessageId, undefined,
          errorStatus, { parse_mode: 'HTML' },
        );
      } catch {
        // ignore
      }

      if (message && message.trim()) {
        try {
          await bot.telegram.sendMessage(chatId,
            `🔴 <b>${t('status.error', run.lang)}:</b> ${escapeHtml(friendlyError(message, run.lang))}`,
            { parse_mode: 'HTML', reply_markup: followUpKeyboard },
          );
        } catch {
          // ignore
        }
      } else {
        // No error message — attach buttons to status
        try {
          await bot.telegram.editMessageText(
            chatId, run.statusMessageId, undefined,
            errorStatus,
            { parse_mode: 'HTML', reply_markup: followUpKeyboard },
          );
        } catch {
          // ignore
        }
      }
    }
  } finally {
    clearInterval(staleTimer);
    activeRuns.delete(chatId);
    session.onStream = prevOnStream;
    session.promptUser = prevPromptUser;
  }
}

/** Reset module-level state. For testing only. */
export function _resetRunnerState(): void {
  activeRuns.clear();
  clearCallbackStore();
}
