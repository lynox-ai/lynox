import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve, normalize, basename, relative, isAbsolute } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import type { LynoxConfig, BatchRequest, MemoryNamespace, StreamEvent, RunEvent } from '../types/index.js';
import { writeFileAtomicSync } from '../core/atomic-write.js';
import { getWorkspaceDir } from '../core/workspace.js';
import { getErrorMessage } from '../core/utils.js';
import { wrapUntrustedData } from '../core/data-boundary.js';

interface OutputFile {
  path: string;
  name: string;
  type: 'file';
}

interface FileAttachment {
  name: string;
  mimetype: string;
  data: string; // base64
  size: number;
}

interface RunState {
  chunks: string[];
  textBytes: number;
  truncatedOutput: boolean;
  status: string;          // current activity line (thinking / tool call) for live display
  statusHistory: string[]; // accumulated tool calls for final display
  done: boolean;
  error?: string | undefined;
  sessionId: string;
  pendingInput?: {
    question: string;
    options?: string[] | undefined;
    resolve: (answer: string) => void;
    timeout?: ReturnType<typeof setTimeout> | undefined;
  } | undefined;
  outputFiles: OutputFile[];
  runId: string;
  cleanupScheduled?: boolean | undefined;
  cleanupTimer?: ReturnType<typeof setTimeout> | undefined;
  // Event log for multi-message Slack streaming
  eventLog: RunEvent[];
  eventIdCounter: number;
  textBuffer: string;
  thinkingEmittedThisTurn: boolean;
  thinkingBuffer: string;
}

interface PersistedRunState {
  runId: string;
  sessionId: string;
  done: boolean;
  error?: string | undefined;
  text?: string | undefined;
  truncatedOutput?: boolean | undefined;
  statusHistory?: string[] | undefined;
  outputFiles?: OutputFile[] | undefined;
  updatedAt: string;
}
import { Engine } from '../core/engine.js';
import { SessionStore } from '../core/session-store.js';
import { MAX_BUFFER_BYTES } from '../core/constants.js';

const VALID_NAMESPACES = new Set<MemoryNamespace>(['knowledge', 'methods', 'project-state', 'learnings']);
const TEMP_BASE = '/tmp/lynox-files';
const MAX_READ_SIZE = MAX_BUFFER_BYTES;
const MAX_ATTACHMENT_SIZE = MAX_BUFFER_BYTES;
const MAX_ATTACHMENT_TOTAL = 25 * 1024 * 1024; // 25MB total per run
const MAX_INLINE_ATTACHMENT_TEXT_TOTAL = 200 * 1024; // 200KB total inline text budget per run
const MAX_RUN_TEXT_BYTES = 2 * 1024 * 1024; // 2MB max in-memory text buffer per async run
const MAX_TOTAL_RUN_TEXT_BYTES = 8 * 1024 * 1024; // 8MB total in-memory text budget across all tracked runs
const MAX_RUN_STATUS_HISTORY = 500;
const MAX_RUN_OUTPUT_FILES = 200;
const MAX_EVENT_LOG_SIZE = 500;
const MAX_TEXT_BUFFER_FLUSH = 2000;
const MAX_REQUEST_BODY_BYTES = 30 * 1024 * 1024; // 30MB max HTTP request body (covers 25MB attachment limit + overhead)
const MAX_ACTIVE_SESSIONS = 12;
const MAX_TRACKED_RUNS = 64;
const RUN_STATE_FILENAME = 'mcp-runs.json';
const RUN_INTERRUPTED_ERROR = 'Server restarted before run completed';

