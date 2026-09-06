/**
 * Bridge the pinned transport back onto a `globalThis.fetch` stub.
 *
 * Since PRD Stage 1 §3.8 every authenticated Google call rides
 * `googleFetch`/`cpFetch` → `fetchWithValidatedRedirects` → `fetchPinned`, which
 * does its own DNS resolve and opens the socket through `node:http(s)`. It never
 * calls `globalThis.fetch`. Test files that stub the global therefore stop being
 * consulted the moment their subject moves onto the connector surface — and the
 * failure is not subtle, it is every assertion at once.
 *
 * Two ways to answer that, and the choice matters:
 *
 *  - rewrite each suite against the pinned transport — accurate, and it makes
 *    every one of them a network-guard test as well as a Drive/Gmail test;
 *  - adapt the transport back onto the stub they already have.
 *
 * This is the second, for the same reason `http.test.ts` chose it: the subject
 * of those suites is Drive/Sheets/Docs/Calendar/Gmail behaviour, not the
 * transport, and rewriting 250 assertions to prove that would test the bridge
 * rather than the product. What the connector surface itself does — the host
 * set, the policy branch, the per-hop re-check — is asserted directly in
 * `src/core/connector-egress.test.ts`, on the real guard, with no bridge.
 *
 * ⚠ It deliberately does NOT bypass `assertHostPolicy`: a call through this
 * bridge is still policy-checked, so a suite whose subject moved to a host
 * outside `GOOGLE_API_HOSTS` fails here rather than passing quietly. The bridge
 * replaces the SOCKET, not the gate.
 */
import { setPinnedTransportForTests } from '../../src/core/network-guard.js';

/**
 * Install the bridge. Returns the restore handle — call it in `afterAll`, or
 * the transport leaks into whatever file vitest runs next in the same worker.
 */
export function installPinnedFetchBridge(): () => void {
  return setPinnedTransportForTests(async (input) => {
    // `fetchPinned` adds a `host` header the legacy fetch path never exposed;
    // strip it so header assertions in the suites keep meaning what they meant.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers)) {
      if (k.toLowerCase() === 'host') continue;
      headers[k] = v;
    }
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== undefined) init.body = input.body.toString('utf8');
    if (input.signal) init.signal = input.signal;
    return (globalThis.fetch as typeof fetch)(input.url, init);
  });
}

/**
 * The `node:dns/promises` stand-in every bridged suite needs, because
 * `fetchPinned` resolves the hostname BEFORE it reaches the transport. Without
 * it the suites do real DNS: slow when the network is there, failing when it is
 * not, and in both cases measuring the resolver instead of the subject.
 *
 * Returns a public address on purpose — `fetchPinned` refuses a private one, so
 * a loopback answer here would turn every bridged call into a `Blocked:` error
 * that looks exactly like a policy decision.
 *
 * Must be used from a hoisted `vi.mock` factory in the test file itself; a
 * module mock cannot be installed from a helper.
 */
export function dnsLookupStub(): Array<{ address: string; family: number }> {
  return [{ address: '93.184.216.34', family: 4 }];
}
