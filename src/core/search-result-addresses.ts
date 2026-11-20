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

export class SearchResultAddresses {
  private readonly _seen = new Set<string>();

  /** Notes the result addresses of one search for `query`. */
  noteResults(query: string, addresses: readonly string[]): void {
    const q = query.trim();
    for (const raw of addresses) {
      const address = raw.trim();
      if (address === '') continue;
      if (q !== '' && (address.includes(q) || q.includes(address))) continue;
      this._seen.add(address);
    }
  }

  /** Whether a search listed exactly this address. */
  has(address: string): boolean {
    return this._seen.has(address.trim());
  }
}
