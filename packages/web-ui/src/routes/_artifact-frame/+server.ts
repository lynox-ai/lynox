import type { RequestHandler } from './$types';
import { artifactFrameResponse } from '$lib/server/artifact-frame-endpoint.js';

// The document artifacts run in. An endpoint, not a page: the app's page policy (`kit.csp`)
// must not apply here, the response carries its own sandboxing policy.
const BUILD_SHA = process.env['BUILD_SHA'] ?? '';

export const GET: RequestHandler = ({ url }) => artifactFrameResponse(url, BUILD_SHA);
