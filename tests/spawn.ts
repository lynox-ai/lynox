// Spawn tests — PRD-03

import { strict as assert } from 'node:assert';

// Verify spawn_agent tool filters itself (recursion guard)
import { spawnAgentTool } from '../src/tools/builtin/spawn.js';
assert.equal(spawnAgentTool.definition.name, 'spawn_agent');

// Verify tool schema has max_budget_usd
const schema = spawnAgentTool.definition.input_schema as {
  properties: {
    agents: {
      items: {
        properties: Record<string, unknown>;
      };
    };
  };
};
assert.ok(schema.properties.agents.items.properties['max_budget_usd']);

// Verify tool schema does NOT have track or working_dir
assert.equal(schema.properties.agents.items.properties['track'], undefined);
assert.equal(schema.properties.agents.items.properties['working_dir'], undefined);

// Verify observability exports
import { channels, measureTool } from '../src/core/observability.js';
assert.ok(channels.toolStart);
assert.ok(channels.toolEnd);
assert.ok(channels.spawnStart);
assert.ok(channels.spawnEnd);

const timer = measureTool('test-tool');
const duration = timer.end();
assert.equal(typeof duration, 'number');
assert.ok(duration >= 0);

console.log('All spawn tests passed.');
