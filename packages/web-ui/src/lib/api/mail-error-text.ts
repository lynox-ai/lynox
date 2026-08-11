// === Mail connection-error copy ===
//
// Translates a MailError code into something a person can act on. Lives in a
// module rather than inside MailSettings.svelte so it can be asserted by RETURN
// VALUE. It used to be a component-local function, and the only thing guarding
// it was a test that searched the component's source text for "465" — which the
// checkbox label 500 lines further down satisfied on its own, so the advice
// could be emptied out entirely and the guard stayed green.

export interface MailErrorContext {
	/** Which leg failed. Absent for failures before either connection. */
	stage?: 'imap' | 'smtp' | undefined;
	/** The SMTP port the form is currently showing, when the user set one. */
	smtpPort?: number | undefined;
}

/**
 * Outbound 465 is blocked by many hosting providers, ours included. That advice
 * is worth giving to somebody sitting on 465 and actively misleading to anyone
 * else — and since 587 became the default, "try 587 instead" would otherwise be
 * the most common thing we say, to users who are already there and are in fact
 * chasing a typo in the hostname.
 */
const IMPLICIT_TLS_PORT = 465;
const PORT_HINT =
	' Outbound port 465 is blocked on many networks, hosted lynox instances included —' +
	' try port 587 with implicit TLS switched off.';

export function friendlyMailError(
	code: string | undefined,
	raw: string | undefined,
	ctx: MailErrorContext = {},
): string {
	// The send leg only runs after the read leg passed, so an SMTP failure carries
	// different advice: the credentials are already proven good against IMAP.
	if (ctx.stage === 'smtp') {
		const portHint = ctx.smtpPort === IMPLICIT_TLS_PORT ? PORT_HINT : '';
		switch (code) {
			case 'auth_failed':
				return 'The server accepted your login for reading but refused it for sending. Some providers issue a separate SMTP password, or need the app-password re-generated.';
			case 'rate_limited':
				return 'The server is rejecting logins for now because there have been too many attempts. Wait a few minutes and try again — a new app-password will not help.';
			case 'connection_failed':
				return `Couldn't reach the SMTP server. Check the hostname and port.${portHint}`;
			case 'timeout':
				return `The SMTP server never answered. Check the hostname and port, and any firewall between this machine and it.${portHint}`;
			// Deliberately the same advice as the IMAP branch below. An earlier
			// draft named the env flag that disables certificate checking; that
			// is useless to a managed tenant, who sets no env vars, and it reads
			// as an instruction to turn off verification for BOTH protocols on
			// the whole instance to fix one server.
			case 'tls_failed':
				return "The SMTP server's certificate couldn't be verified. If this is a custom server with self-signed TLS, contact your admin.";
			default:
				return `Sending (SMTP) failed: ${raw ?? 'unknown error'}`;
		}
	}
	switch (code) {
		case 'auth_failed':
			return 'Login failed — check your email address and app-password. If you enabled 2FA, make sure you generated a provider-specific app-password (not your account password).';
		case 'tls_failed':
			return "The server's certificate couldn't be verified. If this is a custom server with self-signed TLS, contact your admin.";
		case 'connection_failed':
			return "Couldn't reach the mail server. Check the hostname and that the IMAP port is open on your network.";
		case 'timeout':
			return 'The server took too long to respond. Try again, or check your network.';
		case 'not_found':
			return 'No matching mail server found for that address.';
		case 'rate_limited':
			return 'Too many test attempts — wait a minute before retrying.';
		default:
			return raw ?? 'Unknown error';
	}
}
