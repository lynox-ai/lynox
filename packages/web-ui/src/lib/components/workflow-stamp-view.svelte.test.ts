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

let scrolled: Element[];

beforeEach(() => {
	calls = [];
	scrolled = [];
	Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
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
		// The line is at the head of the view, the button at its foot: it is scrolled into sight.
		expect(scrolled).toContain(q('stamp-line'));
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
		expect(target.textContent).toContain('wartet auf die Bestätigung des Inhabers. Ein Plan kann ihn erst danach ausführen. Wende dich an den Inhaber.');
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


	it('a view opened while the stamped list reloads keeps the screen, and the schedule dialog stays shut', async () => {
		let releasePatch!: () => void;
		let releaseList!: () => void;
		const patchHeld = new Promise<void>((r) => { releasePatch = r; });
		const listHeld = new Promise<void>((r) => { releaseList = r; });
		const second = { ...WF, id: 'wf-2', name: 'Other' };
		const both = { status: 200, body: { workflows: [WF, second], viewer: 'owner' } };
		await open('owner', WF, {
			// The page's load; the stamp's reload, held; the rename's reload, answered at once.
			'GET /workflows/library': [both, { ...both, wait: listHeld }, both],
			'PATCH /workflows/wf-2': [{ status: 200, body: {}, wait: patchHeld }],
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'GET /workflows/wf-2/stamp-preview': [{ status: 200, body: preview('d2') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
		});
		// A slow rename of the second workflow is under way.
		await click([...target.querySelectorAll<HTMLElement>('button')].filter((b) => b.textContent?.trim() === 'Umbenennen')[1]!);
		await click(byText('Speichern'));
		// The first one is scheduled, refused, stamped; its reload stays in flight.
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		await click(q('stamp-confirm'));
		// The rename answers and reloads the list: the cards are back, and the second view opens.
		releasePatch();
		await settle();
		await click([...target.querySelectorAll<HTMLElement>('[data-testid="stamp-review"]')][1]!);
		releaseList();
		await settle();
		expect(q('stamp-dialog')?.textContent).toContain('Other');
		expect(byText('Bestätigen & planen')).toBeNull();
	});
});

describe('contract r3: what the view adds', () => {
	it('names a step\'s role, effort, thinking and time limit', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, {
			role: 'researcher', effort: 'high', thinking: 'adaptive', timeoutMs: 150_000,
			roleGrant: { model: 'deep', effort: 'max', allowTools: ['web_search'], denyTools: ['http_request'], readOnly: true },
		});
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		const step = q('stamp-step')?.textContent ?? '';
		expect(q('stamp-role')?.textContent).toContain('Angaben der Rolle researcher');
		expect(step).toContain('Aufwand: high');
		expect(step).toContain('Nachdenken: adaptive');
		expect(step).toContain('Zeitlimit: 2 min 30 s');
		// What the role grants: the step's own tools are not all a run gets.
		const grant = q('stamp-role-grant')?.textContent ?? '';
		expect(grant).toContain('Modell: deep');
		// The step sets its own effort, which wins: the role's is not shown as if it applied.
		expect(grant).not.toContain('Aufwand');
		expect(grant).toContain('Erlaubt: web_search');
		expect(grant).toContain('Sperrt: http_request');
		expect(q('stamp-role')?.textContent).toContain('nur lesen');
		// Read only with an allow list: the list does not all apply, and the view says so.
		expect(q('stamp-role-read-only-allows')?.textContent).toContain('gelten von den erlaubten Werkzeugen nur die lesenden');
		expect(step).toContain('Werkzeuge des Schritts:');
		expect(q('stamp-role-hint')?.textContent).toContain('ergibt sich beim Lauf aus Schritt und Rolle');
	});

	it('a schedule refused for the owner\'s own changed steps says so, not that someone else changed them', async () => {
		await open('owner', WF, {
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: { ...preview('d1'), changedBy: 'owner' } }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		expect(q('stamp-line')?.textContent).toContain('seit deiner letzten Bestätigung geändert');
		expect(q('stamp-line')?.textContent).not.toContain('Eine Person mit Zugang');
	});

	it('after the stamp, says how many plans the wait switched off stay off, and where to switch them on', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: { stillOff: 2 } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(target.textContent).toContain('2 Pläne warteten auf diese Bestätigung');
	});

	it('says nothing about such plans when there are none', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: { stillOff: 0 } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(target.textContent).toContain('Schritte bestätigt.');
		expect(q('stamp-once')).toBeNull();
	});

	it('the line about such plans survives the way back to the schedule', async () => {
		await open('owner', WF, {
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }, { status: 200, body: {} }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: { stillOff: 1 } }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		await click(q('stamp-confirm'));
		await click(byText('Bestätigen & planen'));
		expect(q('stamp-once')?.textContent).toContain('1 Plan wartete auf diese Bestätigung');
	});

	it('a schedule refused while the preview cannot load says why, without naming who changed it', async () => {
		await open('owner', WF, {
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 500, body: {} }],
		});
		await click(byText('Planen'));
		await click(byText('Bestätigen & planen'));
		expect(q('stamp-line')?.textContent).toContain('Sie liessen sich gerade nicht laden');
		// The line says it; the dialog does not repeat it, nor introduce steps it cannot show.
		const dialog = q('stamp-dialog')?.textContent ?? '';
		expect(dialog).not.toContain('Laden fehlgeschlagen');
		expect(dialog).not.toContain('Das läuft, wenn ein Plan');
	});

	it('a workflow without steps says so, and can be stamped', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: { ...preview('d1'), steps: [] } }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
		});
		await click(q('stamp-review'));
		expect(q('stamp-no-steps')?.textContent).toContain('keine Schritte');
		expect((q('stamp-confirm') as HTMLButtonElement).disabled).toBe(false);
	});

	it('a time limit of 0 says the step times out at once', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { timeoutMs: 0 });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-step')?.textContent).toContain('Zeitlimit: 0 s (bricht sofort ab)');
	});

	it('an empty allow list reads as no tools, not as a missing value', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, {
			role: 'reviewer', roleGrant: { model: null, effort: null, allowTools: [], denyTools: null, readOnly: false },
		});
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-role-grant')?.textContent).toContain('Erlaubt: keine Werkzeuge');
		// In plain type: in mono it would read as a tool of that name.
		expect([...q('stamp-role-grant')!.querySelectorAll('.font-mono')].some((e) => e.textContent?.includes('keine Werkzeuge'))).toBe(false);
	});

	it('shows the role\'s model and effort only where the step sets none: the step\'s own value wins', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, {
			model: 'fast', effort: null, role: 'reviewer',
			roleGrant: { model: 'deep', effort: 'max', allowTools: null, denyTools: null, readOnly: false },
		});
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		const grant = q('stamp-role-grant')?.textContent ?? '';
		expect(grant).not.toContain('Modell');
		expect(grant).toContain('Aufwand: max');
	});

	it('a role the engine does not know says the step stops', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { role: 'made-up', roleGrant: null });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-role-unknown')?.textContent).toContain('Diese Rolle gibt es auf dieser Instanz nicht');
		expect(q('stamp-role')?.textContent).toContain('Rolle: made-up');
		// The step stops, so no sentence on how its tools are worked out at run time.
		expect(q('stamp-role-hint')).toBeNull();
	});

	it('a step without a time limit shows the engine\'s default, not nothing', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { timeoutMs: null });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-step')?.textContent).toContain('Zeitlimit: 30 min (Standard)');
	});

	it('read only without an allow list adds no sentence about allowed tools', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, {
			role: 'reviewer', roleGrant: { model: null, effort: null, allowTools: null, denyTools: null, readOnly: true },
		});
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-role')?.textContent).toContain('nur lesen');
		expect(q('stamp-role-read-only-allows')).toBeNull();
	});

	it('a step whose model neither it nor its role names shows the engine\'s default', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { model: null, role: null, roleGrant: null });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-model-default')?.textContent).toContain('Modell: fast (Standard)');
	});

	it('no default model where the role names one', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { model: null, role: 'reviewer', roleGrant: { model: 'deep', effort: null, allowTools: null, denyTools: null, readOnly: false } });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-model-default')).toBeNull();
		expect(q('stamp-role-grant')?.textContent).toContain('Modell: deep');
	});

	it('no default model where the role is unknown, since the step stops', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { model: null, role: 'made-up', roleGrant: null });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-role-unknown')).not.toBeNull();
		expect(q('stamp-model-default')).toBeNull();
	});
});

