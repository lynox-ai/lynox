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

	// UX-053/058: the reloaded list says the workflow's access ended, or that it is not this reader's to schedule.
	it.each([
		['its access ended', { ...WF, runs_as: { person: 'eva@kanzlei.example', ended: true, covered_by_takeover: 0 } }, 'ended'],
		['it is not the reader\'s to schedule', { ...WF, schedule_refusal: 'foreign' }, 'foreign'],
	])('a workflow that may no longer be scheduled after the stamp (%s) does not get the dialog back, and its card says why', async (_why, blocked, note) => {
		await open('owner', WF, {
			'GET /workflows/library': [{ status: 200, body: { workflows: [WF], viewer: 'owner' } }, { status: 200, body: { workflows: [blocked], viewer: 'owner' } }],
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 200, body: {} }],
			});
			await click(byText('Planen'));
			await click(byText('Bestätigen & planen'));
			await click(q('stamp-confirm'));
			expect(byText('Bestätigen & planen')).toBeNull();
			// The note that names this case, not just any note.
			expect([...target.querySelectorAll('[data-library-note]')].map((n) => n.getAttribute('data-library-note'))).toEqual([note]);
			expect(target.textContent).not.toContain('Öffne „Planen“ noch einmal');
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
		expect(step).toContain('Gründlichkeit: Gründlich');
		expect(step).toContain('Nachdenken: Automatisch');
		expect(step).toContain('Zeitlimit: 2 min 30 s');
		// What the role grants: the step's own tools are not all a run gets.
		const grant = q('stamp-role-grant')?.textContent ?? '';
		expect(grant).toContain('Modell: Tief');
		// The step sets its own effort, which wins: the role's is not shown as if it applied.
		expect(grant).not.toContain('Gründlichkeit');
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
		expect(grant).toContain('Gründlichkeit: Maximum');
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
		expect(q('stamp-model-default')?.textContent).toContain('Modell: Schnell (Standard)');
	});

	it('no default model where the role names one', async () => {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, { model: null, role: 'reviewer', roleGrant: { model: 'deep', effort: null, allowTools: null, denyTools: null, readOnly: false } });
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		expect(q('stamp-model-default')).toBeNull();
		expect(q('stamp-role-grant')?.textContent).toContain('Modell: Tief');
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

describe('the stamp part names settings, and shows no stored value', () => {
	const twoSteps = (expect: string, postUrl = 'https://other.example/upload', over: Record<string, unknown> = {}): Record<string, unknown> => ({
		...preview(expect),
		...over,
		steps: [
			{ id: 'fetch_orders', task: 'Read the open orders', tool: null, inputTemplate: null, tools: ['web_search', 'http_request', 'read_file'], model: null, inputFrom: [] },
			{ id: 'post', task: 'Send the report', tool: 'http_request', inputTemplate: { url: postUrl }, tools: ['http_request'], model: null, inputFrom: ['fetch_orders'] },
		],
	});
	const openStamp = async (body: Record<string, unknown>): Promise<void> => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body }] });
		await click(q('stamp-review'));
	};

	it('names the mode and the failure strategy, and prints neither stored value', async () => {
		await openStamp(twoSteps('d1', undefined, { mode: 'autonomous', onFailure: 'notify' }));
		expect(q('stamp-mode')?.textContent?.trim()).toBe('Autonom');
		// notify runs as continue does and reports to no one: it is not named as if it reported.
		expect(q('stamp-on-failure')?.textContent?.trim()).toBe('Weitermachen');
		expect(q('stamp-mode')!.classList.contains('font-mono')).toBe(false);
		const settings = q('stamp-settings')?.textContent ?? '';
		expect(settings).not.toMatch(/\bautonomous\b|\bnotify\b/);
	});

	it('the interactive mode and the continue strategy are named too', async () => {
		await openStamp(twoSteps('d1', undefined, { mode: 'interactive', onFailure: 'continue' }));
		expect(q('stamp-mode')?.textContent?.trim()).toBe('Interaktiv');
		expect(q('stamp-on-failure')?.textContent?.trim()).toBe('Weitermachen');
	});

	it('a value the view does not know is printed as it came, hidden characters shown', async () => {
		await openStamp(twoSteps('d1', undefined, { mode: 'turbo\u202E', onFailure: 'halt' }));
		expect(q('stamp-mode')?.textContent?.trim()).toBe('turbo<U+202E>');
		expect(q('stamp-mode')!.classList.contains('font-mono')).toBe(true);
		expect(q('stamp-on-failure')?.textContent?.trim()).toBe('halt');
	});

	it('the stop strategy has its own name, and a line under it that the steps due along with the failed one still start', async () => {
		await openStamp(twoSteps('d1', undefined, { onFailure: 'stop' }));
		expect(q('stamp-on-failure')?.textContent?.trim()).toBe('Keine Folgeschritte starten');
		expect(q('stamp-on-failure-note')?.textContent?.trim()).toBe('Schritte, die mit dem fehlgeschlagenen an der Reihe waren, starten noch und laufen zu Ende.');
		// Under the name: the next element after the strategy's own value.
		expect(q('stamp-on-failure')!.nextElementSibling).toBe(q('stamp-on-failure-note'));
	});

	it.each(['continue', 'notify', 'halt'])('the %s strategy carries no such line', async (onFailure) => {
		await openStamp(twoSteps('d1', undefined, { onFailure }));
		expect(q('stamp-on-failure')).not.toBeNull();
		expect(q('stamp-on-failure-note')).toBeNull();
	});

	it('heads each step with its id and no number, and prints the task once', async () => {
		await openStamp(twoSteps('d1'));
		const stepEls = [...target.querySelectorAll<HTMLElement>('[data-testid="stamp-step"]')];
		expect(stepEls.map((s) => s.querySelector('[data-testid="stamp-step-head"]')?.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Schritt fetch_orders', 'Schritt post']);
		for (const [i, task] of ['Read the open orders', 'Send the report'].entries()) {
			expect(stepEls[i]!.textContent!.split(task).length - 1, task).toBe(1);
			expect(stepEls[i]!.querySelector('[data-testid="stamp-step-task"]')?.textContent).toBe(task);
		}
	});

	it('a tool list wraps between names, not inside one', async () => {
		await openStamp(twoSteps('d1'));
		const list = target.querySelector<HTMLElement>('[data-testid="stamp-tool-list"]')!;
		expect(list.textContent).toBe('web_search, http_request, read_file');
		expect(list.classList.contains('break-all')).toBe(false);
		expect(list.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
	});

	it('after steps_changed, exactly the changed step is marked, focused and brought into sight', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: twoSteps('d1') }, { status: 200, body: twoSteps('d2', 'https://evil.example/upload') }],
			'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
		});
		await click(q('stamp-review'));
		expect(target.querySelectorAll('[data-stamp-changed]')).toHaveLength(0);
		await click(q('stamp-confirm'));
		const stepEls = [...target.querySelectorAll<HTMLElement>('[data-testid="stamp-step"]')];
		expect(stepEls.map((s) => s.hasAttribute('data-stamp-changed'))).toEqual([false, true]);
		expect(stepEls.map((s) => s.querySelector('[data-testid="stamp-changed-mark"]')?.textContent?.trim() ?? null)).toEqual([null, 'Geändert']);
		expect(target.querySelectorAll('[data-stamp-changed]')).toHaveLength(1);
		expect(document.activeElement).toBe(stepEls[1]);
		expect(scrolled).toContain(stepEls[1]);
	});

	it('a removed step is named, and a changed setting is marked where it stands', async () => {
		const one = { ...twoSteps('d2', undefined, { onFailure: 'continue' }) };
		one['steps'] = (one['steps'] as unknown[]).slice(1);
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: twoSteps('d1') }, { status: 200, body: one }],
			'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(q('stamp-settings')?.hasAttribute('data-stamp-changed')).toBe(true);
		expect(q('stamp-removed')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Geändert Nicht mehr dabei: fetch_orders');
		expect(target.querySelector('[data-testid="stamp-step"][data-stamp-changed]')).toBeNull();
		// The first changed part, in reading order, takes the focus.
		expect(document.activeElement).toBe(q('stamp-settings'));
	});

	describe('after asks_changed (U-498)', () => {
		const LINE_DE = 'Wer ausser dir die Fragen dieses Workflows beantworten kann, hat sich geändert, seit du ihn geöffnet hast. Unten steht jetzt der neue Stand. Prüf ihn und bestätige noch einmal.';
		const LINE_EN = 'Who besides you can answer this workflow’s questions changed since you opened it. The new state is shown below. Check it and confirm again.';
		const refusedTo = async (before: unknown, after: unknown): Promise<void> => {
			await open('owner', WF, {
				'GET /workflows/wf-1/stamp-preview': [
					{ status: 200, body: twoSteps('d1', undefined, { asks: before }) },
					{ status: 200, body: twoSteps('d1', undefined, { asks: after }) },
				],
				'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'asks_changed' } }],
			});
			await click(q('stamp-review'));
			await click(q('stamp-confirm'));
		};
		const inEnglish = async (run: () => Promise<void>): Promise<void> => {
			const { setLocale, getLocale } = await import('../i18n.svelte.js');
			const was = getLocale();
			setLocale('en');
			try { await run(); } finally { setLocale(was); }
		};

		it('says who answers moved, not the steps, and marks the box with who answers, not a step', async () => {
			await refusedTo({ count: 1, name: 'arno@kanzlei.example' }, { count: 2, name: null });
			expect(q('stamp-line')?.textContent?.trim()).toBe(LINE_DE);
			expect(q('stamp-asks')?.getAttribute('data-asks-count')).toBe('2');
			expect(q('stamp-asks-none')).toBeNull();
			expect(q('stamp-settings')?.hasAttribute('data-stamp-changed')).toBe(true);
			expect(target.querySelector('[data-testid="stamp-step"][data-stamp-changed]')).toBeNull();
			expect(document.activeElement).toBe(q('stamp-settings'));
			if (component) unmount(component);
			component = undefined;
			target.innerHTML = '';
			await inEnglish(async () => {
				await refusedTo({ count: 1, name: 'arno@kanzlei.example' }, { count: 2, name: null });
				expect(q('stamp-line')?.textContent?.trim()).toBe(LINE_EN);
			});
		});

		it('with no one left besides the owner, the marked box says only the owner answers', async () => {
			await refusedTo({ count: 1, name: 'arno@kanzlei.example' }, null);
			expect(q('stamp-asks')).toBeNull();
			expect(q('stamp-asks-none')?.textContent?.trim()).toBe('Die Fragen dieses Workflows beantwortest jetzt nur du.');
			expect(q('stamp-settings')?.hasAttribute('data-stamp-changed')).toBe(true);
			if (component) unmount(component);
			component = undefined;
			target.innerHTML = '';
			await inEnglish(async () => {
				await refusedTo({ count: 1, name: 'arno@kanzlei.example' }, null);
				expect(q('stamp-asks-none')?.textContent?.trim()).toBe('Only you answer this workflow’s questions now.');
			});
		});

		it('shows no line about who answers on a first look with no one besides the owner, nor the only-you line after a refusal for changed steps', async () => {
			// A first look with no one besides the owner: no line in the box.
			await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: twoSteps('d1') }] });
			await click(q('stamp-review'));
			expect(q('stamp-asks')).toBeNull();
			expect(q('stamp-asks-none')).toBeNull();
			if (component) unmount(component);
			component = undefined;
			target.innerHTML = '';
			// The steps moved and who answers is now no one: the steps line, and no line about who answers.
			await open('owner', WF, {
				'GET /workflows/wf-1/stamp-preview': [
					{ status: 200, body: twoSteps('d1', undefined, { asks: { count: 1, name: 'arno@kanzlei.example' } }) },
					{ status: 200, body: twoSteps('d2', 'https://evil.example/upload') },
				],
				'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
			});
			await click(q('stamp-review'));
			await click(q('stamp-confirm'));
			expect(q('stamp-line')?.textContent).toContain('Die Schritte haben sich geändert');
			expect(q('stamp-asks-none')).toBeNull();
		});
	});

	it('a new open of the view marks nothing from the last one', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: twoSteps('d1') }, { status: 200, body: twoSteps('d2', 'https://evil.example/upload') }],
			'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(target.querySelectorAll('[data-stamp-changed]')).toHaveLength(1);
		await click(byText('Abbrechen'));
		await click(q('stamp-review'));
		expect(target.querySelectorAll('[data-stamp-changed]')).toHaveLength(0);
	});
});

