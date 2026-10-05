// ---------------------------------------------------------------------------
// app-token.ts — the app's own token: what the app's jobs (not chats) show the control socket
// ---------------------------------------------------------------------------
// <dataDir>/app-token holds 32 random bytes (hex), mode 0600, made by the server when it is missing.
// The control socket is reachable only by this OS user — and so by every chat's tools too. A command
// only the app's own jobs may give (role-reports: the 6 am report request) carries this token;
// pi-worktree keeps chats from naming the file, so a chat can't read it and give the command itself.
// The token is never logged, never sent to a page.
// ---------------------------------------------------------------------------

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The file's name in the data dir. */
export const APP_TOKEN_FILE = "app-token";

const TOKEN_RE = /^[0-9a-f]{64}$/;

export function appTokenPath(dataDir: string): string {
	return join(dataDir, APP_TOKEN_FILE);
}

/** The token in the data dir; made (0600) when it is missing or not a token. */
export function ensureAppToken(dataDir: string): string {
	const file = appTokenPath(dataDir);
	try {
		const have = readFileSync(file, "utf8").trim();
		if (TOKEN_RE.test(have)) {
			try {
				chmodSync(file, 0o600);
			} catch {
				// best effort
			}
			return have;
		}
	} catch {
		// none yet
	}
	const token = randomBytes(32).toString("hex");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(file, `${token}\n`, { mode: 0o600 });
	try {
		chmodSync(file, 0o600);
	} catch {
		// best effort
	}
	return token;
}

/** Whether `given` is the token (compared in constant time). */
export function isAppToken(given: unknown, token: string): boolean {
	if (typeof given !== "string" || !TOKEN_RE.test(given) || !TOKEN_RE.test(token)) return false;
	return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(token, "utf8"));
}
