import type { TriggerConfig, ITrigger } from '../../types/index.js';
import { FileTrigger } from './file-trigger.js';
import { HttpTrigger } from './http-trigger.js';
import { CronTrigger } from './cron-trigger.js';
import { GitTrigger } from './git-trigger.js';

export function createTrigger(config: TriggerConfig): ITrigger {
  switch (config.type) {
    case 'file': return new FileTrigger(config);
    case 'http': return new HttpTrigger(config);
    case 'cron': return new CronTrigger(config);
    case 'git':  return new GitTrigger(config);
  }
}

export { FileTrigger } from './file-trigger.js';
export { HttpTrigger } from './http-trigger.js';
export { CronTrigger } from './cron-trigger.js';
export { GitTrigger } from './git-trigger.js';