describe('what the contract allows, and a contract that grants nothing (U-451)', () => {
	const withParams = (expect: string, parameters: unknown[], contract: string[] | null = null): Record<string, unknown> => ({ ...preview(expect), parameters, contract });
	const openStamp = async (body: Record<string, unknown>): Promise<void> => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body }] });
		await click(q('stamp-review'));
	};
	const allowedOf = (): string[] => [...target.querySelectorAll<HTMLElement>('[data-testid="stamp-param-allowed"]')].map((el) => el.textContent!.replace(/\s+/g, ' ').trim());
	const boxesOf = (): string[] => [...target.querySelectorAll<HTMLElement>('[data-testid="stamp-param-allowed"] [data-foreign-value]')].map((el) => el.textContent!);

	it('prints under each parameter one line per rule, in words, each value in its own box', async () => {
		await openStamp(withParams('d1', [
			{ name: 'month', required: false, default: 'May', allowed: { enum: ['May', 'June'], regex: null, min: null, max: null } },
			{ name: 'count', required: true, default: null, allowed: { enum: null, regex: null, min: 1, max: 5 } },
			{ name: 'code', required: true, default: null, allowed: { enum: null, regex: '[a-z]+', min: 2, max: null } },
			{ name: 'top', required: true, default: null, allowed: { enum: null, regex: null, min: null, max: 9 } },
			{ name: 'none', required: true, default: null, allowed: { enum: [], regex: null, min: null, max: null } },
			{ name: 'free', required: true, default: null, allowed: null },
		]));
		expect(allowedOf()).toEqual([
			'erlaubt: May, June',
			'erlaubt: 1 bis 5',
			'erlaubt: was ganz zum Muster [a-z]+ passt',
			'erlaubt: mindestens 2',
			'erlaubt: höchstens 9',
			'kein Wert erlaubt',
		]);
		expect(boxesOf()).toEqual(['May', 'June', '1', '5', '[a-z]+', '2', '9']);
		// Under its own parameter: the lines sit in that parameter's row, and a parameter without rules has none.
		const rows = [...target.querySelectorAll<HTMLElement>('[data-testid="stamp-settings"] li')];
		expect(rows.map((r) => r.querySelectorAll('[data-testid="stamp-param-allowed"]').length)).toEqual([1, 1, 2, 1, 1, 0]);
	});

	it('a value is shown as it is matched: spaces that would fold away, and hidden characters, are printed', async () => {
		await openStamp(withParams('d1', [
			{ name: 'shop', required: true, default: null, allowed: { enum: ['a  b', ' x', 'y\u202E', 'p\tq'], regex: null, min: null, max: null } },
		]));
		expect(boxesOf()).toEqual(['a<U+0020><U+0020>b', '<U+0020>x', 'y<U+202E>', 'p<U+0009>q']);
	});

	it('a contract that grants nothing says so in a sentence, in place of the list', async () => {
		await openStamp(withParams('d1', [], []));
		expect(q('stamp-contract-none')?.textContent?.trim()).toBe('Dieser Workflow hat keine Freigabe, ohne Rückfrage an andere Dienste zu schreiben. Lesen kann er weiterhin.');
		expect(target.textContent).not.toContain('Ohne Rückfrage darf dieser Workflow');
	});

	it('a contract that grants writes lists them under a title that says they need no asking', async () => {
		await openStamp(withParams('d1', [], ['POST https://api.example.com/upload']));
		expect(target.textContent).toContain('Ohne Rückfrage darf dieser Workflow diese ausgehenden Aktionen durchführen:');
		expect(target.textContent).toContain('POST https://api.example.com/upload');
		expect(q('stamp-contract-none')).toBeNull();
	});

	it('CONTROL: without a contract there is no list and no sentence', async () => {
		await openStamp(withParams('d1', [], null));
		expect(q('stamp-contract-none')).toBeNull();
		expect(target.textContent).not.toContain('Ohne Rückfrage darf dieser Workflow');
	});

	it('a rule that changed after the preview was shown marks the settings', async () => {
		const at = (values: string[]): Record<string, unknown> => withParams('d', [{ name: 'month', required: true, default: null, allowed: { enum: values, regex: null, min: null, max: null } }]);
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: { ...at(['May']), expect: 'd1' } }, { status: 200, body: { ...at(['June']), expect: 'd2' } }],
			'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		expect(q('stamp-settings')?.hasAttribute('data-stamp-changed')).toBe(true);
		expect(allowedOf()).toEqual(['erlaubt: June']);
	});

	describe('the plan dialog', () => {
		const GRANT = { version: 1, grantedTools: ['http_request', 'bash'], httpMethods: ['POST'], hostPatterns: ['h.example'], pathPatterns: ['/p'], paramConstraints: {} };
		const openPlan = async (capabilityContract?: unknown): Promise<void> => {
			await open('owner', capabilityContract === undefined ? WF : { ...WF, capabilityContract });
			await click(byText('Planen'));
			expect(byText('Bestätigen & planen'), 'the plan dialog').not.toBeNull();
		};

		it('lists only the writes the engine grants, and no other tool', async () => {
			await openPlan(GRANT);
			expect(target.textContent).toContain('Ohne Rückfrage darf dieser Workflow diese ausgehenden Aktionen durchführen:');
			expect(target.textContent).toContain('POST https://h.example/p');
			expect(target.textContent).not.toMatch(/\bbash\b/);
			expect(q('schedule-contract-none')).toBeNull();
		});

		it.each([
			['without the request tool', { ...GRANT, grantedTools: ['bash'] }],
			['without a path, which grants no path rather than the whole host', { ...GRANT, pathPatterns: [] }],
			['without a host', { ...GRANT, hostPatterns: [] }],
			['that is not an object', 'http_request'],
		])('a contract %s says it grants nothing', async (_label, contract) => {
			await openPlan(contract);
			expect(q('schedule-contract-none')?.textContent?.trim()).toBe('Dieser Workflow hat keine Freigabe, ohne Rückfrage an andere Dienste zu schreiben. Lesen kann er weiterhin.');
			expect(target.textContent).not.toContain('Ohne Rückfrage darf dieser Workflow');
			expect(target.textContent).not.toContain('https://h.example');
		});

		it('CONTROL: without a contract there is no list and no sentence', async () => {
			await openPlan();
			expect(q('schedule-contract-none')).toBeNull();
			expect(target.textContent).not.toContain('Ohne Rückfrage darf dieser Workflow');
		});

		it('prints a hidden character in a granted address instead of reading it', async () => {
			await openPlan({ ...GRANT, hostPatterns: ['h\u202E.example'] });
			expect(target.textContent).toContain('POST https://h<U+202E>.example/p');
		});
	});
});

