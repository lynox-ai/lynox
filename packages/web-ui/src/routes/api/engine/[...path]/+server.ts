import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

const ENGINE_URL = env.LYNOX_ENGINE_URL ?? 'http://127.0.0.1:3100';
const ENGINE_SECRET = env.LYNOX_HTTP_SECRET ?? '';

async function proxy({ request, params, url }: Parameters<RequestHandler>[0]): Promise<Response> {
	// Validate path to prevent traversal attacks
	const path = params.path;
	if (!path || /\.\.[\\/]/.test(path) || /\.\.%2[fF]/.test(path)) {
		return new Response(JSON.stringify({ error: 'Invalid path' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const engineUrl = `${ENGINE_URL}/api/${path}${url.search}`;

	const headers = new Headers();
	if (ENGINE_SECRET) {
		headers.set('Authorization', `Bearer ${ENGINE_SECRET}`);
	}

	const contentType = request.headers.get('content-type');
	if (contentType) headers.set('Content-Type', contentType);

	const method = request.method;
	let body: string | null = null;
	if (method !== 'GET' && method !== 'HEAD') {
		body = await request.text();
	}

	let engineRes: Response;
	try {
		engineRes = await fetch(engineUrl, { method, headers, body });
	} catch {
		return new Response(JSON.stringify({ error: 'Backend unreachable' }), {
			status: 503,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return new Response(engineRes.body, {
		status: engineRes.status,
		headers: engineRes.headers
	});
}

export const GET: RequestHandler = proxy;
export const POST: RequestHandler = proxy;
export const PUT: RequestHandler = proxy;
export const PATCH: RequestHandler = proxy;
export const DELETE: RequestHandler = proxy;
