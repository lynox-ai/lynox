declare global {
	namespace App {
		// No auth in standalone mode — single-user, no Lucia
	}

	// Injected by Vite `define` (see vite.config.ts). The built-in version the
	// current bundle was compiled against, used for stale-cache detection
	// against `/api/health.version` at runtime.
	const __LYNOX_WEB_UI_VERSION__: string;
	// The git SHA the current bundle was built from. Empty in local dev.
	// Compared against `/api/health.build_sha` to catch the case where the
	// version string didn't bump but the chunk hashes did — that's the
	// failure mode that ate Roland's PWA + Rafael's voice send.
	const __LYNOX_BUILD_SHA__: string;
}

export {};