describe('the stamp names a tier, a thoroughness and a thinking setting as the settings do', () => {
	function stepWith(fields: Record<string, unknown>): Record<string, unknown> {
		const p = preview('d1');
		Object.assign((p['steps'] as Array<Record<string, unknown>>)[0]!, fields);
		return p;
	}

	it('a tier by its name, never the stored value; a model named by its id stays set apart as it is', async () => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: stepWith({ model: 'balanced', effort: 'xhigh', thinking: 'enabled' }) }] });
		await click(q('stamp-review'));
		const step = q('stamp-step')!;
		const text = step.textContent ?? '';
		expect(text).toContain('Modell: Ausgewogen');
		expect(text).toContain('Gründlichkeit: Sehr gründlich');
		expect(text).toContain('Nachdenken: Immer');
		for (const raw of ['balanced', 'xhigh', 'enabled']) expect(text).not.toContain(raw);
		expect(step.querySelector('[data-model-tier="balanced"]')?.classList.contains('font-mono')).toBe(false);
		if (component) unmount(component);
		component = undefined;
		target.innerHTML = '';
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: stepWith({ model: 'claude-sonnet-4-5', effort: 'low', thinking: 'disabled' }) }] });
		await click(q('stamp-review'));
		const again = q('stamp-step')!;
		expect(again.textContent).toContain('claude-sonnet-4-5');
		expect(again.querySelector('[data-model-tier]')).toBeNull();
		expect([...again.querySelectorAll('.font-mono')].some((el) => el.textContent === 'claude-sonnet-4-5')).toBe(true);
		expect(again.textContent).toContain('Gründlichkeit: Schnell');
		expect(again.textContent).toContain('Nachdenken: Deaktiviert');
	});
});

