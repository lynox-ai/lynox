import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A detector: every page that writes through a route only the owner may use (`ownerOnly` in
 * `src/server/http-api.ts`: `PUT /api/config`, `PUT /api/secrets/:name`, `POST /api/mail/accounts`
 * …) shows a mandate's session a read-only view (ux U-104, U-109), because the server refuses the
 * write to a mandate. A page counts when it sends the write itself, or when it uses a module under
 * `stores/integrations/` or `api/` that sends it (the SearXNG saves live in
 * `stores/integrations/search.svelte.ts`, the inbox rules in `api/inbox-rules.ts`). The routes are
 * read from the server, so a route that turns owner-only brings its pages in by itself. A new page
 * that copies a write without the branch would hand a mandate a form whose save is always refused.
 *
 * A local helper that sends to the path it is handed (`post(path)` in BulkRunDetail) counts at
 * each of its calls. What it does not see: a URL a helper builds without being handed it
 * (`fetch(url(), …)`), a method passed as a variable, a helper imported from another module, and
 * writes in modules outside those two directories (the chat store is left out on purpose: every view
 * imports it).
 */
// `src`, not only `src/lib`: a route page that writes counts too.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = fileURLToPath(new URL('../../../../../src/server/http-api.ts', import.meta.url));

/**
 * Pages that write through an owner-only route and need no branch, each with its reason. Nothing
 * else belongs here.
 */
const EXEMPT: Record<string, string> = {
	'BulkRunsSetting.svelte': 'Its page leaves it out for a mandate (bulk runs are the owner\'s switch); the mandate is told the owner turns it on.',
	'ChatView.svelte': 'Not a settings page: it reveals the vault key only for the owner\'s backup reminder, and a refused reveal shows nothing.',
	'ApprovalsView.svelte': 'A card without a checksum only reads, closing is offered at `viewer === \'owner\'` only, and a mandate is told the queue is read-only.',
	'OnboardingBasics.svelte': 'Mounted only by ChatView, which never runs the owner\'s introduction in a mandate\'s session.',
};
/**
 * Pages outside the settings that write through an owner-only route: the actions on them (approve,
 * delete, run, edit memory …) are not settings, and whether a mandate is shown each of them is
 * checked page by page apart from this detector. Listed so a NEW page still fails here.
 */
const OUTSIDE_SETTINGS = [
	'BulkRunDetail.svelte', 'BulkRunsView.svelte', 'ContactsView.svelte', 'FileBrowserView.svelte', 'KnowledgeQueueView.svelte',
	'MemoryView.svelte', 'TriggersView.svelte', 'WorkflowLibraryView.svelte',
];
/**
 * Pages a mandate does not see at all, hidden by themselves: they must ask whose session it is,
 * but show no notice.
 */
const HIDDEN: Record<string, string> = {
	'SetupBanner.svelte': 'Setting up the provider is the owner\'s; GET /api/secrets/status answers a mandate too, so the banner asks.',
	'WorkspaceSecurityView.svelte': 'Both of its values are secrets, so a mandate has nothing to see; the index and the palette leave it out.',
	'SecretsView.svelte': 'Listing the secrets is the owner\'s (GET /api/secrets), so a mandate has nothing to see; the index and the palette leave it out.',
	'KeysView.svelte': 'The library\'s older keys page, on the same owner-only list as SecretsView; no route mounts it.',
	'CalendarSettings.svelte': 'Its feeds are read from the owner-only list of secrets, so a mandate has nothing to see; the channel list leaves it out.',
};

/** Pages the scan counted when this landed; fewer means it went blind. */
const PAGES_WHEN_LANDED = 34;

/** A route only the owner may use, as `METHOD` and a pattern over the path after `/api`. */
interface OwnerRoute { method: string; path: RegExp; name: string }

