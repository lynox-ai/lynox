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
