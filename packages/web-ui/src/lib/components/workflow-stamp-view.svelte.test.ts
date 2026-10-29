import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// The owner's stamp of a workflow a mandate built or changed (register 242 (c)), driven through the
// library view against the routes as the contract (242 r1) describes them. What is confirmed must be
// what was shown: the digest of the preview on screen is the one the confirm sends.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

interface Call { method: string; path: string; body: unknown }
let calls: Call[];

const WF = {
	id: 'wf-1', name: 'Monthly report', description: '', step_count: 1, steps: [{ id: 'post', task: 'Send it' }],
	parameters: [], created_at: '2026-10-29', mode: 'autonomous', schedulable: true, awaitsStamp: true,
};

function preview(expect: string, task = 'Send the report'): Record<string, unknown> {
	return {
		expect, stampedAt: null, changedBy: 'mandate', awaitsStamp: true, mode: 'autonomous', parameters: [],
		onFailure: 'stop', limits: null, contract: null,
		steps: [{ id: 'post', task, tool: 'http_request', inputTemplate: { url: 'https://other.example/upload' }, tools: ['http_request'], model: null, inputFrom: [] }],
	};
}

/** `wait`: the answer is held until it resolves, to put a step of the view between request and answer. */
type Answer = { status: number; body: unknown; wait?: Promise<void> };
/** One queue of answers per route; the last one repeats. */
function serve(routes: Record<string, Answer[]>): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
		const url = new URL(String(input), 'http://localhost');
		const method = init?.method ?? 'GET';
		calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const key = `${method} ${url.pathname.replace(/^\/api/, '')}`;
		const queue = routes[key];
		if (!queue) return new Response('{}', { status: 404 });
		const answer = queue.length > 1 ? queue.shift()! : queue[0]!;
		if (answer.wait) await answer.wait;
		return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'Content-Type': 'application/json' } });
	}));
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function open(viewer: string | undefined, wf: Record<string, unknown> = WF, extra: Record<string, Answer[]> = {}): Promise<void> {
	serve({
		'GET /workflows/library': [{ status: 200, body: { workflows: [wf], ...(viewer ? { viewer } : {}) } }],
		...extra,
	});
	const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
	component = mount(WorkflowLibraryView, { target });
	await settle();
}

const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function click(el: HTMLElement | null): Promise<void> {
	expect(el, 'the element to click').not.toBeNull();
	el!.click();
	await settle();
}
const byText = (text: string): HTMLElement | null =>
	[...target.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === text) ?? null;
const posts = (path: string): Call[] => calls.filter((c) => c.method === 'POST' && c.path === path);

beforeEach(() => {
	calls = [];
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('the library marks a workflow that waits for the owner\'s stamp', () => {
	it('shows the marker to every reader, and the button to the owner only', async () => {
		await open('owner');
		expect(q('stamp-badge')?.textContent?.trim()).toBe('Läuft erst nach Prüfung');
		expect(q('stamp-review')?.textContent?.trim()).toBe('Schritte prüfen');
	});

	it('a helper sees the marker and no button', async () => {
		await open('mandate');
		expect(q('stamp-badge')).not.toBeNull();
		expect(q('stamp-review')).toBeNull();
	});

	it('an engine without the stamp sends no field, and nothing shows', async () => {
		const { awaitsStamp: _drop, ...older } = WF;
		await open(undefined, older);
		expect(q('stamp-badge')).toBeNull();
		expect(q('stamp-review')).toBeNull();
	});
});

describe('the owner stamps what the preview showed', () => {
	it('prints the recorded call, and confirms with the digest of exactly that preview', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
		});
		await click(q('stamp-review'));
		const step = q('stamp-step')?.textContent ?? '';
		// A harmless task text beside a call to another host: the call is on screen, not folded away.
		expect(step).toContain('http_request');
		expect(step).toContain('https://other.example/upload');
		await click(q('stamp-confirm'));
		expect(posts('/api/workflows/wf-1/confirm').map((c) => c.body)).toEqual([{ expect: 'd1' }]);
		expect(q('stamp-dialog')).toBeNull();
		expect(target.textContent).toContain('Schritte bestätigt.');
	});

	it('steps changed since they were shown: loads the new version, says so, and confirms only on a second click with ITS digest', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }, { status: 200, body: preview('d2', 'Send it somewhere else') }],
			'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }, { status: 200, body: {} }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(q('stamp-dialog')).not.toBeNull();
		expect(q('stamp-line')?.textContent).toContain('Die Schritte haben sich geändert');
		expect(q('stamp-step')?.textContent).toContain('Send it somewhere else');
		expect(posts('/api/workflows/wf-1/confirm')).toHaveLength(1);
		await click(q('stamp-confirm'));
		expect(posts('/api/workflows/wf-1/confirm').map((c) => c.body)).toEqual([{ expect: 'd1' }, { expect: 'd2' }]);
		expect(q('stamp-dialog')).toBeNull();
	});

	it('a preview it cannot read offers no confirm', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: { steps: [] } }],
		});
		await click(q('stamp-review'));
		expect((q('stamp-confirm') as HTMLButtonElement | null)?.disabled).toBe(true);
		expect(q('stamp-step')).toBeNull();
	});

	it('another refusal is an error, not a stamp', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 400, body: { code: 'expect_required' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(q('stamp-dialog')).not.toBeNull();
		expect(target.textContent).not.toContain('Schritte bestätigt.');
	});
});

