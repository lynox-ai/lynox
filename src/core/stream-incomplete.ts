/**
 * A reply stream that ended without its `message_stop`: the provider closed the response cleanly
 * after part of the reply, so what arrived is not the whole answer. Neither stream object reports
 * this on its own: the Anthropic SDK's `BetaMessageStream` ends normally on any stream that began
 * with `message_start`, and the openai-compatible adapter emits `message_stop` only after a
 * `finish_reason` arrived. Thrown by `StreamProcessor.process`, it is transient: the Agent retries
 * the call and books the ended attempt like one ended by an error inside the stream.
 *
 * Its own module, so that a test replacing the stream processor (`vi.mock('./stream.js')`) leaves
 * the Agent's retry decision able to recognise it.
 */
export class StreamIncompleteError extends Error {
  constructor() {
    super('stream ended without message_stop: the reply is incomplete');
    this.name = 'StreamIncompleteError';
  }
}