describe('the stamp says where the workflow may run, from the rule a schedule asks', () => {
	async function runsLine(runs: string | undefined): Promise<HTMLElement | null> {
		const p = preview('d1');
		if (runs !== undefined) p['runs'] = runs;
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		return q('stamp-runs');
	}

	it('an autonomous one: from a chat, on a schedule and by an agent in the background', async () => {
		expect((await runsLine('anywhere'))?.textContent).toBe('aus dem Chat, geplant und von einem Agenten im Hintergrund');
	});

	it('an interactive one that asks only its owner: from a chat and on a schedule', async () => {
		expect((await runsLine('chat_and_schedule'))?.textContent).toBe('aus dem Chat und geplant');
	});

	it('any other interactive one: from a chat and by an agent in the background, not on a schedule', async () => {
		// A background agent's run_workflow starts it once the stamp holds, so the line says so.
		expect((await runsLine('chat'))?.textContent).toBe('aus dem Chat und von einem Agenten im Hintergrund, nicht geplant');
	});

	it('an engine that sends no such field, or a value the view does not know, shows no line, and the preview stands', async () => {
		expect(await runsLine(undefined)).toBeNull();
		expect(q('stamp-confirm')?.hasAttribute('disabled')).toBe(false);
		if (component) unmount(component);
		component = undefined;
		target.innerHTML = '';
		expect(await runsLine('everywhere')).toBeNull();
		expect(q('stamp-step')).not.toBeNull();
		expect(q('stamp-confirm')?.hasAttribute('disabled')).toBe(false);
	});
});

