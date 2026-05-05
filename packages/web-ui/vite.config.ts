import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Standalone dev: when VITE_ENGINE_URL is set, proxy /api/* to the Engine on
// another port so the UI can run with hot-reload while the Engine is started
// separately (e.g. `node dist/index.js --http-api --port 3100`). Unset → same-origin.
const engineUrl = process.env['VITE_ENGINE_URL'];

// Baked at build time so the client can detect stale caches — when a user's
// browser still runs an old bundle against a newer engine, the two versions
// drift and thread-list / SSE shapes can silently diverge (see StatusBar
// mismatch toast). package.json is our single source of truth.
const pkg = JSON.parse(
	readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string };

// BUILD_SHA detects the more common case: the package.json `version` is the
// same across two deploys (most patches don't bump it) but immutable chunk
// hashes differ. Without per-build comparison the StatusBar toast misses
// these. CI passes BUILD_SHA via Dockerfile build-arg; falls back to empty
// string in local dev (in which case the SHA arm of the comparison is a no-op).
const BUILD_SHA = process.env['BUILD_SHA'] ?? '';

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	// Vite's default envPrefix is `VITE_`. SvelteKit uses `PUBLIC_*` for its
	// own $env/static/public mechanism, but plain `import.meta.env.PUBLIC_*`
	// would otherwise resolve to undefined and the canary flag silently
	// degrades (caught when staging engine.lynox.cloud rendered without the
	// pipeline-status-v2 bar despite the build-arg being passed). Adding
	// PUBLIC_ here makes both the SvelteKit $env path and the plain
	// import.meta.env path agree.
	envPrefix: ['VITE_', 'PUBLIC_'],
	define: {
		__LYNOX_WEB_UI_VERSION__: JSON.stringify(pkg.version),
		__LYNOX_BUILD_SHA__: JSON.stringify(BUILD_SHA),
	},
	server: {
		allowedHosts: true,
		...(engineUrl ? {
			proxy: {
				'/api': { target: engineUrl, changeOrigin: true },
			},
		} : {}),
	},
});
