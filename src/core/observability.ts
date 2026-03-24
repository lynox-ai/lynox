import { channel } from 'node:diagnostics_channel';
import { performance } from 'node:perf_hooks';

export const channels = {
  toolStart:    channel('nodyn:tool:start'),
  toolEnd:      channel('nodyn:tool:end'),
  spawnStart:   channel('nodyn:spawn:start'),
  spawnEnd:     channel('nodyn:spawn:end'),
  modeChange:   channel('nodyn:mode:change'),
  triggerFire:  channel('nodyn:trigger:fire'),
  costWarning:  channel('nodyn:cost:warning'),
  goalUpdate:   channel('nodyn:goal:update'),
  preApprovalMatch:     channel('nodyn:preapproval:match'),
  preApprovalExhausted: channel('nodyn:preapproval:exhausted'),
  preApprovalExpired:   channel('nodyn:preapproval:expired'),
  dagNotify:            channel('nodyn:dag:notify'),

  memoryStore:          channel('nodyn:memory:store'),
  memoryExtraction:     channel('nodyn:memory:extraction'),
  contentTruncation:    channel('nodyn:content:truncation'),
  fileWatcherFallback:  channel('nodyn:filewatcher:fallback'),
  secretAccess:         channel('nodyn:secret:access'),
  guardBlock:           channel('nodyn:guard:block'),
  securityBlocked:      channel('nodyn:security:blocked'),
  securityFlagged:      channel('nodyn:security:flagged'),
  securityInjection:    channel('nodyn:security:injection'),

  knowledgeGraph:       channel('nodyn:knowledge:graph'),
  knowledgeEntity:      channel('nodyn:knowledge:entity'),
  dataStoreInsert:      channel('nodyn:datastore:insert'),
};

export function measureTool(name: string): { end(): number } {
  const markName = `nodyn:tool:${name}:${performance.now()}`;
  performance.mark(markName);
  return {
    end(): number {
      const endMark = `${markName}:end`;
      performance.mark(endMark);
      const measure = performance.measure(`nodyn:tool:${name}`, markName, endMark);
      const duration = measure.duration;
      performance.clearMarks(markName);
      performance.clearMarks(endMark);
      performance.clearMeasures(measure.name);
      return duration;
    },
  };
}