describe('the stamp says who else may answer its questions when it runs on a schedule', () => {
	async function asksLine(asks: unknown): Promise<HTMLElement | null> {
		const p = preview('d1');
		if (asks !== undefined) p['asks'] = asks;
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: p }] });
		await click(q('stamp-review'));
		return q('stamp-asks');
	}
	const again = (): void => {
		if (component) unmount(component);
		component = undefined;
		target.innerHTML = '';
	};

	it('one person: names them, set apart, and says the first answer steers the run', async () => {
		const line = await asksLine({ count: 1, name: 'lena@kanzlei.example' });
		expect(line?.textContent).toBe('Läuft er geplant, kann auch lena@kanzlei.example seine Fragen beantworten; wer zuerst antwortet, lenkt den Lauf.');
		expect([...line!.querySelectorAll('[data-foreign-value]')].map((b) => b.textContent)).toEqual(['lena@kanzlei.example']);
		again();
		const { setLocale, getLocale } = await import('../i18n.svelte.js');
		const was = getLocale();
		setLocale('en');
		try {
			expect((await asksLine({ count: 1, name: 'lena@kanzlei.example' }))?.textContent).toBe('When it runs on a schedule, lena@kanzlei.example can answer its questions too; whoever answers first steers the run.');
		} finally { setLocale(was); }
	});

	it('one person with an address past the display length: names it whole', async () => {
		const long = 'k'.repeat(90) + '@kanzlei.example';
		const line = await asksLine({ count: 1, name: long });
		expect([...line!.querySelectorAll('[data-foreign-value]')].map((b) => b.textContent)).toEqual([long]);
	});

	it('more people: counts them and names no one', async () => {
		const line = await asksLine({ count: 3, name: null });
		expect(line?.textContent).toBe('Läuft er geplant, kann je nach Plan auch eine von 3\u00a0Personen mit Zugang seine Fragen beantworten. Wer zuerst antwortet, lenkt den Lauf.');
		expect(line!.querySelector('[data-foreign-value]')).toBeNull();
	});

	it('no one, or an engine that sends no such field: no line, and the preview stands', async () => {
		for (const asks of [undefined, null]) {
			expect(await asksLine(asks)).toBeNull();
			expect(q('stamp-step')).not.toBeNull();
			expect(q('stamp-confirm')?.hasAttribute('disabled')).toBe(false);
			again();
		}
	});

	it('a value of another shape refuses the preview: a fault never reads as only the owner answering', async () => {
		for (const asks of [{ count: 0, name: null }, { count: 2, name: 'lena@kanzlei.example' }, { count: 1, name: null }, { count: 1.5, name: 'x' }, 'lena@kanzlei.example']) {
			expect(await asksLine(asks)).toBeNull();
			expect(q('stamp-step')).toBeNull();
			expect(q('stamp-confirm')?.hasAttribute('disabled')).toBe(true);
			expect(target.textContent).toContain('Laden fehlgeschlagen');
			again();
		}
	});
});

