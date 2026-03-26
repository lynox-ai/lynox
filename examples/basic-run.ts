/**
 * Basic lynox SDK usage — run a single task programmatically.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/basic-run.ts
 */
import { Lynox } from '@lynox-ai/core';

const lynox = new Lynox({ model: 'sonnet' });
await lynox.init();

const result = await lynox.run('What are the top 3 things I should know about TypeScript generics?');
console.log(result);

await lynox.shutdown();