/** The routes `server` registers with an `ownerOnly(…)` stance. */
function ownerOnlyRoutes(server: string): OwnerRoute[] {
	// A dynamic route's path may be a template (`/api/bulk/runs/:id/targets/:seq/${verb}`).
	const START = /this\.addStatic\(\s*'\w+',\s*'([A-Z]+) (\/api\/[^']*)'|parseDynamicRoute\(\s*'\w+',\s*'([A-Z]+)',\s*['`](\/api\/[^'`]*)['`]/g;
	const starts = [...server.matchAll(START)].map((m) => ({ at: m.index, method: (m[1] ?? m[3])!, path: (m[2] ?? m[4])! }));
	const routes: OwnerRoute[] = [];
	starts.forEach((s, i) => {
		// The stance closes the registration, before the next one starts.
		const body = server.slice(s.at, i + 1 < starts.length ? starts[i + 1]!.at : server.length);
		if (!/^\s*\}, ownerOnly\(/m.test(body)) return;
		const pattern = s.path.slice('/api'.length).replace(/\$\{[^}]*\}/g, ':x').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+');
		routes.push({ method: s.method, path: new RegExp(`^${pattern}$`), name: `${s.method} ${s.path}` });
	});
	return routes;
}

/** The method a call's options name (`method: 'POST'`), or none. */
function methodIn(call: string): string | undefined {
	return /method\s*:\s*['"`]([A-Z]+)['"`]/.exec(call)?.[1];
}

/** The text of the call starting at `at`, up to the next call of `name` (or 900 characters). */
function callAt(src: string, at: number, name: string): string {
	const rest = src.slice(at, at + 900);
	const next = rest.slice(name.length + 1).search(new RegExp(`\\b${name}\\(`));
	return next === -1 ? rest : rest.slice(0, next + name.length + 1);
}

/**
 * The local helpers in `src` that send to a path they are handed: `function post(path…)` whose
 * body calls `fetch(\`${base}${path}\`, …)`, directly or through another such helper
 * (`post` → `json` → `fetch` in BulkRunDetail). Each maps to the method it always sends, or to
 * `null` when its caller passes the options (`json(path, { method: 'POST' })`).
 */
function pathHelpers(src: string): Map<string, string | null> {
	const DEF = /(?:function\s+(\w+)\s*(?:<[^>]*>)?\s*\(\s*(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(\s*(\w+))/g;
	const defs = [...src.matchAll(DEF)].map((m) => {
		// The body ends at the closing brace on the definition's own indent, not at the next call.
		const lineStart = src.lastIndexOf('\n', m.index) + 1;
		const indent = /^[ \t]*/.exec(src.slice(lineStart))![0];
		const rest = src.slice(m.index, m.index + 1500);
		const end = rest.search(new RegExp(`\\n${indent}\\}`));
		return { name: (m[1] ?? m[3])!, param: (m[2] ?? m[4])!, body: end === -1 ? rest : rest.slice(0, end) };
	});
	const helpers = new Map<string, string | null>();
	for (let changed = true; changed;) {
		changed = false;
		for (const d of defs) {
			if (helpers.has(d.name)) continue;
			const p = d.param.replace(/[$]/g, '\\$&');
			if (new RegExp(`\\bfetch\\(\\s*\`\\$\\{[^}]*\\}\\$\\{${p}\\}`).test(d.body)) {
				helpers.set(d.name, methodIn(d.body) ?? null);
				changed = true;
				continue;
			}
			for (const [name, method] of helpers) {
				const m = new RegExp(`\\b${name}\\(\\s*${p}\\b`).exec(d.body);
				if (!m) continue;
				helpers.set(d.name, method ?? methodIn(d.body.slice(m.index)) ?? null);
				changed = true;
				break;
			}
		}
	}
	return helpers;
}

/** The path of a URL template after the API base; an interpolation stands for one segment. */
function pathOf(url: string, base: boolean): string {
	return (base ? url.replace(/^\$\{[^}]*\}/, '') : url).replace(/\$\{[^}]*\}/g, 'x').split('?')[0]!;
}

/**
 * The owner-only writes in `src`: each fetch whose method is not GET and whose URL, after the API
 * base, matches an owner-only route; and each call of a local helper that sends to the path it is
 * handed (`post(\`/bulk/runs/${id}/approve\`)`), with the helper's method or the call's own.
 */
function ownerOnlyWrites(src: string, routes: OwnerRoute[]): string[] {
	const found: string[] = [];
	const record = (method: string | undefined, path: string): void => {
		if (method === undefined || method === 'GET') return;
		const route = routes.find((r) => r.method === method && r.path.test(path));
		if (route) found.push(route.name);
	};
	for (const m of src.matchAll(/\bfetch\(/g)) {
		const call = callAt(src, m.index, 'fetch');
		const url = /^fetch\(\s*`([^`]*)`/.exec(call)?.[1];
		// The API base first (`${getApiBase()}`, `${apiBase}`, `${base}`), then every other interpolation.
		if (url !== undefined) record(methodIn(call) ?? 'GET', pathOf(url, true));
	}
	for (const [name, method] of pathHelpers(src)) {
		for (const m of src.matchAll(new RegExp(`\\b${name}\\(\\s*([\`'"])`, 'g'))) {
			const call = callAt(src, m.index, name);
			const quote = m[1]!;
			const url = call.slice(call.indexOf(quote) + 1).split(quote)[0]!;
			// A path handed to the helper starts at `/api`'s level: no base in front of it.
			if (url.startsWith('/')) record(method ?? methodIn(call), pathOf(url, false));
		}
	}
	return found;
}

/** Whether `src` imports the module `moduleFile` (e.g. `search.svelte.ts`) by its `.js` name. */
function importsModule(src: string, moduleFile: string): boolean {
	const name = moduleFile.replace(/\.ts$/, '.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`from\\s+['"][^'"]*/${name}['"]`).test(src);
}

/** A call that reveals an owner's secret (`/vault/key?reveal=true`, `/auth/token?reveal=true`). */
const REVEALS = /[?&]reveal=true/;
/** The modules a page's write may live in, by path: not the chat store, which every view imports. */
const WRITE_MODULES = /^lib\/(stores\/integrations|api)\//;

/** The mandate branch: it asks whose session it is, and says what the owner keeps. */
function hasBranch(src: string): boolean {
	return src.includes('isMandateSession(') && /OwnerOnlyNotice|owner_only_notice/.test(src);
}

/**
 * The pages that write through an owner-only route, and those of them without the mandate branch.
 * `files` maps a path to its source; `.svelte` files are pages, `.ts` files are modules.
 */
function scan(files: Map<string, string>, routes: OwnerRoute[]): { pages: string[]; missing: string[] } {
	const modules = [...files].filter(([path, src]) => path.endsWith('.ts') && WRITE_MODULES.test(path) && ownerOnlyWrites(src, routes).length > 0).map(([path]) => basename(path));
	const pages: string[] = [];
	const missing: string[] = [];
	for (const [path, src] of files) {
		if (!path.endsWith('.svelte')) continue;
		// A page that reveals a secret counts too: the server refuses the reveal to a mandate.
		if (ownerOnlyWrites(src, routes).length === 0 && !REVEALS.test(src) && !modules.some((m) => importsModule(src, m))) continue;
		pages.push(path);
		const name = basename(path);
		if (name in EXEMPT || OUTSIDE_SETTINGS.includes(name)) continue;
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

describe('every page that writes through an owner-only route has a read-only view for a mandate', () => {
	const routes = ownerOnlyRoutes(readFileSync(SERVER, 'utf8'));
	const { pages, missing } = scan(sources(ROOT), routes);

	it('reads the owner-only routes from the server', () => {
		// 63 when this landed; fewer means the parse went blind.
		expect(routes.length).toBeGreaterThanOrEqual(63);
		for (const name of ['PUT /api/config', 'PUT /api/secrets/:name', 'POST /api/mail/accounts', 'DELETE /api/api-profiles/:id', 'POST /api/inbox/rules', 'POST /api/google/disconnect']) {
			expect(routes.map((r) => r.name)).toContain(name);
		}
		// A route a mandate may use is not among them.
		expect(routes.map((r) => r.name)).not.toContain('GET /api/mail/accounts');
		expect(routes.map((r) => r.name)).not.toContain('GET /api/oauth/connect/:id');
	});

	it('finds no page without the branch', () => {
		// The pages counted when this landed (with the branch, hidden, exempt, outside the settings);
		// fewer means the scan went blind.
		expect(pages.length).toBeGreaterThanOrEqual(PAGES_WHEN_LANDED);
		expect(missing).toEqual([]);
	});

	it('scans the route pages, not only the library', () => {
		expect([...sources(ROOT).keys()].some((p) => p.startsWith('routes/'))).toBe(true);
	});

	it('counts the pages whose write lives in a module', () => {
		expect(pages.map((p) => basename(p))).toContain('SearchSettings.svelte');
		expect(pages.map((p) => basename(p))).toContain('RulesView.svelte');
		expect(pages.map((p) => basename(p))).toContain('GoogleSettings.svelte');
	});

	it('counts the pages that write outside /config', () => {
		for (const name of ['MailSettings.svelte', 'ApiStoreView.svelte', 'SecretsView.svelte', 'CalendarSettings.svelte']) {
			expect(pages.map((p) => basename(p))).toContain(name);
		}
	});

	it('exempts only pages the scan finds, each with its reason', () => {
		expect(Object.keys(EXEMPT)).toEqual(['BulkRunsSetting.svelte', 'ChatView.svelte', 'ApprovalsView.svelte', 'OnboardingBasics.svelte']);
		for (const name of OUTSIDE_SETTINGS) expect(pages.map((p) => basename(p))).toContain(name);
		expect(Object.keys(HIDDEN)).toEqual(['SetupBanner.svelte', 'WorkspaceSecurityView.svelte', 'SecretsView.svelte', 'KeysView.svelte', 'CalendarSettings.svelte']);
		for (const [name, reason] of [...Object.entries(EXEMPT), ...Object.entries(HIDDEN)]) {
			expect(pages.map((p) => basename(p))).toContain(name);
			expect(reason.length).toBeGreaterThan(20);
		}
	});

	it('counts the page whose writes go through a local helper', () => {
		expect(pages.map((p) => basename(p))).toContain('BulkRunDetail.svelte');
	});

	it('CONTROL: follows a local helper to its method, through a second helper or from the call', () => {
		const routes = ownerOnlyRoutes([
			"    this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', '/api/runs/:id/approve', async () => {", "    }, ownerOnly('approve a run')));",
			"    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/runs/:id', async () => {", "    }, ownerOnly('delete a run')));",
			"    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/runs/:id/secret', async () => {", "    }, ownerOnly('read a secret')));",
		].join('\n'));
		const json = "\tasync function json<T>(path: string, init?: RequestInit) {\n\t\tconst res = await fetch(`${getApiBase()}${path}`, init);\n\t\treturn res;\n\t}\n";
		const post = "\tfunction post(path: string, body?: unknown) {\n\t\treturn json(path, { method: 'POST', body: JSON.stringify(body) });\n\t}\n";
		// Through a second helper with a fixed method.
		expect(ownerOnlyWrites(`${json}${post}\tawait post(\`/runs/${'$'}{id}/approve\`);\n`, routes)).toEqual(['POST /api/runs/:id/approve']);
		// The method from the call itself.
		expect(ownerOnlyWrites(`${json}\tawait json(\`/runs/${'$'}{id}\`, { method: 'DELETE' });\n`, routes)).toEqual(['DELETE /api/runs/:id']);
		// A read of an owner-only route, straight or through the same helper, is no write.
		expect(ownerOnlyWrites("\tconst res = await fetch(`${getApiBase()}/runs/${id}/secret`);\n", routes)).toEqual([]);
		expect(ownerOnlyWrites(`${json}\tawait json(\`/runs/${'$'}{id}/secret\`);\n`, routes)).toEqual([]);
		// A helper whose fetch does not take its parameter as the path is no path helper.
		const fixed = "\tfunction ping(id: string) {\n\t\treturn fetch(`${getApiBase()}/health`, { method: 'POST' });\n\t}\n";
		expect(ownerOnlyWrites(`${fixed}\tawait ping(\`/runs/x/approve\`);\n`, routes)).toEqual([]);
	});

	it('CONTROL: reads an owner-only stance, at any indent, and skips another stance', () => {
		const server = [
			"    this.addStatic('user', 'PUT /api/config', async () => {", '    }, ownerOnly(\'change the configuration\'));',
			"    this.addStatic('user', 'GET /api/mail/accounts', async () => {", '    }, READS);',
			"      this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/things/:id', async () => {", '      }, ownerOnly(\'delete a thing\')));',
			"    this.dynamicRoutes.push(parseDynamicRoute('user', 'GET', '/api/oauth/connect/:id', () => {}, OWN));",
			"      this.dynamicRoutes.push(parseDynamicRoute('user', 'POST', `/api/runs/:id/${verb}`, async () => {", "      }, ownerOnly(verb)));",
		].join('\n');
		const routes = ownerOnlyRoutes(server);
		expect(routes.map((r) => r.name)).toEqual(['PUT /api/config', 'DELETE /api/things/:id', 'POST /api/runs/:id/${verb}']);
		expect(routes[2]!.path.test('/runs/r1/reselect')).toBe(true);
	});

	it('CONTROL: flags a page that writes without the branch, directly or through a module, and passes one with it', () => {
		const server = [
			"    this.addStatic('user', 'PUT /api/config', async () => {", "    }, ownerOnly('change the configuration'));",
			"    this.dynamicRoutes.push(parseDynamicRoute('user', 'DELETE', '/api/things/:id', async () => {", "    }, ownerOnly('delete a thing')));",
			"    this.addStatic('user', 'POST /api/notes', async () => {", "    }, free('a note of its own'));",
		].join('\n');
		const own = ownerOnlyRoutes(server);
		const put = "const res = await fetch(`${getApiBase()}/config`, {\n\tmethod: 'PUT',\n\tbody: '{}',\n});";
		const del = "await fetch(`${apiBase}/things/${encodeURIComponent(id)}`, { method: 'DELETE' });";
		const branch = "import OwnerOnlyNotice from './settings-readonly/OwnerOnlyNotice.svelte';\n{#if isMandateSession()}<OwnerOnlyNotice />{/if}";
		const files = new Map<string, string>([
			['components/Bare.svelte', `<script>${put}</script>`],
			['components/Branched.svelte', `<script>${put}</script>${branch}`],
			// The notice alone, without asking whose session it is, is not the branch.
			['components/NoticeOnly.svelte', `<script>${put}</script><OwnerOnlyNotice />`],
			// A page's own sentence counts like the notice.
			['components/OwnSentence.svelte', `<script>${del}</script>{#if isMandateSession()}{t('things.owner_only_notice')}{/if}`],
			['lib/stores/integrations/thing.svelte.ts', `export async function save() { ${put} }`],
			['components/ThroughStore.svelte', "<script>import { save } from '../stores/integrations/thing.svelte.js';</script>"],
			['components/ThroughStoreBranched.svelte', `<script>import { save } from '../stores/integrations/thing.svelte.js';</script>${branch}`],
			// A write in a parametrised route, through a module under api/.
			['lib/api/things.ts', `export async function drop(apiBase, id) { ${del} }`],
			['components/ThroughApi.svelte', "<script>import { drop } from '../api/things.js';</script>"],
			// The chat store is no write module: every view imports it.
			['lib/stores/chat.svelte.ts', `export async function submit() { ${put} }`],
			['components/ImportsChat.svelte', "<script>import { clearError } from '../stores/chat.svelte.js';</script>"],
			// A GET of /config is no write, and neither is a write to a route a mandate may use.
			['components/ReadsOnly.svelte', "<script>const res = await fetch(`${getApiBase()}/config`);</script>"],
			['components/OwnNote.svelte', "<script>await fetch(`${getApiBase()}/notes`, { method: 'POST' });</script>"],
			// A hidden page that does not ask whose session it is, and one that does.
			['components/SetupBanner.svelte', `<script>${put}</script>`],
			['hidden/SetupBanner.svelte', `<script>${put}</script>{#if !isMandateSession()}x{/if}`],
			// A route page counts like a component.
			['routes/app/x/+page.svelte', `<script>${put}</script>`],
			// A page that reveals a secret counts without any write.
			['components/Reveals.svelte', "<script>const res = await fetch(`${getApiBase()}/auth/token?reveal=true`);</script>"],
		]);
		const result = scan(files, own);
		expect(result.missing.sort()).toEqual(['components/Bare.svelte', 'components/NoticeOnly.svelte', 'components/Reveals.svelte', 'components/SetupBanner.svelte', 'components/ThroughApi.svelte', 'components/ThroughStore.svelte', 'routes/app/x/+page.svelte']);
		expect(result.pages).not.toContain('components/ReadsOnly.svelte');
		expect(result.pages).not.toContain('components/OwnNote.svelte');
		expect(result.pages).not.toContain('components/ImportsChat.svelte');
		expect(result.pages).toContain('components/OwnSentence.svelte');
		expect(result.pages).toContain('hidden/SetupBanner.svelte');
	});
});
