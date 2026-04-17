import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Standalone dev: when VITE_ENGINE_URL is set, proxy /api/* to the Engine on
// another port so the UI can run with hot-reload while the Engine is started
// separately (e.g. `node dist/index.js --http-api --port 3100`). Unset → same-origin.
const engineUrl = process.env['VITE_ENGINE_URL'];

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit()
	],
	server: {
		allowedHosts: true,
		...(engineUrl ? {
			proxy: {
				'/api': { target: engineUrl, changeOrigin: true },
			},
		} : {}),
	},
});