describe('the review keeps its reason and its buttons in sight', () => {
	// jsdom lays nothing out: what stays in sight is read the way the view reads it, from the
	// computed position and the box, set here as a browser reports them.
	function layOut(statusHeight: number, footHeight: number, sticky: boolean): () => void {
		const realStyle = window.getComputedStyle;
		const realRect = Element.prototype.getBoundingClientRect;
		const held = (el: Element): number | null =>
			el.hasAttribute('data-dialog-status') ? statusHeight : el.hasAttribute('data-dialog-foot') ? footHeight : null;
		window.getComputedStyle = ((el: Element) => {
			const style = realStyle(el);
			return held(el) === null || !sticky ? style : ({ ...style, position: 'sticky' } as CSSStyleDeclaration);
		}) as typeof window.getComputedStyle;
		Element.prototype.getBoundingClientRect = function (this: Element) {
			const h = held(this);
			return h === null ? realRect.call(this) : ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 0, height: h, toJSON: () => ({}) } as DOMRect);
		};
		return () => { window.getComputedStyle = realStyle; Element.prototype.getBoundingClientRect = realRect; };
	}
	const frame = (): HTMLElement => q('stamp-dialog')!.firstElementChild as HTMLElement;
	const changedTwice = (task = 'Send it somewhere else'): Record<string, Answer[]> => ({
		'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }, { status: 200, body: preview('d2', task) }],
		'POST /workflows/wf-1/confirm': [{ status: 409, body: { code: 'steps_changed' } }],
	});

	it('opening the view puts the focus on its heading, which names the dialog, and Escape closes it and gives the focus back', async () => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }] });
		q('stamp-review')!.focus();
		await click(q('stamp-review'));
		const heading = target.querySelector<HTMLElement>('[data-stamp-review-title]');
		expect(document.activeElement).toBe(heading);
		expect(q('stamp-dialog')?.getAttribute('aria-labelledby')).toBe(heading?.id);
		heading!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(q('stamp-dialog')).toBeNull();
		expect(document.activeElement).toBe(q('stamp-review'));
	});

	it('Cancel with no opener to go back to gives the focus to this workflow\'s review button, not to the page', async () => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }] });
		await click(q('stamp-review'));
		// Opened with the focus on the page: there is no opener to go back to.
		expect(q('stamp-dialog')).not.toBeNull();
		await click(byText('Abbrechen'));
		expect(q('stamp-dialog')).toBeNull();
		expect(document.activeElement).toBe(q('stamp-review'));
	});

	it('Cancel after the opener is gone (the schedule dialog it came from) gives the focus to this workflow\'s review button', async () => {
		await open('owner', WF, {
			'POST /tasks': [{ status: 409, body: { code: 'workflow_awaits_stamp', pipelineId: 'wf-1' } }],
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
		});
		await click(byText('Planen'));
		const scheduleConfirm = byText('Bestätigen & planen');
		scheduleConfirm!.focus();
		expect(document.activeElement).toBe(scheduleConfirm);
		await click(scheduleConfirm);
		expect(q('stamp-dialog')).not.toBeNull();
		expect(scheduleConfirm!.isConnected).toBe(false);
		await click(byText('Abbrechen'));
		expect(q('stamp-dialog')).toBeNull();
		expect(document.activeElement).toBe(q('stamp-review'));
	});

	it('Cancel closes the view and gives the focus back to what opened it', async () => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }] });
		q('stamp-review')!.focus();
		await click(q('stamp-review'));
		await click(byText('Abbrechen'));
		expect(q('stamp-dialog')).toBeNull();
		expect(document.activeElement).toBe(q('stamp-review'));
	});

	it('Escape still closes the view once the focus fell to the page', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 400, body: { code: 'expect_required' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(q('stamp-dialog')).toBeNull();
	});

	it('the buttons sit in a foot that stays in sight on an opaque ground with a line above, and Tab keeps clear of it from the start', async () => {
		await open('owner', WF, { 'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }] });
		const restore = layOut(0, 52, true);
		try {
			await click(q('stamp-review'));
		} finally {
			restore();
		}
		// Held as soon as the view opens, before anything is marked: the browser keeps a focused
		// control clear of the foot.
		expect(frame().style.scrollPaddingBottom).toBe('60px');
		expect(frame().style.scrollPaddingTop).toBe('');
		const foot = q('stamp-dialog')!.querySelector<HTMLElement>('[data-dialog-foot]');
		expect(foot?.contains(q('stamp-confirm'))).toBe(true);
		const cls = foot!.className.split(/\s+/);
		expect(cls).toEqual(expect.arrayContaining(['[@media(min-height:30rem)]:sticky', '[@media(min-height:30rem)]:-bottom-5', 'bg-bg', '[@media(min-height:30rem)]:border-t']));
	});

	it('after steps changed, the line stays in sight and the changed step is focused and brought into view clear of the line and the foot', async () => {
		await open('owner', WF, changedTwice());
		await click(q('stamp-review'));
		const restore = layOut(64, 52, true);
		try {
			await click(q('stamp-confirm'));
		} finally {
			restore();
		}
		const status = q('stamp-dialog')!.querySelector<HTMLElement>('[data-dialog-status]');
		expect(status?.contains(q('stamp-line'))).toBe(true);
		expect(status!.className.split(/\s+/)).toContain('[@media(min-height:30rem)]:sticky');
		const mark = q('stamp-dialog')!.querySelector<HTMLElement>('[data-stamp-changed]');
		expect(mark).not.toBeNull();
		expect(document.activeElement).toBe(mark);
		// The frame's scroll padding is what the browser keeps clear, for this and for every Tab.
		expect(frame().style.scrollPaddingTop).toBe('72px');
		expect(frame().style.scrollPaddingBottom).toBe('60px');
		expect(scrolled).toContain(mark);
	});

	it('parts that scroll with the frame keep nothing clear, however high they are', async () => {
		await open('owner', WF, changedTwice());
		await click(q('stamp-review'));
		const restore = layOut(64, 52, false);
		try {
			await click(q('stamp-confirm'));
		} finally {
			restore();
		}
		const mark = q('stamp-dialog')!.querySelector<HTMLElement>('[data-stamp-changed]');
		expect(frame().style.scrollPaddingTop).toBe('');
		expect(frame().style.scrollPaddingBottom).toBe('');
		expect(scrolled).toContain(mark);
	});

	it('a reload that marks nothing puts the focus on the heading, not on the confirm', async () => {
		await open('owner', WF, changedTwice('Send the report'));
		await click(q('stamp-review'));
		q('stamp-confirm')!.focus();
		expect(document.activeElement).toBe(q('stamp-confirm'));
		await click(q('stamp-confirm'));
		expect(q('stamp-line')).not.toBeNull();
		expect(q('stamp-dialog')!.querySelector('[data-stamp-changed]')).toBeNull();
		expect(document.activeElement).toBe(target.querySelector('[data-stamp-review-title]'));
	});

	it('an error in the view carries no role: the error state is the library\'s, and may be another run\'s', async () => {
		await open('owner', WF, {
			'GET /workflows/wf-1/stamp-preview': [{ status: 200, body: preview('d1') }],
			'POST /workflows/wf-1/confirm': [{ status: 400, body: { code: 'expect_required' } }],
		});
		await click(q('stamp-review'));
		await click(q('stamp-confirm'));
		const err = [...q('stamp-dialog')!.querySelectorAll<HTMLElement>('p')].find((p) => p.className.includes('text-danger'));
		expect(err).toBeDefined();
		expect(err!.hasAttribute('role')).toBe(false);
	});
});
