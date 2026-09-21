/**
 * engine-client — drives one engine headless over its HTTP API and records what
 * happened, so a flow can be judged on its END STATE rather than on the model's text.
 *
 * Only the public API is used: `POST /api/sessions`, `POST /api/sessions/:id/run`
 * (SSE), `POST /api/sessions/:id/reply`, `GET /api/threads/:id/debug-export`.
 * Prompts are answered by a flow-supplied policy; every prompt, its answer and the
 * time of both are kept, because several checks are about ORDER (e.g. a write that
 * happened before its approval was given).
 *
 * Token usage is taken from the SSE `done` event. Tool calls are taken from the stream,
 * not from `GET /api/history/runs/:id/tool-calls`: that route lists only calls whose
 * handler ran (a call rejected at input validation or naming an unknown tool is
 * missing), and it stores `output_json` empty on success, so it cannot tell
 * "cancelled" from "sent".
 */

export class EngineClient {
  /** @param {{ base: string, token: string }} opts */
  constructor({ base, token }) {
    this.base = base.replace(/\/$/, '');
    this.token = token;
  }

  async api(path, init = {}) {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    return res;
  }

  async json(path, init = {}) {
    const res = await this.api(path, init);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    return { status: res.status, body };
  }

  async waitHealthy(timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${this.base}/health`);
        if (r.status === 200) return true;
      } catch { /* not up yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  async createSession() {
    const { status, body } = await this.json('/api/sessions', { method: 'POST', body: '{}' });
    if (status !== 200 && status !== 201) throw new Error(`POST /api/sessions -> ${status} ${JSON.stringify(body)}`);
    return { sessionId: body.sessionId ?? body.id, threadId: body.threadId ?? body.sessionId };
  }

  /**
   * Run one task to completion.
   *
   * @param {string} sessionId
   * @param {string} task
   * @param {{
   *   answer: (prompt: { promptId: string, question: string, options: string[] }) => string,
   *   deadlineMs?: number,
   * }} policy
   * @returns {Promise<RunRecord>}
   */
  async run(sessionId, task, policy) {
    const started = Date.now();
    const record = {
      sessionId,
      startedAt: new Date(started).toISOString(),
      events: /** @type {Array<{t:number,event:string,data:unknown}>} */ ([]),
      prompts: /** @type {Array<{promptId:string,question:string,options:string[],askedAt:number,answer:string,answeredAt:number,replyStatus:number}>} */ ([]),
      toolCalls: /** @type {Array<{t:number,name:string,input:unknown}>} */ ([]),
      toolResults: /** @type {Array<{t:number,name:string,result:string,isError:boolean}>} */ ([]),
      turns: /** @type {Array<{t:number,stopReason:string,inputTokens:number,outputTokens:number}>} */ ([]),
      done: /** @type {null | {result:string, usage: Record<string, unknown>}} */ (null),
      error: /** @type {null | string} */ (null),
      timedOut: false,
      durationMs: 0,
    };
    const deadline = started + (policy.deadlineMs ?? 15 * 60_000);
    const res = await this.api(`/api/sessions/${sessionId}/run`, { method: 'POST', body: JSON.stringify({ task }) });
    if (!res.ok || !res.body) {
      record.error = `run -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      record.durationMs = Date.now() - started;
      return record;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let ev = { event: 'message', data: '' };
    const handle = async (event, dataRaw) => {
      let data;
      try { data = JSON.parse(dataRaw); } catch { data = dataRaw; }
      const t = Date.now() - started;
      record.events.push({ t, event, data });
      if (event === 'prompt' && data && typeof data === 'object') {
        const p = { promptId: data.promptId, question: String(data.question ?? ''), options: Array.isArray(data.options) ? data.options : [] };
        const answer = policy.answer(p);
        const askedAt = t;
        const r = await this.api(`/api/sessions/${sessionId}/reply`, { method: 'POST', body: JSON.stringify({ promptId: p.promptId, answer }) });
        record.prompts.push({ ...p, askedAt, answer, answeredAt: Date.now() - started, replyStatus: r.status });
      } else if (event === 'tool_call' && data && typeof data === 'object') {
        record.toolCalls.push({ t, name: data.name, input: data.input });
      } else if (event === 'tool_result' && data && typeof data === 'object') {
        record.toolResults.push({ t, name: data.name, result: String(data.result ?? ''), isError: data.isError === true });
      } else if (event === 'turn_end' && data && typeof data === 'object') {
        const u = data.usage ?? {};
        record.turns.push({ t, stopReason: data.stop_reason, inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0) });
      } else if (event === 'done' && data && typeof data === 'object') {
        record.done = { result: String(data.result ?? ''), usage: data.usage ?? {} };
      } else if (event === 'error') {
        record.error = typeof data === 'string' ? data : JSON.stringify(data);
      }
    };
    try {
      for (;;) {
        if (Date.now() > deadline) { record.timedOut = true; break; }
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, '');
          buf = buf.slice(nl + 1);
          if (line === '') {
            if (ev.data !== '') await handle(ev.event, ev.data);
            ev = { event: 'message', data: '' };
          } else if (line.startsWith('event:')) {
            ev.event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            ev.data += (ev.data ? '\n' : '') + line.slice(5).replace(/^ /, '');
          }
        }
      }
    } finally {
      try { await reader.cancel(); } catch { /* already closed */ }
    }
    if (record.timedOut) {
      try { await this.api(`/api/sessions/${sessionId}/abort`, { method: 'POST', body: '{}' }); } catch { /* best effort */ }
    }
    record.durationMs = Date.now() - started;
    return record;
  }

  async debugExport(threadId) {
    const { status, body } = await this.json(`/api/threads/${threadId}/debug-export`);
    return status === 200 ? body : null;
  }

  async collection(name) {
    const { status, body } = await this.json(`/api/datastore/${encodeURIComponent(name)}?limit=500`);
    return { status, body };
  }
}

/**
 * @typedef {Awaited<ReturnType<EngineClient['run']>>} RunRecord
 */

/** Sum the usage of a run as the engine reports it in `done`. */
export function runUsage(record) {
  const u = record.done?.usage ?? {};
  return {
    tokensIn: Number(u.tokensIn ?? 0),
    tokensOut: Number(u.tokensOut ?? 0),
    cacheRead: Number(u.cacheRead ?? 0),
    cacheWrite: Number(u.cacheWrite ?? 0),
    model: typeof u.model === 'string' ? u.model : null,
    engineCostUsd: Number(u.costUsd ?? 0),
  };
}
