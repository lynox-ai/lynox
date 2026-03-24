/**
 * Basic nodyn SDK usage — run a single task programmatically.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/basic-run.ts
 */
import { Nodyn } from '@nodyn-ai/core';

const nodyn = new Nodyn({ model: 'sonnet' });
await nodyn.init();

const result = await nodyn.run('What are the top 3 things I should know about TypeScript generics?');
console.log(result);

await nodyn.shutdown();
