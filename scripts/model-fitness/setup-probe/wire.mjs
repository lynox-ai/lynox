/**
 * wire — one streamed chat call against an OpenAI-compatible endpoint, parsed by the
 * rules core's openai-adapter.ts applies: only `data: ` lines, `choices[0]`, tool
 * calls keyed by `delta.tool_calls[].index` with argument fragments concatenated per
 * index. Every raw stream is written next to the report.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createWire({ base, model, key, out, maxTokens = 8192 }) {
  let callNo = 0;
  /** One streamed chat call, parsed by the adapter's rules. */
  return async function chat(messages, tools, label) {
    const body = {
      model: model, messages, max_tokens: maxTokens,
      stream: true, stream_options: { include_usage: true }, temperature: 0,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    };
    const t0 = performance.now();
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const n = ++callNo;
    if (!res.ok || !res.body) {
      const text = await res.text();
      writeFileSync(join(out, `${String(n).padStart(3, '0')}-${label}.error.txt`), `${res.status}\n${text}`);
      return { ok: false, status: res.status, error: text.slice(0, 300), toolCalls: [], text: '', finish: null, usage: null, ttft: null, elapsed: performance.now() - t0 };
    }
    const dec = new TextDecoder();
    let raw = '';
    let buf = '';
    let ttft = null;
    let text = '';
    let reasoning = 0;
    let finish = null;
    let usage = null;
    const calls = new Map();
    for await (const chunk of res.body) {
      const s = dec.decode(chunk, { stream: true });
      raw += s;
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') continue;
        let c; try { c = JSON.parse(d); } catch { continue; }
        if (c.usage) usage = c.usage;
        if (!Array.isArray(c.choices) || !c.choices[0]) continue;
        const ch = c.choices[0];
        const delta = ch.delta ?? {};
        const r = delta.reasoning_content || delta.reasoning;
        if ((typeof delta.content === 'string' && delta.content) || (typeof r === 'string' && r) || delta.tool_calls) {
          if (ttft === null) ttft = performance.now() - t0;
        }
        if (typeof delta.content === 'string') text += delta.content;
        if (typeof r === 'string') reasoning += r.length;
        for (const tc of delta.tool_calls ?? []) {
          const slot = calls.get(tc.index) ?? { id: null, name: '', args: '' };
          if (tc.id && !slot.id) slot.id = tc.id;
          if (tc.function?.name && !slot.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          calls.set(tc.index, slot);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
    writeFileSync(join(out, `${String(n).padStart(3, '0')}-${label}.sse`), raw);
    const toolCalls = [...calls.entries()].map(([index, s]) => {
      let args = null; let argsOk = false;
      try { args = s.args ? JSON.parse(s.args) : {}; argsOk = args !== null && typeof args === 'object' && !Array.isArray(args); } catch { /* invalid */ }
      return { index, id: s.id ?? `call_${n}_${index}`, name: s.name, rawArgs: s.args, args, argsOk };
    });
    return { ok: true, status: res.status, toolCalls, text, reasoning, finish, usage, ttft, elapsed: performance.now() - t0 };
  };
}
