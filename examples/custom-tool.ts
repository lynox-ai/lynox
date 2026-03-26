/**
 * Register a custom tool and let the agent use it.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/custom-tool.ts
 */
import { Lynox } from '@lynox-ai/core';

const lynox = new Lynox({ model: 'sonnet' });
await lynox.init();

// Register a tool that returns the current UTC time
lynox.addTool({
  definition: {
    type: 'custom' as const,
    name: 'get_current_time',
    description: 'Returns the current date and time in UTC.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  handler: async () => new Date().toISOString(),
});

const result = await lynox.run('What time is it right now? Use the get_current_time tool.');
console.log(result);

await lynox.shutdown();
