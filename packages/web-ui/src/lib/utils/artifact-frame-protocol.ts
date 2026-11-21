/**
 * The contract between the app and the artifact frame endpoint, shared by both sides.
 *
 * An artifact is a document the model wrote. It runs in `/_artifact-frame`, a same-origin URL
 * whose own response header sandboxes it, so it gets an opaque origin however it is embedded or
 * opened. The endpoint serves one fixed bootstrap and nothing from the request; the bootstrap
 * says `ready` to the window that embedded or opened it and writes the first `render` it gets
 * from exactly that window as its document. That is the whole protocol.
 *
 * Constants only, no browser globals: the server endpoint imports this module too.
 */

/** The endpoint's path. The hooks treat it as the one same-origin URL that may be framed. */
export const ARTIFACT_FRAME_PATH = '/_artifact-frame';

/** Sent by the bootstrap to its parent (a frame) or its opener (the print window). */
export const FRAME_READY = 'lynox-frame-ready';

/** Sent back once, carrying the whole document the bootstrap writes. */
export const FRAME_RENDER = 'lynox-frame-render';

/** The query flag of the print window: its policy also allows the print dialog. */
export const FRAME_PRINT_PARAM = 'print';

/** The query key of the build version, which makes the bootstrap cacheable per build. */
export const FRAME_VERSION_PARAM = 'v';
