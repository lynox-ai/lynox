import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

export const channels = {
  toolStart:    channel('lynox:tool:start'),
  toolEnd:      channel('lynox:tool:end'),
  spawnStart:   channel('lynox:spawn:start'),
  spawnEnd:     channel('lynox:spawn:end'),
  costWarning:  channel('lynox:cost:warning'),
  preApprovalMatch:     channel('lynox:preapproval:match'),
  preApprovalExhausted: channel('lynox:preapproval:exhausted'),
  preApprovalExpired:   channel('lynox:preapproval:expired'),
  dagNotify:            channel('lynox:dag:notify'),

  memoryStore:          channel('lynox:memory:store'),
  memoryExtraction:     channel('lynox:memory:extraction'),
  contentTruncation:    channel('lynox:content:truncation'),
  fileWatcherFallback:  channel('lynox:filewatcher:fallback'),
  secretAccess:         channel('lynox:secret:access'),
  guardBlock:           channel('lynox:guard:block'),
  securityBlocked:      channel('lynox:security:blocked'),
  securityFlagged:      channel('lynox:security:flagged'),
  securityInjection:    channel('lynox:security:injection'),

  knowledgeGraph:       channel('lynox:knowledge:graph'),
  knowledgeEntity:      channel('lynox:knowledge:entity'),
  dataStoreInsert:      channel('lynox:datastore:insert'),

  shapeApplied:         channel('lynox:apishape:applied'),
  shapeError:           channel('lynox:apishape:error'),

  /**
   * Emitted once per web search provider call with engine-level attribution:
   *   { provider, queryHash, queryLength, resultCount, engines, unresponsiveEngines, durationMs }
   *
   * Privacy: NEVER carries the raw query string. Subscribers see a 16-char
   * sha256 prefix + length, enough to group repeat queries and correlate
   * over time but not recover content. This deliberately differs from the
   * other channels — most internal events ship business state; web-search
   * queries can carry user PII or confidential intent.
   *
   * Throttling: emitted once per `web_search` tool call. Multi-user
   * managed instances can fire many per second under load. Subscribers
   * MUST aggregate or sample before forwarding to external systems
   * (Bugsink, OTel, …) — there is no built-in rate limiter on the channel.
   */
  webSearch:            channel('lynox:websearch:call'),
};

export function measureTool(name: string): { end(): number } {
  const markName = `lynox:tool:${name}:${performance.now()}`;
  performance.mark(markName);
  return {
    end(): number {
      const endMark = `${markName}:end`;
      performance.mark(endMark);
      const measure = performance.measure(`lynox:tool:${name}`, markName, endMark);
      const duration = measure.duration;
      performance.clearMarks(markName);
      performance.clearMarks(endMark);
      performance.clearMeasures(measure.name);
      return duration;
    },
  };
}
