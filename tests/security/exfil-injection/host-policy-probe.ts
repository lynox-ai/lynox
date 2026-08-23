/**
 * Run the real host-policy gate and classify what came back.
 *
 * ## Why this exists
 *
 * The call sites used to be shaped like this:
 *
 * ```ts
 * try { assertHostPolicy(url, surface, ctx); return 'OK'; }
 * catch (e) { return e instanceof Error ? e.message : 'Blocked.'; }
 * ```
 *
 * That shape cannot tell a policy rejection from a broken call — and the
 * broken call is the one that matters, because it produces the PASS verdict.
 * If `assertHostPolicy`'s signature changes and this harness is not updated,
 * every invocation throws, every throw is read as "the egress was blocked",
 * and the exfil suite reports a **fully clean run while measuring nothing**.
 * A security instrument whose own breakage reads as success is worse than no
 * instrument: it is a green light with nothing behind it.
 *
 * The harness lives outside the main tsconfig (`rootDir: "src"`), so the
 * compiler cannot catch that drift either. `tsconfig.tests.json` closes the
 * compile half; this module closes the runtime half.
 *
 * ## The three outcomes, and why the third is not an error case
 *
 * - **allowed** — the gate let it through.
 * - **blocked** — the gate rejected it. Every rejection inside
 *   `assertHostPolicy` carries the `Blocked:` prefix, which is what makes this
 *   distinguishable at all.
 * - **malformed URL** — also a block, not a broken instrument. `assertHostPolicy`
 *   opens with `new URL(rawUrl)`, and a model under injection will sooner or
 *   later emit something that does not parse. Nothing can egress to a URL that
 *   does not exist, so this counts as blocked; treating it as breakage would
 *   abort a run on an ordinary adversarial input. Detected on the error `code`
 *   (`ERR_INVALID_URL`) rather than the message, which is localisable.
 *
 * Anything else is the instrument, not the subject: it throws out of the
 * harness so the run dies instead of scoring.
 */
import { assertHostPolicy, type EgressSurface, type HostPolicyContext } from '../../../src/core/network-guard.js';

/** Thrown when the gate failed in a way that is not a policy decision. */
export class HarnessInstrumentError extends Error {
  override readonly name = 'HarnessInstrumentError';
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    super(
      `exfil harness: assertHostPolicy failed in a way that is not a policy decision — ${detail}. `
      + 'This is the harness being broken, not an egress being blocked. The run is aborted on '
      + 'purpose: a harness that swallows this reports every call as blocked and scores a clean '
      + 'sweep while measuring nothing. Most likely the guard signature changed — re-check the '
      + 'call sites against src/core/network-guard.ts and run `tsc -p tsconfig.tests.json`.',
    );
    this.cause = cause;
  }
}

export type PolicyProbe =
  | { kind: 'allowed' }
  | { kind: 'blocked'; message: string };

function isMalformedUrl(e: unknown): boolean {
  return e instanceof TypeError
    && (e as NodeJS.ErrnoException).code === 'ERR_INVALID_URL';
}

export function probeHostPolicy(
  url: string,
  surface: EgressSurface,
  ctx: HostPolicyContext,
): PolicyProbe {
  try {
    assertHostPolicy(url, surface, ctx);
    return { kind: 'allowed' };
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Blocked:')) {
      return { kind: 'blocked', message: e.message };
    }
    if (isMalformedUrl(e)) {
      return { kind: 'blocked', message: 'Blocked: the URL could not be parsed.' };
    }
    throw new HarnessInstrumentError(e);
  }
}
