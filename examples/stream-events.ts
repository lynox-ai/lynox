/**
 * Subscribe to stream events for real-time output.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/stream-events.ts
 */
import { Lynox } from '@lynox-ai/core';

const lynox = new Lynox({ model: 'sonnet' });
await lynox.init();

// Listen to stream events
lynox.onStream = (event) => {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.text);
      break;
    case 'thinking':
      console.log(`\n💭 [thinking] ${event.thinking.slice(0, 80)}...`);
      break;
    case 'thinking_done':
      console.log('💭 [thinking done]');
      break;
    case 'tool_call':
      console.log(`\n🔧 [tool] ${event.name}`);
      break;
    case 'turn_end':
      console.log(`\n✅ [done] stop_reason=${event.stop_reason}`);
      break;
  }
};

await lynox.run('Write a haiku about programming.');

await lynox.shutdown();
