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

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	define: {
		__LYNOX_WEB_UI_VERSION__: JSON.stringify(pkg.version),
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
