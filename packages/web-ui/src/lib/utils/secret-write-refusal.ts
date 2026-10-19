/**
 * Why a `PUT /api/secrets/:name` was refused, for the message the settings views show. Two
 * refusals answer 403 and need different advice: a built-in provider's client secret belongs in
 * the profile's app credentials form (the server marks it with a `code`), every other 403 is a
 * name the platform manages.
 */
export type SecretWriteRefusal = 'preset_client' | 'managed' | 'failed';

export const PRESET_CLIENT_SECRET_CODE = 'preset_client_secret';

export async function secretWriteRefusal(res: Response): Promise<SecretWriteRefusal> {
	if (res.status !== 403) return 'failed';
	const code = await res.json().then((b: { code?: unknown }) => b.code).catch(() => undefined);
	return code === PRESET_CLIENT_SECRET_CODE ? 'preset_client' : 'managed';
}