function isPathWithin(childPath: string, parentPath: string): boolean {
  const rel = relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sanitizeAttachmentName(name: string): string {
  const cleaned = basename(name).replace(/[\0-\x1f\x7f]/g, '').trim();
  const safe = cleaned === '' || cleaned === '.' || cleaned === '..' ? 'attachment.bin' : cleaned;
  return safe.slice(0, 255);
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&apos;');
}

export class LynoxMCPServer {
  private readonly config: LynoxConfig;
  private readonly mcpServer: McpServer;
  private readonly sessionStore = new SessionStore();
  private readonly runStore = new Map<string, RunState>();
  private readonly activeSessions = new Set<string>();
  private totalBufferedTextBytes = 0;
  private engine: Engine | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: LynoxConfig) {
    this.config = config;
    this.mcpServer = new McpServer(
      { name: 'lynox', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    this.loadPersistedRuns();
    this.registerTools();
    this.startTempCleanup();
  }

  async init(): Promise<void> {
    this.engine = new Engine(this.config);
    await this.engine.init();
  }

  /** Clean up temp dirs older than 1 hour every 60 seconds, and GC completed runs older than 30 minutes */
  private startTempCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      try {
        const entries = readdirSync(TEMP_BASE, { withFileTypes: true }).filter(e => e.isDirectory());
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const entry of entries) {
          const dirPath = join(TEMP_BASE, entry.name);
          try {
            const st = statSync(dirPath);
            if (st.mtimeMs < cutoff) {
              rmSync(dirPath, { recursive: true, force: true });
            }
          } catch { /* skip individual dir errors */ }
        }
      } catch { /* TEMP_BASE may not exist yet */ }

      // GC completed runs older than 30 minutes
      const runCutoff = Date.now() - 30 * 60 * 1000;
      for (const [runId, run] of this.runStore) {
        if (run.done && !run.pendingInput && !run.cleanupScheduled) {
          // Use the eventLog's last event timestamp, or schedule cleanup now
          const lastEventTs = run.eventLog.length > 0
            ? run.eventLog[run.eventLog.length - 1]!.timestamp
            : 0;
          if (lastEventTs > 0 && lastEventTs < runCutoff) {
            this.scheduleRunCleanup(runId, run, 0);
          } else if (lastEventTs === 0) {
            this.scheduleRunCleanup(runId, run, 0);
          }
        }
      }
    }, 60_000);
    // Don't keep process alive for cleanup
    this.cleanupTimer.unref();
  }

  private scheduleRunCleanup(runId: string, run: RunState, delayMs: number): void {
    if (run.cleanupTimer) {
      clearTimeout(run.cleanupTimer);
    }
    run.cleanupScheduled = true;
    run.cleanupTimer = setTimeout(() => {
      this.disposeRun(runId);
    }, delayMs);
    run.cleanupTimer.unref();
  }

  private disposeRun(runId: string): void {
    const run = this.runStore.get(runId);
    if (!run) return;
    if (run.cleanupTimer) {
      clearTimeout(run.cleanupTimer);
      run.cleanupTimer = undefined;
    }
    if (run.pendingInput?.timeout) {
      clearTimeout(run.pendingInput.timeout);
    }
    this.totalBufferedTextBytes = Math.max(0, this.totalBufferedTextBytes - run.textBytes);
    run.textBytes = 0;
    this.runStore.delete(runId);
    this.persistRunStore();
  }

  private countActiveRuns(): number {
    return this.activeSessions.size;
  }

  private getCapacityError(): string | null {
    if (this.countActiveRuns() >= MAX_ACTIVE_SESSIONS) {
      return `Server busy: too many active runs (${MAX_ACTIVE_SESSIONS} max). Retry shortly.`;
    }
    return null;
  }

  private compactCompletedRuns(targetSize: number = MAX_TRACKED_RUNS - 1): void {
    if (this.runStore.size <= targetSize) return;
    for (const [runId, run] of this.runStore) {
      if (!run.done || run.pendingInput) continue;
      this.disposeRun(runId);
      if (this.runStore.size <= targetSize) return;
    }
  }

  private ensureTrackedRunCapacity(): string | null {
    this.compactCompletedRuns();
    if (this.runStore.size >= MAX_TRACKED_RUNS) {
      return `Server busy: too many tracked async runs (${MAX_TRACKED_RUNS} max). Poll or clear existing runs first.`;
    }
    return null;
  }

  private dropOldestChunk(run: RunState): boolean {
    if (run.chunks.length <= 1) return false;
    const dropped = run.chunks.shift();
    if (!dropped) return false;
    const droppedBytes = Buffer.byteLength(dropped, 'utf-8');
    run.textBytes = Math.max(0, run.textBytes - droppedBytes);
    this.totalBufferedTextBytes = Math.max(0, this.totalBufferedTextBytes - droppedBytes);
    run.truncatedOutput = true;
    return true;
  }

  private enforceGlobalTextBudget(preferredRun?: RunState): void {
    if (this.totalBufferedTextBytes <= MAX_TOTAL_RUN_TEXT_BYTES) return;

    const runs = [...this.runStore.values()].sort((a, b) => {
      if (a === preferredRun && b !== preferredRun) return 1;
      if (b === preferredRun && a !== preferredRun) return -1;
      const aCompleted = a.done && !a.pendingInput;
      const bCompleted = b.done && !b.pendingInput;
      if (aCompleted !== bCompleted) return aCompleted ? -1 : 1;
      if (a.done !== b.done) return a.done ? -1 : 1;
      if (Boolean(a.pendingInput) !== Boolean(b.pendingInput)) return a.pendingInput ? 1 : -1;
      return 0;
    });

    let trimmed = true;
    while (this.totalBufferedTextBytes > MAX_TOTAL_RUN_TEXT_BYTES && trimmed) {
      trimmed = false;
      for (const run of runs) {
        if (!this.dropOldestChunk(run)) continue;
        trimmed = true;
        if (this.totalBufferedTextBytes <= MAX_TOTAL_RUN_TEXT_BYTES) break;
      }
    }
  }

  private resolvePendingInput(run: RunState, answer: string): void {
    const pending = run.pendingInput;
    if (!pending) return;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    run.pendingInput = undefined;
    pending.resolve(answer);
  }

  private abortSessionRuns(sessionId: string): number {
    this.activeSessions.delete(sessionId);
    let aborted = 0;
    for (const run of this.runStore.values()) {
      if (run.sessionId !== sessionId || run.done) continue;
      this.resolvePendingInput(run, 'n');
      run.done = true;
      run.error = 'Aborted';
      this.scheduleRunCleanup(run.runId, run, 30_000);
      aborted++;
    }
    if (aborted > 0) {
      this.persistRunStore();
    }
    return aborted;
  }

  private getRunStateFilePath(): string {
    const baseDir = process.env['LYNOX_MCP_STATE_DIR'] ?? join(process.cwd(), '.lynox');
    return join(baseDir, RUN_STATE_FILENAME);
  }

  private persistRunStore(): void {
    const runs: PersistedRunState[] = [...this.runStore.values()].map((run) => ({
      runId: run.runId,
      sessionId: run.sessionId,
      done: run.done,
      error: run.error,
      text: run.done ? run.chunks.join('') : undefined,
      truncatedOutput: run.truncatedOutput || undefined,
      statusHistory: run.done && run.statusHistory.length > 0 ? [...run.statusHistory] : undefined,
      outputFiles: run.done && run.outputFiles.length > 0 ? [...run.outputFiles] : undefined,
      updatedAt: new Date().toISOString(),
    }));

    try {
      writeFileAtomicSync(
        this.getRunStateFilePath(),
        JSON.stringify({ runs }, null, 2) + '\n',
      );
    } catch {
      // Persistence is best-effort.
    }
  }

  private loadPersistedRuns(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.getRunStateFilePath(), 'utf-8')) as unknown;
    } catch {
      return;
    }

    const rawRuns = typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { runs?: unknown }).runs)
      ? (parsed as { runs: unknown[] }).runs
      : [];

    const restored = rawRuns
      .map((entry): PersistedRunState | null => {
        if (typeof entry !== 'object' || entry === null) return null;
        const obj = entry as Record<string, unknown>;
        if (typeof obj['runId'] !== 'string' || typeof obj['sessionId'] !== 'string' || typeof obj['done'] !== 'boolean') {
          return null;
        }
        const text = typeof obj['text'] === 'string' ? obj['text'] : undefined;
        const statusHistory = Array.isArray(obj['statusHistory']) && obj['statusHistory'].every((v) => typeof v === 'string')
          ? obj['statusHistory'] as string[]
          : undefined;
        const outputFiles = Array.isArray(obj['outputFiles'])
          ? obj['outputFiles']
            .filter((file): file is OutputFile =>
              typeof file === 'object' &&
              file !== null &&
              typeof (file as { path?: unknown }).path === 'string' &&
              typeof (file as { name?: unknown }).name === 'string' &&
              (file as { type?: unknown }).type === 'file',
            )
            .map((file) => ({
              path: (file as { path: string }).path,
              name: (file as { name: string }).name,
              type: 'file' as const,
            }))
          : undefined;
        return {
          runId: obj['runId'],
          sessionId: obj['sessionId'],
          done: obj['done'],
          error: typeof obj['error'] === 'string' ? obj['error'] : undefined,
          text,
          truncatedOutput: obj['truncatedOutput'] === true ? true : undefined,
          statusHistory,
          outputFiles,
          updatedAt: typeof obj['updatedAt'] === 'string' ? obj['updatedAt'] : new Date(0).toISOString(),
        };
      })
      .filter((entry): entry is PersistedRunState => entry !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_TRACKED_RUNS)
      .reverse();

    for (const entry of restored) {
      const interrupted = !entry.done;
      const text = entry.text ?? '';
      const textBytes = Buffer.byteLength(text, 'utf-8');
      const run: RunState = {
        chunks: text ? [text] : [],
        textBytes,
        truncatedOutput: entry.truncatedOutput === true,
        status: '',
        statusHistory: entry.statusHistory ?? [],
        done: true,
        error: interrupted ? RUN_INTERRUPTED_ERROR : entry.error,
        sessionId: entry.sessionId,
        outputFiles: entry.outputFiles ?? [],
        runId: entry.runId,
        cleanupScheduled: false,
        cleanupTimer: undefined,
        eventLog: [], eventIdCounter: 0, textBuffer: '', thinkingEmittedThisTurn: false, thinkingBuffer: '',
      };
      this.runStore.set(run.runId, run);
      this.totalBufferedTextBytes += textBytes;
      this.scheduleRunCleanup(run.runId, run, 10 * 60_000);
    }

    if (restored.length > 0) {
      this.enforceGlobalTextBudget();
      this.persistRunStore();
    }
  }

  private registerTools(): void {
    // lynox_run — run a task, optionally in a persistent session
    this.mcpServer.registerTool(
      'lynox_run',
      {
        description: 'Run an autonomous task with LYNOX agent',
        inputSchema: { task: z.string(), session_id: z.string().optional(), user_context: z.string().optional() },
      },
      async ({ task, session_id, user_context }) => {
        if (!this.engine) throw new Error('LynoxMCPServer not initialized');
        const sid = session_id ?? randomUUID();
        if (this.activeSessions.has(sid)) {
          return { content: [{ type: 'text' as const, text: `Session ${sid} already has an active run` }] };
        }
        const capacityError = this.getCapacityError();
        if (capacityError) {
          return { content: [{ type: 'text' as const, text: capacityError }] };
        }
        const systemPromptSuffix = user_context
          ? `\n\n<user_context>\n${wrapUntrustedData(user_context, 'mcp:user_context')}\n</user_context>`
          : undefined;
        const session = this.sessionStore.getOrCreate(sid, this.engine, { systemPromptSuffix });
        this.activeSessions.add(sid);
        try {
          const result = await session.run(task);
          return { content: [{ type: 'text' as const, text: result }] };
        } finally {
          this.activeSessions.delete(sid);
        }
      },
    );

    // lynox_batch — submit a batch of requests
    this.mcpServer.registerTool(
      'lynox_batch',
      {
        description: 'Submit a batch of tasks for async processing at reduced cost',
        inputSchema: {
          requests: z.array(z.object({
            id: z.string(),
            task: z.string(),
            system: z.string().optional(),
          })),
        },
      },
      async ({ requests }) => {
        if (!this.engine) throw new Error('LynoxMCPServer not initialized');
        const batchReqs: BatchRequest[] = requests.map(r => ({
          id: r.id,
          task: r.task,
          system: r.system,
        }));
        const batchId = await this.engine.batch(batchReqs);
        return { content: [{ type: 'text' as const, text: `Batch submitted: ${batchId}` }] };
      },
    );

    // lynox_status — check batch status
    this.mcpServer.registerTool(
      'lynox_status',
      {
        description: 'Check the status of a batch by ID',
        inputSchema: { batch_id: z.string() },
      },
      async ({ batch_id }) => {
        if (!this.engine) throw new Error('LynoxMCPServer not initialized');
        const apiConfig = this.engine.getApiConfig();
        const client = apiConfig.apiKey
          ? new Anthropic({ apiKey: apiConfig.apiKey, baseURL: apiConfig.apiBaseURL })
          : apiConfig.apiBaseURL
            ? new Anthropic({ baseURL: apiConfig.apiBaseURL })
            : new Anthropic();
        const batch = await client.messages.batches.retrieve(batch_id);
        const counts = batch.request_counts;
        const text = [
          `Batch: ${batch_id}`,
          `Status: ${batch.processing_status}`,
          `Processing: ${counts.processing} | Succeeded: ${counts.succeeded} | Errored: ${counts.errored} | Canceled: ${counts.canceled} | Expired: ${counts.expired}`,
        ].join('\n');
        return { content: [{ type: 'text' as const, text }] };
      },
    );

    // lynox_memory — read memory namespace
    this.mcpServer.registerTool(
      'lynox_memory',
      {
        description: 'Read LYNOX agent memory by namespace',
        inputSchema: {
          namespace: z.enum(['knowledge', 'methods', 'project-state', 'learnings']),
        },
      },
      async ({ namespace }) => {
        if (!this.engine) throw new Error('LynoxMCPServer not initialized');
        const mem = this.engine.getMemory();
        if (!mem) {
          return { content: [{ type: 'text' as const, text: 'Memory is not configured.' }] };
        }
        if (!VALID_NAMESPACES.has(namespace)) {
          return { content: [{ type: 'text' as const, text: `Invalid namespace: ${namespace}` }] };
        }
        const content = await mem.load(namespace);
        const text = content ?? `No content in ${namespace}.`;
        return { content: [{ type: 'text' as const, text }] };
      },
    );

    // lynox_reset — clear a session
    this.mcpServer.registerTool(
      'lynox_reset',
      {
        description: 'Reset a LYNOX session by session ID',
        inputSchema: { session_id: z.string() },
      },
      async ({ session_id }) => {
        const existing = this.sessionStore.get(session_id);
        existing?.abort();
        const abortedRuns = this.abortSessionRuns(session_id);
        this.activeSessions.delete(session_id);
        this.sessionStore.reset(session_id);
        const suffix = abortedRuns > 0 ? ` (aborted ${abortedRuns} active run${abortedRuns === 1 ? '' : 's'})` : '';
        return { content: [{ type: 'text' as const, text: `Session ${session_id} reset.${suffix}` }] };
      },
    );

    // lynox_run_start — start an async run, returns run_id immediately
    this.mcpServer.registerTool(
      'lynox_run_start',
      {
        description: 'Start an async LYNOX task and return a run_id for polling. Returns immediately before the task completes.',
        inputSchema: {
          task: z.string(),
          session_id: z.string().optional(),
          user_context: z.string().optional(),
          files: z.array(z.object({
            name: z.string(),
            mimetype: z.string(),
            data: z.string(),
            size: z.number(),
          })).optional(),
        },
      },
      async ({ task, session_id, user_context, files }) => {
        if (!this.engine) throw new Error('LynoxMCPServer not initialized');
        const sid = session_id ?? randomUUID();
        if (this.activeSessions.has(sid)) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Session ${sid} already has an active run` }),
            }],
          };
        }
        const capacityError = this.getCapacityError();
        if (capacityError) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: capacityError }),
            }],
          };
        }
        const activeRun = [...this.runStore.values()].find(r => r.sessionId === sid && !r.done);
        if (activeRun) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Session ${sid} already has an active run`,
                run_id: activeRun.runId,
              }),
            }],
          };
        }
        const trackedRunError = this.ensureTrackedRunCapacity();
        if (trackedRunError) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: trackedRunError }),
            }],
          };
        }
        const systemPromptSuffix = user_context
          ? `\n\n<user_context>\n${wrapUntrustedData(user_context, 'mcp:user_context')}\n</user_context>`
          : undefined;
        const session = this.sessionStore.getOrCreate(sid, this.engine, { systemPromptSuffix });
        const runId = randomUUID();

        // Process inbound files — write to temp dir, augment task prompt
        let augmentedTask = task;
        if (files && files.length > 0) {
          const dir = join(TEMP_BASE, runId);
          mkdirSync(dir, { recursive: true });
          const fileNotes: string[] = [];
          const usedNames = new Set<string>();
          let totalAttachmentBytes = 0;
          let inlineAttachmentBytes = 0;

          for (const file of files as FileAttachment[]) {
            const estimatedBytes = Math.floor((file.data.length * 3) / 4);
            if (file.size > MAX_ATTACHMENT_SIZE || estimatedBytes > MAX_ATTACHMENT_SIZE) {
              rmSync(dir, { recursive: true, force: true });
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: `Attachment too large: ${file.name} (${file.size} bytes, max ${MAX_ATTACHMENT_SIZE})`,
                  }),
                }],
              };
            }

            const buf = Buffer.from(file.data, 'base64');
            totalAttachmentBytes += buf.length;
            if (totalAttachmentBytes > MAX_ATTACHMENT_TOTAL) {
              rmSync(dir, { recursive: true, force: true });
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: `Total attachment payload too large (${totalAttachmentBytes} bytes, max ${MAX_ATTACHMENT_TOTAL})`,
                  }),
                }],
              };
            }
            const baseName = sanitizeAttachmentName(file.name);
            let safeName = baseName;
            let suffix = 1;
            while (usedNames.has(safeName)) {
              safeName = `${suffix}-${baseName}`;
              suffix++;
            }
            usedNames.add(safeName);

            const filePath = join(dir, safeName);
            writeFileSync(filePath, buf);

            const isText = file.mimetype.startsWith('text/') ||
              /^application\/(json|xml|javascript|typescript|x-yaml|x-sh|x-python)/.test(file.mimetype);
            if (isText && buf.length <= 50_000 && inlineAttachmentBytes + buf.length <= MAX_INLINE_ATTACHMENT_TEXT_TOTAL) {
              // Inline small text files directly in the prompt
              const content = escapeXml(buf.toString('utf-8'));
              const safeMime = escapeXml(file.mimetype);
              const safeLabel = escapeXml(safeName);
              fileNotes.push(`\n<attached_file name="${safeLabel}" mimetype="${safeMime}">\n${content}\n</attached_file>`);
              inlineAttachmentBytes += buf.length;
            } else {
              fileNotes.push(`\n[Attached file: ${safeName} (${file.mimetype}, ${file.size} bytes) — read with read_file at ${filePath}]`);
            }
          }
          augmentedTask = task + '\n' + fileNotes.join('\n');
        }

        const runState: RunState = {
          chunks: [], textBytes: 0, truncatedOutput: false, status: '', statusHistory: [], done: false,
          sessionId: sid, outputFiles: [], runId, cleanupScheduled: false, cleanupTimer: undefined,
          eventLog: [], eventIdCounter: 0, textBuffer: '', thinkingEmittedThisTurn: false, thinkingBuffer: '',
        };
        this.runStore.set(runId, runState);
        this.persistRunStore();

        // Set currentRunId on underlying agent so tools (e.g. send_voice) can scope temp files
        const agent = session.getAgent();
        if (agent) agent.currentRunId = runId;

        const previousOnStream = session.onStream;
        const pushEvent = (type: RunEvent['type'], data: Record<string, unknown>): void => {
          const id = ++runState.eventIdCounter;
          runState.eventLog.push({ id, type, timestamp: Date.now(), data });
          if (runState.eventLog.length > MAX_EVENT_LOG_SIZE) {
            runState.eventLog.splice(0, runState.eventLog.length - MAX_EVENT_LOG_SIZE);
          }
        };
        const flushTextBuffer = (): void => {
          if (runState.textBuffer) {
            pushEvent('text_chunk', { text: runState.textBuffer });
            runState.textBuffer = '';
          }
        };
        const flushThinkingBuffer = (): void => {
          if (runState.thinkingBuffer) {
            pushEvent('thinking', { summary: runState.thinkingBuffer.slice(0, 200) });
            runState.thinkingBuffer = '';
            runState.thinkingEmittedThisTurn = true;
          }
        };

        const streamHandler = async (event: StreamEvent): Promise<void> => {
          if (event.type === 'text') {
            const textBytes = Buffer.byteLength(event.text, 'utf-8');
            runState.textBytes += textBytes;
            this.totalBufferedTextBytes += textBytes;
            runState.chunks.push(event.text);
            while (runState.textBytes > MAX_RUN_TEXT_BYTES && runState.chunks.length > 1) {
              this.dropOldestChunk(runState);
            }
            this.enforceGlobalTextBudget(runState);
            runState.status = '';
            runState.textBuffer += event.text;
            if (runState.textBuffer.length >= MAX_TEXT_BUFFER_FLUSH) {
              flushTextBuffer();
            }
          } else if (event.type === 'thinking') {
            if (!runState.chunks.length) runState.status = '👾 Thinking…';
            if (!runState.thinkingEmittedThisTurn) {
              runState.thinkingBuffer += event.thinking;
            }
          } else if (event.type === 'thinking_done') {
            flushThinkingBuffer();
          } else if (event.type === 'tool_call') {
            flushThinkingBuffer();
            runState.status = `⚡ ${event.name}`;
            runState.statusHistory.push(event.name);
            if (runState.statusHistory.length > MAX_RUN_STATUS_HISTORY) {
              runState.statusHistory.shift();
            }
            flushTextBuffer();
            pushEvent('tool_call', { name: event.name, input: event.input });
          } else if (event.type === 'tool_result') {
            runState.status = `✓ ${event.name}`;
            if (event.name === 'write_file') {
              const match = /Written to (.+)/.exec(event.result);
              if (match?.[1]) {
                const filePath = match[1];
                const fileName = filePath.split('/').pop() ?? 'file';
                runState.outputFiles.push({ path: filePath, name: fileName, type: 'file' });
                if (runState.outputFiles.length > MAX_RUN_OUTPUT_FILES) {
                  runState.outputFiles.shift();
                }
              }
            }
            const isError = event.result.startsWith('Error:') || event.result.startsWith('error:');
            pushEvent('tool_result', {
              name: event.name,
              success: !isError,
              preview: event.result.slice(0, 300),
            });
          } else if (event.type === 'turn_end') {
            flushThinkingBuffer();
            flushTextBuffer();
            runState.thinkingEmittedThisTurn = false;
            runState.thinkingBuffer = '';
            pushEvent('turn_end', { stop_reason: event.stop_reason });
          } else if (event.type === 'error') {
            flushTextBuffer();
            pushEvent('error', { message: event.message });
          } else if (event.type === 'continuation') {
            flushTextBuffer();
            pushEvent('continuation', { iteration: event.iteration, max: event.max });
          }
        };
        session.onStream = streamHandler;

        // Capture reference so the .then()/.catch() cleanup only clears promptUser
        // if a subsequent lynox_run_start hasn't already replaced it with a new fn.
        const promptFn = (question: string, options?: string[] | undefined): Promise<string> =>
          new Promise((resolve) => {
            const timeout = setTimeout(() => {
              if (runState.pendingInput?.resolve === resolve) {
                this.resolvePendingInput(runState, 'n');
              }
            }, 120_000);
            timeout.unref();
            runState.pendingInput = { question, options, resolve, timeout };
            // Auto-resolve with 'n' after 2 minutes so the agent never hangs
          });
        session.promptUser = promptFn;
        this.activeSessions.add(sid);

        session.run(augmentedTask)
          .then(() => {
            runState.done = true;
            if (session.promptUser === promptFn) session.promptUser = null;
            if (session.onStream === streamHandler) session.onStream = previousOnStream;
            const a = session.getAgent();
            if (a?.currentRunId === runId) a.currentRunId = undefined;
            this.activeSessions.delete(sid);
            this.persistRunStore();
            this.scheduleRunCleanup(runId, runState, 10 * 60_000);
          })
          .catch((err: unknown) => {
            runState.done = true;
            runState.error = getErrorMessage(err);
            if (session.promptUser === promptFn) session.promptUser = null;
            if (session.onStream === streamHandler) session.onStream = previousOnStream;
            const a = session.getAgent();
            if (a?.currentRunId === runId) a.currentRunId = undefined;
            this.activeSessions.delete(sid);
            this.resolvePendingInput(runState, 'n');
            this.persistRunStore();
            this.scheduleRunCleanup(runId, runState, 10 * 60_000);
          });

        return { content: [{ type: 'text' as const, text: JSON.stringify({ run_id: runId }) }] };
      },
    );

    // lynox_poll — poll for accumulated text from an async run
    this.mcpServer.registerTool(
      'lynox_poll',
      {
        description: 'Poll the accumulated text from a running async LYNOX task. Returns done=true when finished. Pass cursor to get incremental events.',
        inputSchema: { run_id: z.string(), session_id: z.string(), cursor: z.number().optional() },
      },
      async ({ run_id, session_id, cursor }) => {
        const run = this.runStore.get(run_id);
        if (!run) {
          const payload = { done: true, text: '', error: 'Run not found' };
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
        }
        // Session ownership check — mandatory to prevent cross-session data access
        if (run.sessionId !== session_id) {
          const payload = { done: true, text: '', error: 'Run not found' };
          return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
        }
        const textBody = run.chunks.join('');
        const text = run.truncatedOutput
          ? `[output truncated in-memory to ${Math.floor(MAX_RUN_TEXT_BYTES / 1024)}KB]\n${textBody}`
          : textBody;
        const payload: {
          done: boolean; text: string;
          truncated?: boolean;
          status?: string; statusHistory?: string[]; error?: string;
          waiting_for_input?: { question: string; options?: string[] | undefined };
          output_files?: Array<{ name: string; path: string; type: string }>;
          events?: RunEvent[];
          nextCursor?: number;
        } = { done: run.done, text };
        if (run.truncatedOutput) payload.truncated = true;
        if (run.status) payload.status = run.status;
        if (run.error !== undefined) payload.error = run.error;
        if (run.done && run.statusHistory.length) payload.statusHistory = run.statusHistory;
        if (run.pendingInput) {
          payload.waiting_for_input = { question: run.pendingInput.question, options: run.pendingInput.options };
        }
        if (run.done && run.outputFiles.length > 0) {
          payload.output_files = run.outputFiles.map(f => ({ name: f.name, path: f.path, type: f.type }));
        }
        // Event log: return new events since cursor when requested
        if (cursor !== undefined) {
          const newEvents = run.eventLog.filter(e => e.id > cursor);
          payload.events = newEvents;
          const lastId = newEvents.length > 0 ? newEvents[newEvents.length - 1]!.id : cursor;
          payload.nextCursor = lastId;
        }
        // Only clean up when fully done and not waiting for input
        // Keep entry around briefly so readFile can access outputFiles
        if (run.done && !run.pendingInput && !run.cleanupScheduled) {
          this.scheduleRunCleanup(run_id, run, 30_000);
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
      },
    );

    // lynox_read_file — read a file from the lynox container, returned as base64
    this.mcpServer.registerTool(
      'lynox_read_file',
      {
        description: 'Read a file from the LYNOX container and return its contents as base64. Path must be under /tmp/lynox-files/ or the working directory.',
        inputSchema: { path: z.string() },
      },
      async ({ path: rawPath }) => {
        const resolved = resolve(normalize(rawPath));
        let canonicalPath: string;
        try {
          canonicalPath = realpathSync(resolved);
        } catch {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `File not found: ${resolved}` }) }] };
        }

        const tempRoot = resolve(TEMP_BASE);
        const cwdRoot = realpathSync(process.cwd());
        const wsDir = getWorkspaceDir();
        const allowed = isPathWithin(canonicalPath, tempRoot)
          || isPathWithin(canonicalPath, cwdRoot)
          || (wsDir !== null && isPathWithin(canonicalPath, wsDir));
        if (!allowed) {
          const dirs = [tempRoot, cwdRoot, ...(wsDir ? [wsDir] : [])].join(' or ');
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ error: `Path not allowed: ${canonicalPath} — must be under ${dirs}` }),
            }],
          };
        }
        try {
          const st = statSync(canonicalPath);
          if (st.size > MAX_READ_SIZE) {
            return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `File too large: ${st.size} bytes (max ${MAX_READ_SIZE})` }) }] };
          }
          const data = readFileSync(canonicalPath);
          const base64 = data.toString('base64');
          return { content: [{ type: 'text' as const, text: JSON.stringify({ data: base64, size: st.size }) }] };
        } catch (err: unknown) {
          const msg = getErrorMessage(err);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
        }
      },
    );

    // lynox_reply — send a reply to a run waiting for user input
    this.mcpServer.registerTool(
      'lynox_reply',
      {
        description: 'Send a user reply to a LYNOX run waiting for input (approval or ask_user answer)',
        inputSchema: { run_id: z.string(), session_id: z.string(), answer: z.string() },
      },
      async ({ run_id, session_id, answer }) => {
        const run = this.runStore.get(run_id);
        if (!run?.pendingInput) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No pending input for this run' }) }] };
        }
        // Session ownership check — mandatory to prevent cross-session data access
        if (run.sessionId !== session_id) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No pending input for this run' }) }] };
        }
        const { options } = run.pendingInput;
        if (options && !options.includes(answer)) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Invalid answer. Must be one of: ${options.join(', ')}` }) }] };
        }
        this.resolvePendingInput(run, answer);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
      },
    );

    // lynox_abort — abort an in-flight agent run
    this.mcpServer.registerTool(
      'lynox_abort',
      {
        description: 'Abort an in-flight LYNOX agent run by session ID.',
        inputSchema: { session_id: z.string() },
      },
      async ({ session_id }) => {
        const session = this.sessionStore.get(session_id);
        session?.abort();
        const abortedRuns = this.abortSessionRuns(session_id);
        this.activeSessions.delete(session_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ aborted: session !== undefined || abortedRuns > 0 }) }] };
      },
    );
  }

  async startStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
  }

  async startHTTP(port: number): Promise<void> {
    const mcpServer = this.mcpServer;
    const secret = process.env['LYNOX_MCP_SECRET'];

    // Active transport — replaced with a fresh one each time a session closes so that
    // reconnecting clients (e.g. slack-bot restart) can initialize a new session.
    let activeTransport: StreamableHTTPServerTransport | null = null;

    const spawnTransport = async (): Promise<void> => {
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessionclosed: () => {
          // Session closed (client disconnected or sent DELETE) — spawn a new transport so
          // the next initialize request is accepted without "Server already initialized".
          // Only respawn if this is still the active transport (prevents double-spawn when
          // recycleStaleSession already replaced it).
          if (activeTransport === t) {
            activeTransport = null;
            spawnTransport().catch((err: unknown) => {
              process.stderr.write(`LYNOX MCP transport respawn failed: ${String(err)}\n`);
            });
          }
        },
      });
      // SDK type gap: StreamableHTTPServerTransport.onclose is optional but Transport requires it.
      await mcpServer.connect(t as Parameters<typeof mcpServer.connect>[0]);
      activeTransport = t;
    };

    /** Force-close a stale session and spawn a fresh transport for a reconnecting client. */
    const recycleStaleSession = async (): Promise<void> => {
      process.stderr.write('LYNOX MCP: new client init detected — recycling stale session\n');
      const old = activeTransport;
      activeTransport = null; // detach before close so onsessionclosed doesn't double-spawn
      if (old) {
        try { await old.close(); } catch { /* best-effort */ }
      }
      await spawnTransport();
    };

    await spawnTransport();

    // Simple per-IP rate limiter: max 60 requests per minute
    const RATE_WINDOW_MS = 60_000;
    const RATE_MAX = 60;
    const rateCounts = new Map<string, { count: number; resetAt: number }>();

    // Periodic pruning of expired rate limiter entries
    const rateGcTimer = setInterval(() => {
      const now = Date.now();
      for (const [ip, bucket] of rateCounts) {
        if (now >= bucket.resetAt) {
          rateCounts.delete(ip);
        }
      }
    }, 5 * 60_000);
    rateGcTimer.unref();

    const server = createServer(async (req, res) => {
      // Health check endpoint — no auth required, no rate limit
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (secret) {
        const auth = req.headers['authorization'] ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const tokenBuf = Buffer.from(token);
        const secretBuf = Buffer.from(secret);
        if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Reject oversized request bodies early via Content-Length header
      const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
      if (contentLength > MAX_REQUEST_BODY_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request body too large' }));
        return;
      }

      // Rate limiting per IP
      const ip = req.socket.remoteAddress ?? 'unknown';
      const now = Date.now();
      let bucket = rateCounts.get(ip);
      if (!bucket || now >= bucket.resetAt) {
        bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
        rateCounts.set(ip, bucket);
      }
      bucket.count++;
      if (bucket.count > RATE_MAX) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((bucket.resetAt - now) / 1000)) });
        res.end(JSON.stringify({ error: 'Too many requests' }));
        return;
      }

      // Detect new-client initialization: POST without mcp-session-id header.
      // If the server already has an active session, the old client is stale
      // (crashed / lost connection without sending DELETE). Recycle it.
      if (req.method === 'POST' && !req.headers['mcp-session-id'] && activeTransport) {
        try {
          await recycleStaleSession();
        } catch (err: unknown) {
          process.stderr.write(`LYNOX MCP session recycle failed: ${String(err)}\n`);
        }
      }

      if (!activeTransport) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No active transport' }));
        return;
      }
      try {
        await activeTransport.handleRequest(req, res);
      } catch (err: unknown) {
        const msg = getErrorMessage(err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        process.stderr.write(`LYNOX MCP request failed: ${msg}\n`);
      }
    });
    server.on('error', (err: Error) => {
      process.stderr.write(`LYNOX MCP server error: ${err.message}\n`);
    });
    // Bind to localhost when no auth secret is set to prevent unauthenticated network exposure
    const host = secret ? '0.0.0.0' : '127.0.0.1';
    server.listen(port, host, () => {
      const authStatus = secret ? '(auth enabled)' : '(localhost only — no auth)';
      process.stderr.write(`LYNOX MCP server listening on http://${host}:${port} ${authStatus}\n`);
      if (secret && host === '0.0.0.0') {
        process.stderr.write(
          '⚠ MCP is network-exposed over plain HTTP — Bearer token is sent unencrypted.\n' +
          '  Use a TLS-terminating reverse proxy (Caddy, nginx, Cloudflare Tunnel) in production.\n',
        );
      }
    });
  }

}
