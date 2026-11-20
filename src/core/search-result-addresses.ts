// === Search result addresses ===
//
// The page addresses that searches in this conversation listed as results, as the search provider
// gave them. Once foreign content is in the conversation, a read of exactly such an address passes
// the origin check without a question (`ToolEntry.readAddress`): the provider chose it, so it holds
// nothing the model added.
//
// Only the result entries count, never text: a page or a result list can repeat what the model
// sent (a search query, a read's own address), and an address that came back that way would be the
// model's own input. For the same reason an entry whose address holds the query, or that the query
// holds, is left out. Nothing else adds to the set, and it lives as long as the agent: a reloaded
// thread starts empty, which asks more, not less.

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

export class SearchResultAddresses {
  private readonly _seen = new Set<string>();

  /** Notes the result addresses of one search for `query`. */
  noteResults(query: string, addresses: readonly string[]): void {
    const q = query.trim();
    for (const raw of addresses) {
      const address = fetchedForm(raw);
      if (address === null) continue;
      if (q !== '' && (address.includes(q) || q.includes(address) || q.includes(raw.trim()))) continue;
      this._seen.add(address);
    }
  }

  /** Whether a search listed this address, compared in the form it is fetched in. */
  has(address: string): boolean {
    const fetched = fetchedForm(address);
    return fetched !== null && this._seen.has(fetched);
  }
}
