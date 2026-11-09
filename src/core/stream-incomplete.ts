/**
 * A reply stream that ended without a stop reason (no `message_delta` naming one, no
 * `message_stop`): the provider closed the response cleanly after part of the reply, so what
 * arrived is not the whole answer. Neither stream object reports this on its own: the Anthropic
 * SDK's `BetaMessageStream` ends normally on any stream that began with `message_start`, and the
 * openai-compatible adapter emits its terminal events only after a `finish_reason`, or after a
 * `[DONE]` with no error chunk before it. Thrown by `StreamProcessor.process`, it is transient:
 * the Agent retries the call and books the ended attempt like one ended by an error inside the stream.
 *
 * Its own module, so that a test replacing the stream processor (`vi.mock('./stream.js')`) leaves
 * the Agent's retry decision able to recognise it.
 */
export class StreamIncompleteError extends Error {
  /** Stable code the run stream's terminal `error` event carries for this failure; the Web UI names it from the code, never from the message. */
  static readonly CODE = 'stream_incomplete';

  constructor() {
    super('the AI service ended the reply before it was finished');
    this.name = 'StreamIncompleteError';
  }
}
