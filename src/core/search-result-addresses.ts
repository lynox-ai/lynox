// === Search result addresses ===
//
// The page addresses that searches in this conversation listed as results, as the search provider
// gave them. Once foreign content is in the conversation, a read of exactly such an address passes
// the origin check without a question (`ToolEntry.readAddress`): the provider wrote the address, not
// the model. That is not "nothing from the conversation": which results come back depends on the
// query, so a search lets the model choose among every page a host has indexed, and a host that
// indexed pages for that purpose learns which one was chosen. What such a read can carry out is that
// choice, and any part or transformation of the query the listed address happens to hold: the filter
// below drops only an address that holds the whole query (as written, fetched or decoded).
//
// Only the result entries count, never text: a page or a result list can repeat what the model
// sent (a search query, a read's own address), and an address that came back that way would be the
// model's own input. For the same reason an entry whose address holds the query, or that the query
// holds, is left out. Nothing else adds to the set. It belongs to the conversation: every agent the
// session builds for it, a rebuilt one included, and every sub-agent it spawns share one holder, so a
// child reads what its parent's searches listed (a listed address is the provider's either way). A
// reloaded thread starts empty, which asks more, not less.
//
// The HOSTS of those results do not join the shell's egress set. A search arms the conversation's
// latch when it is dispatched, before its results exist, so every batch after it starts tainted, and
// a shell call whose batch started tainted takes no search's hosts (src/shell-sidecar/egress.ts).

/**
 * An address as it is fetched: the WHATWG form `new URL()` gives, the one the request is built from.
 * Not `trim()`: it removes Unicode spaces (U+3000 and others) that the URL parser instead encodes
 * into the path, so a trimmed comparison would let an address with data appended match a listed
 * one. `null` for an address that does not parse; it is never listed and never matches.
 */
export function fetchedForm(address: string): string | null {
  try {
    return new URL(address).href;
  } catch {
    return null;
  }
}

/**
 * The forms an address is compared with the query in, lower case: as the provider wrote it, as it
 * is fetched, and that form decoded (`%20` back to a space, `%C3%BC` back to `ü`). The fetched form
 * alone encodes spaces and other characters and lowers the host, so a query `secret data` would not
 * be found in `https://x.example/secret%20data`.
 */
function formsOf(raw: string, fetched: string): string[] {
  const forms = [raw.trim().toLowerCase(), fetched.toLowerCase()];
  try {
    forms.push(decodeURI(fetched).toLowerCase());
  } catch {
    // An encoding decodeURI refuses: the other two forms stand.
  }
  return forms;
}

export class SearchResultAddresses {
  private readonly _seen = new Set<string>();

  /** Notes the result addresses of one search for `query`. */
  noteResults(query: string, addresses: readonly string[]): void {
    const q = query.trim().toLowerCase();
    for (const raw of addresses) {
      const address = fetchedForm(raw);
      if (address === null) continue;
      if (q !== '' && formsOf(raw, address).some((f) => f.includes(q) || q.includes(f))) continue;
      this._seen.add(address);
    }
  }

  /** Whether a search listed this address, compared in the form it is fetched in. */
  has(address: string): boolean {
    const fetched = fetchedForm(address);
    return fetched !== null && this._seen.has(fetched);
  }
}
