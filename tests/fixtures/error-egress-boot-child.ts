/**
 * Child for `error-egress-boot.test.ts`: boots a real Engine on a data dir whose engine.db holds
 * the exact marker, with a Bugsink DSN set, then leaves a rejection nobody handles.
 * argv: <data dir>
 */
import * as Sentry from '@sentry/node';
import { Engine } from '../../src/core/engine.js';
import { EngineDb } from '../../src/core/engine-db.js';
import type { LynoxConfig } from '../../src/types/index.js';

const dir = process.argv[2]!;
process.env['LYNOX_DATA_DIR'] = dir;
process.env['LYNOX_BUGSINK_DSN'] = 'https://key@bugs.example.invalid/1';
for (const k of ['ANTHROPIC_LOG', 'LYNOX_MANAGED_INSTANCE_ID', 'LYNOX_MANAGED_CONTROL_PLANE_URL', 'LYNOX_HTTP_SECRET']) delete process.env[k];

const db = new EngineDb();
db.setExactMarker();
db.close();

const engine = new Engine({} as LynoxConfig);
await engine.init();
// `Sentry.init` binds its client to the scope, and a refused client stays bound: no client
// means the init never ran.
process.stdout.write(`client:${Sentry.getClient() === undefined ? 'none' : 'built'}\n`);

void Promise.reject(Object.assign(new Error('provider said: PROVIDER-BODY-7f3a order of Jane Roe'), { status: 400 }));
setTimeout(() => {
  process.stdout.write('still-running\n');
  void engine.shutdown().finally(() => process.exit(0));
}, 200);
