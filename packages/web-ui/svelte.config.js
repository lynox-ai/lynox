import adapter from '@sveltejs/adapter-node';
import { APP_CSP_DIRECTIVES } from './src/lib/server/app-csp.js';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter(),
		alias: {
			$lib: './src/lib'
		},
		// The page policy. `auto` gives every rendered page a fresh nonce in `script-src` (no
		// page is prerendered), which SvelteKit puts on its own bootstrap script; the two inline
		// scripts in app.html carry it through `%sveltekit.nonce%`. Nothing else inline runs.
		csp: {
			mode: 'auto',
			directives: APP_CSP_DIRECTIVES
		}
	}
};

export default config;
