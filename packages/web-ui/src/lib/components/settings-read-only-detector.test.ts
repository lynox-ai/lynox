import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A detector: every settings page that saves through `PUT /api/config` shows a mandate's session
 * its values as text under the owner-only notice (ux U-104), because the server refuses that save
 * to a mandate. A page counts when it sends the PUT itself, or when it uses a store module that
 * sends it (the SearXNG saves live in `stores/integrations/search.svelte.ts`). A new settings page
 * that copies a save without the branch would hand a mandate fields whose save is always refused.
 */
// `src`, not only `src/lib`: a route page that saves the config counts too.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Pages that save through `PUT /api/config` and need no branch, each with its reason. Nothing else
 * belongs here.
 */
const EXEMPT: Record<string, string> = {
	'BulkRunsSetting.svelte': 'Its page leaves it out for a mandate (bulk runs are the owner\'s switch); the mandate is told the owner turns it on.',
};
/**
 * Pages a mandate does not see at all, hidden by themselves: they must ask whose session it is,
 * but show no notice. The setup banner is for setting up a provider, which is the owner's.
 */
const HIDDEN: Record<string, string> = {
	'SetupBanner.svelte': 'Setting up the provider is the owner\'s; GET /api/secrets/status answers a mandate too, so the banner asks.',
};

/** Whether `src` has a fetch whose URL names `/config` and whose options say PUT, in any form. */
function putsConfig(src: string): boolean {
	for (const m of src.matchAll(/\bfetch\(/g)) {
		const rest = src.slice(m.index + 6, m.index + 900);
		const next = rest.search(/\bfetch\(/);
		const call = `fetch(${next === -1 ? rest : rest.slice(0, next)}`;
		const url = call.slice(0, 200).split(/,\s*\{/)[0]!;
		if (/\/config\b(?![-\w./])/.test(url) && /method\s*:\s*['"`]PUT['"`]/.test(call)) return true;
	}
	return false;
}

/** Whether `src` imports the module `moduleFile` (e.g. `search.svelte.ts`) by its `.js` name. */
function importsModule(src: string, moduleFile: string): boolean {
	const name = moduleFile.replace(/\.ts$/, '.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`from\\s+['"][^'"]*/${name}['"]`).test(src);
}

function hasBranch(src: string): boolean {
	return src.includes('isMandateSession(') && src.includes('OwnerOnlyNotice');
}

/**
 * The pages that save through `PUT /api/config`, and those of them without the mandate branch.
 * `files` maps a path to its source; `.svelte` files are pages, `.ts` files are store modules.
 */
function scan(files: Map<string, string>): { pages: string[]; missing: string[] } {
	const stores = [...files].filter(([path, src]) => path.endsWith('.ts') && putsConfig(src)).map(([path]) => basename(path));
	const pages: string[] = [];
	const missing: string[] = [];
	for (const [path, src] of files) {
		if (!path.endsWith('.svelte')) continue;
		if (!putsConfig(src) && !stores.some((store) => importsModule(src, store))) continue;
		pages.push(path);
		const name = basename(path);
		if (name in EXEMPT) continue;
		if (name in HIDDEN ? !src.includes('isMandateSession(') : !hasBranch(src)) missing.push(path);
	}
	return { pages, missing };
}

function sources(dir: string, out = new Map<string, string>()): Map<string, string> {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sources(path, out);
		else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.set(relative(ROOT, path), readFileSync(path, 'utf8'));
	}
	return out;
}

describe('every settings page that saves through PUT /api/config has a read-only view for a mandate', () => {
	const { pages, missing } = scan(sources(ROOT));

	it('finds no page without the branch', () => {
		// The 14 pages counted when this landed (12 with the branch, 1 hidden, 1 exempt); fewer means the scan went blind.
		expect(pages.length).toBeGreaterThanOrEqual(14);
		expect(missing).toEqual([]);
	});

	it('scans the route pages, not only the library', () => {
		expect([...sources(ROOT).keys()].some((p) => p.startsWith('routes/'))).toBe(true);
	});

	it('counts the page whose save lives in a store module', () => {
		expect(pages.map((p) => basename(p))).toContain('SearchSettings.svelte');
	});

	it('exempts only pages the scan finds, each with its reason', () => {
		expect(Object.keys(EXEMPT)).toEqual(['BulkRunsSetting.svelte']);
		expect(Object.keys(HIDDEN)).toEqual(['SetupBanner.svelte']);
		for (const [name, reason] of [...Object.entries(EXEMPT), ...Object.entries(HIDDEN)]) {
			expect(pages.map((p) => basename(p))).toContain(name);
			expect(reason.length).toBeGreaterThan(20);
		}
	});

	it('CONTROL: flags a page that saves without the branch, directly or through a store, and passes one with it', () => {
		const put = "const res = await fetch(`${getApiBase()}/config`, {\n\tmethod: 'PUT',\n\tbody: '{}',\n});";
		const branch = "import OwnerOnlyNotice from './settings-readonly/OwnerOnlyNotice.svelte';\n{#if isMandateSession()}<OwnerOnlyNotice />{/if}";
		const files = new Map<string, string>([
			['components/Bare.svelte', `<script>${put}</script>`],
			['components/Branched.svelte', `<script>${put}</script>${branch}`],
			// The notice alone, without asking whose session it is, is not the branch.
			['components/NoticeOnly.svelte', `<script>${put}</script><OwnerOnlyNotice />`],
			['stores/integrations/thing.svelte.ts', `export async function save() { ${put} }`],
			['components/ThroughStore.svelte', "<script>import { save } from '../stores/integrations/thing.svelte.js';</script>"],
			['components/ThroughStoreBranched.svelte', `<script>import { save } from '../stores/integrations/thing.svelte.js';</script>${branch}`],
			// A GET of /config is no save.
			['components/ReadsOnly.svelte', "<script>const res = await fetch(`${getApiBase()}/config`);</script>"],
			// A hidden page that does not ask whose session it is, and one that does.
			['components/SetupBanner.svelte', `<script>${put}</script>`],
			['hidden/SetupBanner.svelte', `<script>${put}</script>{#if !isMandateSession()}x{/if}`],
			// A route page counts like a component.
			['routes/app/x/+page.svelte', `<script>${put}</script>`],
		]);
		const result = scan(files);
		expect(result.missing.sort()).toEqual(['components/Bare.svelte', 'components/NoticeOnly.svelte', 'components/SetupBanner.svelte', 'components/ThroughStore.svelte', 'routes/app/x/+page.svelte']);
		expect(result.pages).not.toContain('components/ReadsOnly.svelte');
		expect(result.pages).toContain('hidden/SetupBanner.svelte');
	});
});
