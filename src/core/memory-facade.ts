import type { Memory } from './memory.js';
import type { KnowledgeLayer } from './knowledge-layer.js';
import type { MemoryNamespace } from '../types/index.js';

/** A memory doc line's date stamp — stripped so the KG mirror matches the stored statement text. */
const DATE_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2}\]\s*/;

/**
 * Single choke point for memory MUTATIONS so the flat-file document store and the
 * knowledge layer (the recall authority — ambient context injection reads ONLY the
 * KG) never drift apart.
 *
 * The `memory_*` tool handlers already synced both stores on store/delete/update;
 * the HTTP `/api/memory/:ns` routes did NOT — so a UI inline edit was a silent no-op
 * (wrong body keys → empty update) and a UI delete/edit left the fact live in the
 * KG, where it kept flowing into the agent's context indefinitely (a privacy-adjacent
 * trust breach). Routing the routes through this facade fixes that class at the root:
 * "what the UI changed" ⇒ "what the agent recalls".
 *
 * Scope: the facade mirrors under the document store's own default scope
 * (`memory.currentScope()`), which is exactly the scope the bare `/api/memory` routes
 * write to. For append/update/replace the KG mirror is best-effort — the document is
 * the source of truth, so a KG hiccup must not fail the user's edit — but it is AWAITED
 * (not fire-and-forget) so the next recall is already consistent when the HTTP response
 * returns, and a failure is logged (a silently-broken privacy promise is worse than a
 * noisy one). `delete` is the DELIBERATE exception: it is a hard erasure (GDPR Art. 17),
 * so a failed KG reap must NOT be swallowed — it propagates, and the HTTP route surfaces
 * the failure (a silently-failed erasure leaves "deleted" content recallable).
 */
export class MemoryFacade {
  constructor(
    private readonly memory: Memory,
    private readonly knowledgeLayer: KnowledgeLayer | null,
  ) {}

  /** Append a user-authored line to the document AND the knowledge graph. */
  async append(ns: MemoryNamespace, text: string): Promise<void> {
    await this.memory.append(ns, text);
    await this._storeToKg(text, ns);
  }

  /** Replace the whole namespace document AND reconcile the KG line-by-line. */
  async replaceDocument(ns: MemoryNamespace, newContent: string): Promise<void> {
    const before = (await this.memory.load(ns)) ?? '';
    await this.memory.save(ns, newContent);
    if (!this.knowledgeLayer) return;
    const beforeLines = this._lineSet(before);
    const afterLines = this._lineSet(newContent);
    const survivors = [...afterLines];
    for (const line of beforeLines) {
      if (afterLines.has(line)) continue;
      // deactivateByPattern is a LIKE %body% substring match: if a removed line's body
      // is contained in a SURVIVING line, deactivating it would also retire the
      // survivor's KG twin (silent recall loss of a still-present fact). Skip those —
      // the survivor's twin stays, which is correct.
      if (survivors.some(s => s.includes(line))) continue;
      await this._deactivateInKg(line, ns);
    }
    for (const line of afterLines) {
      if (!beforeLines.has(line)) await this._storeToKg(line, ns);
    }
  }

  /**
   * Delete every document line matching `pattern` AND hard-erase the KG twins.
   * Erasure (GDPR Art. 17) is deliberately NOT best-effort like the other mirrors:
   * the KG erase runs UNCONDITIONALLY — not gated on the flat-file line count, so a
   * document-ingest row with no flat-file twin is still forgotten — and a failure
   * PROPAGATES (the HTTP route returns an error) rather than being swallowed, because
   * a silently-failed erasure leaves "deleted" content recallable.
   */
  async delete(ns: MemoryNamespace, pattern: string): Promise<number> {
    // An empty/whitespace pattern substring-matches every line — refuse it so a
    // malformed request can't wipe the whole notebook (the KG side already guards
    // empty in _eraseInKg; this guards the flat-file delete too).
    if (!pattern.trim()) return 0;
    const count = await this.memory.delete(ns, pattern);
    await this._eraseInKg(pattern, ns);
    return count;
  }

  /** Replace `oldText`→`newText` in the document AND the KG. Returns whether it changed. */
  async update(ns: MemoryNamespace, oldText: string, newText: string): Promise<boolean> {
    const updated = await this.memory.update(ns, oldText, newText);
    if (updated && this.knowledgeLayer) {
      const oldBody = oldText.replace(DATE_PREFIX_RE, '').trim();
      const newBody = newText.replace(DATE_PREFIX_RE, '').trim();
      if (oldBody) await this._updateInKg(oldBody, newBody, ns);
    }
    return updated;
  }

  /** Non-empty document lines, date-prefix stripped — the form the KG stores text in. */
  private _lineSet(doc: string): Set<string> {
    const out = new Set<string>();
    for (const raw of doc.split('\n')) {
      const body = raw.replace(DATE_PREFIX_RE, '').trim();
      if (body) out.add(body);
    }
    return out;
  }

  private async _storeToKg(text: string, ns: MemoryNamespace): Promise<void> {
    if (!this.knowledgeLayer) return;
    const body = text.replace(DATE_PREFIX_RE, '').trim();
    if (!body) return;
    try {
      await this.knowledgeLayer.store(body, ns, this.memory.currentScope(), { sourceType: 'user_asserted' });
    } catch (err) { this._warnMirror('store', err); }
  }

  private async _deactivateInKg(pattern: string, ns: MemoryNamespace): Promise<void> {
    if (!this.knowledgeLayer) return;
    const body = pattern.replace(DATE_PREFIX_RE, '').trim();
    if (!body) return;
    try { await this.knowledgeLayer.deactivateByPattern(body, ns); } catch (err) { this._warnMirror('deactivate', err); }
  }

  /**
   * Hard-erase the KG twins of a deleted line. Unlike {@link _deactivateInKg} this is
   * NOT wrapped in a swallow — an erasure that fails to reap the recall mirror must
   * surface (privacy: a swallowed failure leaves the content recallable), so the
   * rejection propagates to the caller.
   */
  private async _eraseInKg(pattern: string, ns: MemoryNamespace): Promise<void> {
    if (!this.knowledgeLayer) return;
    const body = pattern.replace(DATE_PREFIX_RE, '').trim();
    if (!body) return;
    await this.knowledgeLayer.eraseByPattern(body, ns);
  }

  private async _updateInKg(oldBody: string, newBody: string, ns: MemoryNamespace): Promise<void> {
    if (!this.knowledgeLayer) return;
    try { await this.knowledgeLayer.updateMemoryText(oldBody, newBody, ns, this.memory.currentScope()); } catch (err) { this._warnMirror('update', err); }
  }

  /** A swallowed KG-mirror failure must leave a trace — else the privacy/recall promise breaks invisibly. */
  private _warnMirror(op: string, err: unknown): void {
    process.stderr.write(`[lynox:memory-facade] KG mirror ${op} failed (document write kept): ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