describe('renaming a workflow (ux U-077)', () => {
	const renameWith = async (answer: Answer): Promise<void> => {
		await open('owner', WF, { 'PATCH /workflows/wf-1': [answer] });
		await click(byText('Umbenennen'));
		const input = target.querySelector<HTMLInputElement>('input[aria-label="Umbenennen"]');
		expect(input, 'the rename field').not.toBeNull();
		input!.value = 'Monthly report\u200B';
		input!.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		await click(byText('Speichern'));
	};

	it('a name refused for a character that does not show says so, and the field stays open to type it again', async () => {
		await renameWith({ status: 400, body: { error: 'The name holds a character that does not show as text (U+200B). Nothing was saved.', code: 'hidden_char' } });
		expect(target.textContent).toContain('Der Name enthält ein Zeichen, das nicht als Text erscheint. Gespeichert ist nichts. Lösch den Namen und tipp ihn neu ein, statt ihn einzufügen.');
		expect(target.querySelector('input[aria-label="Umbenennen"]')).not.toBeNull();
	});

	it('any other refusal stays the plain save failure', async () => {
		await renameWith({ status: 400, body: { error: 'name too long (max 200 characters)' } });
		expect(target.textContent).toContain('Speichern fehlgeschlagen');
		expect(target.textContent).not.toContain('nicht als Text erscheint');
	});
});
