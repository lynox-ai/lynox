/**
 * Run a DAG pipeline from a JSON manifest.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx examples/run-pipeline.ts
 */
import { loadManifestFile, runManifest, loadConfig } from '@lynox-ai/core';

const manifest = loadManifestFile(new URL('./pipeline.json', import.meta.url).pathname);
const config = loadConfig();

const state = await runManifest(manifest, config, {
  hooks: {
    onStepStart: (stepId) => console.log(`▶ Starting: ${stepId}`),
    onStepComplete: (output) => {
      console.log(`✅ Done: ${output.stepId} (${output.durationMs}ms)`);
      console.log(output.result.slice(0, 200), '\n');
    },
  },
});

console.log('--- Pipeline complete ---');
for (const [id, output] of state.outputs) {
  console.log(`\n[${id}]`);
  console.log(output.result);
}
