declare global {
	namespace App {
		// No auth in standalone mode — single-user, no Lucia
	}

	// Injected by Vite `define` (see vite.config.ts). The built-in version the
	// current bundle was compiled against, used for stale-cache detection
	// against `/api/health.version` at runtime.
	const __LYNOX_WEB_UI_VERSION__: string;
}

export {};
