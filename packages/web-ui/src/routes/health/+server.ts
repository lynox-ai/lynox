import type { RequestHandler } from './$types.js';

export const GET: RequestHandler = async () => {
	return new Response(JSON.stringify({ status: 'ok' }), {
		headers: { 'Content-Type': 'application/json' },
	});
};
