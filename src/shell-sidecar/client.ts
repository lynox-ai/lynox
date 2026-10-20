/**
 * The engine's side of the exec socket (PRD 152 v2 §4.1, W1 plan S4/S5).
 *
 * The daemon's output is written by a pool uid, so the engine trusts none of it: only the
 * three frame shapes pass, every stream is capped like `execSync`'s `maxBuffer`, a stream
 * that ends without its exit frame is an error, and a client deadline stands even if the
 * daemon never answers. On any of these the connection is dropped — which is the daemon's
 * signal to kill the call.
 */

import { connect } from 'node:net';
import { parseFrame, capTimeout, MAX_RESPONSE_LINE_BYTES } from './protocol.js';

/** Time past the call's own limit before the client gives up on the daemon. */
export const CLIENT_GRACE_MS = 15_000;

export interface SidecarResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the daemon refused or could not start the call. */
  error?: string;
  /** The limit the call ran under, after capping. */
  limitMs: number;
}

/** The output passed `maxBytes` on one stream; what arrived so far is kept for the agent. */
export class SidecarOverflowError extends Error {
  constructor(readonly stdout: string, readonly stderr: string, readonly maxBytes: number) {
    super(`output exceeded ${String(maxBytes)} bytes`);
    this.name = 'SidecarOverflowError';
  }
}

/** The call's run was stopped; the connection was dropped, which makes the daemon kill the
 *  call. What the command printed until then is kept. */
export class SidecarStoppedError extends Error {
  constructor(readonly stdout: string, readonly stderr: string) {
    super('stopped because the run was stopped');
    this.name = 'SidecarStoppedError';
  }
}

export interface SidecarCall {
  cmd: string;
  timeoutMs: number | undefined;
  env: Record<string, string>;
}

export function execViaSidecar(socketPath: string, call: SidecarCall, maxBytes: number, graceMs = CLIENT_GRACE_MS, signal?: AbortSignal): Promise<SidecarResult> {
  const limitMs = capTimeout(call.timeoutMs);
  // A run stopped before the call: nothing is started.
  if (signal?.aborted === true) return Promise.reject(new SidecarStoppedError('', ''));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let pending = Buffer.alloc(0);
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let done = false;

    const fail = (err: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onStop);
      socket.destroy();
      reject(err);
    };
    const deadline = setTimeout(() => fail(new Error(`exec sidecar gave no exit within ${String(limitMs + graceMs)}ms`)), limitMs + graceMs);
    // A stop drops the connection like the deadline does; the daemon kills the call on that.
    const onStop = (): void => fail(new SidecarStoppedError(stdout, stderr));

    const onLine = (line: string): void => {
      const f = parseFrame(line);
      if (!f.ok) return fail(new Error(`exec sidecar sent a bad frame: ${f.error}`));
      const frame = f.value;
      if (frame.t === 'out' || frame.t === 'err') {
        const n = Buffer.byteLength(frame.d, 'utf8');
        if (frame.t === 'out') { outBytes += n; stdout += frame.d; } else { errBytes += n; stderr += frame.d; }
        if (outBytes > maxBytes || errBytes > maxBytes) fail(new SidecarOverflowError(stdout, stderr, maxBytes));
        return;
      }
      // The exit frame is the last thing the daemon sends; anything after it is an error too.
      done = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onStop);
      const rest = pending.length;
      socket.destroy();
      if (rest > 0) return reject(new Error('exec sidecar sent data after the exit frame'));
      const result: SidecarResult = { stdout, stderr, code: frame.code, signal: frame.signal, timedOut: frame.timedOut, limitMs };
      if (frame.error !== undefined) result.error = frame.error;
      resolve(result);
    };

    socket.on('data', (chunk: Buffer) => {
      if (done) return;
      pending = Buffer.concat([pending, chunk]);
      for (let nl = pending.indexOf(0x0a); nl >= 0 && !done; nl = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, nl).toString('utf8');
        pending = pending.subarray(nl + 1);
        onLine(line);
      }
      if (!done && pending.length > MAX_RESPONSE_LINE_BYTES) fail(new Error('exec sidecar sent an oversize line'));
    });
    socket.on('error', (err) => fail(new Error(`exec sidecar: ${err.message}`)));
    socket.on('close', () => fail(new Error('exec sidecar closed the stream without an exit frame')));
    socket.write(`${JSON.stringify({ cmd: call.cmd, timeoutMs: limitMs, env: call.env })}\n`);
    signal?.addEventListener('abort', onStop, { once: true });
  });
}
