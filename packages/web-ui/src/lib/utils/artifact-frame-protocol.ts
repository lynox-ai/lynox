/**
 * The contract between the app and the artifact frame endpoint, shared by both sides.
 *
 * An artifact is a document the model wrote. It runs in `/_artifact-frame`, a same-origin URL
 * whose own response header sandboxes it, so it gets an opaque origin however it is embedded or
 * opened. The endpoint serves one fixed bootstrap and nothing from the request; the bootstrap
 * says `ready`, with the key from its URL fragment, to the window that embedded or opened it,
 * and writes the first `render` it gets from exactly that window as its document. That is the
 * whole protocol.
 *
 * Constants only, no browser globals: the server endpoint imports this module too.
 */

/** The endpoint's path. The hooks treat it as the one same-origin URL that may be framed. */
export const ARTIFACT_FRAME_PATH = '/_artifact-frame';

/** Sent by the bootstrap to its parent (a frame) or its opener (the print window). */
export const FRAME_READY = 'lynox-frame-ready';

/**
 * The field of `ready` that carries the frame's key. The app puts a fresh random key in the
 * fragment of every frame URL it loads; the bootstrap reads it from `location.hash` and sends it
 * back. Only a document the app itself loaded at that URL knows it, so a `ready` from any other
 * document in the same window (one the frame was navigated to) cannot name it. The fragment never
 * reaches the server, so it changes neither the response nor its cache key.
 */
export const FRAME_KEY_FIELD = 'key';

/** Sent back once, carrying the whole document the bootstrap writes. */
export const FRAME_RENDER = 'lynox-frame-render';

/** The query flag of the print window: its policy also allows the print dialog. */
export const FRAME_PRINT_PARAM = 'print';

/** The query key of the build version, which makes the bootstrap cacheable per build. */
export const FRAME_VERSION_PARAM = 'v';