describe('a schedule refused because the workflow waits for the stamp', () => {
	it('opens the steps in place of the dialog, and brings the dialog back once they are confirmed', async () => {
		await open('owner', WF, {
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		expect(q('stamp-dialog')).not.toBeNull();
		expect(q('stamp-line')?.textContent).toContain('Eine Person mit Zugang hat diesen Workflow gebaut oder geändert.');
		expect(byText('Bestätigen & planen')).toBeNull();
		await click(q('stamp-confirm'));
		expect(q('stamp-dialog')).toBeNull();
		expect(byText('Bestätigen & planen')).not.toBeNull();
	});

	it('a refusal naming another workflow is shown as the error it is, not as this one\'s way out', async () => {
		await open('owner', WF, {
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-2', error: 'refused' } }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		expect(q('stamp-dialog')).toBeNull();
		expect(target.textContent).toContain('refused');
	});
});

describe('what the refuter of the first version found', () => {
	it('the schedule dialog comes back on the workflow as it is after the stamp, with the typed values kept', async () => {
		const before = { ...WF, parameters: [{ name: 'month', description: '', type: 'text' }] };
		const after = { ...before, parameters: [{ name: 'month', description: '', type: 'text' }, { name: 'region', description: '', type: 'text' }] };
		await open('owner', before, {
			'GET /workflows/library': [{ status: 200, body: { workflows: [before], viewer: 'owner' } }, { status: 200, body: { workflows: [after], viewer: 'owner' } }],
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
		});
		await click(byText('Planen'));
		const month = target.querySelector<HTMLInputElement>('[role="dialog"] input:not([placeholder])')!;
		month.value = '2026-11';
		month.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		await click(byText('Bestätigen & planen'));
		await click(q('stamp-confirm'));
		const fields = [...target.querySelectorAll<HTMLElement>('[role="dialog"] label span.font-medium')].map((e) => e.textContent?.trim());
		expect(fields).toEqual(expect.arrayContaining(['month', 'region']));
		const inputs = [...target.querySelectorAll<HTMLInputElement>('[role="dialog"] input:not([placeholder])')];
		expect(inputs.map((i) => i.value)).toEqual(['2026-11', '']);
	});

	it('a failed reload after steps_changed does not claim the new version is shown', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }, { status: 500, body: {} }],
			'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(q('stamp-line')).toBeNull();
		expect(q('stamp-dialog')?.textContent).toContain('Laden fehlgeschlagen');
		expect((q('stamp-confirm') as HTMLButtonElement).disabled).toBe(true);
	});

	it('a confirm answered after its view was closed acts on nothing — not on the next one opened', async () => {
		let release!: () => void;
		const held = new Promise<void>((r) => { release = r; });
		const second = { ...WF, id: 'wf-2', name: 'Other' };
		await open('owner', WF, {
			'GET /workflows/library': [{ status: 200, body: { workflows: [WF, second], viewer: 'owner' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'GET /workflows/wf-2/stamp-preview': [{ status: 200, body: preview('d2') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {}, wait: held }],
		});
		const reviews = [...target.querySelectorAll<HTMLElement>('[data-testid="stamp-review"]')];
		await click(reviews[0]!);
		q('stamp-confirm')!.click();
		await settle();
		await click(byText('Abbrechen'));
		await click([...target.querySelectorAll<HTMLElement>('[data-testid="stamp-review"]')][1]!);
		release();
		await settle();
		expect(q('stamp-dialog')?.textContent).toContain('Other');
		expect(target.textContent).not.toContain('Schritte bestätigt.');
		expect((q('stamp-confirm') as HTMLButtonElement).disabled).toBe(false);
	});

	it('a helper refused with workflow_awaits_stamp sees the refusal, not a view asking them to confirm', async () => {
		await open('mandate', WF, {
			// The contract's refusal carries no text: what the helper reads is the view's own line.
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		expect(q('stamp-dialog')).toBeNull();
		expect(target.textContent).toContain('wenn die Inhaberin oder der Inhaber die Schritte bestätigt hat');
		expect(calls.some((c) => c.path.endsWith('/stamp-preview'))).toBe(false);
	});

	it('closing the view after a failed load leaves no error on the page', async () => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 500, body: {} }] });
		await click(q('stamp-review'));
		await click(byText('Abbrechen'));
		expect(target.textContent).not.toContain('Laden fehlgeschlagen');
	});

	it('prints a direction override in the recorded call instead of applying it', async () => {
		const p = preview('d1');
		(p['steps'] as Array<Record<string, unknown>>)[0]!['inputTemplate'] = { url: 'https://evil\u202Eelpmaxe.com/' };
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-step')?.textContent).toContain('evil<U+202E>elpmaxe');
		expect(q('stamp-step')?.textContent).not.toContain('\u202E');
	});
});

describe('what the refuter of the fixes found', () => {
	it('a reload that fails after the stamp does not bring the dialog back on the old workflow', async () => {
		await open('owner', WF, {
			'GET /workflows/library': [{ status: 200, body: { workflows: [WF], viewer: 'owner' } }, { status: 500, body: {} }],
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		await click(q('stamp-confirm'));
		expect(byText('Bestätigen & planen')).toBeNull();
		expect(target.textContent).toContain('Öffne „Planen“ noch einmal');
	});

});
