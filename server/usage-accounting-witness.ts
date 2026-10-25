/**
 * The role witness for design B's pass (Ops #322, B4): which role each chat session belongs to, taken on the main
 * thread from the chat's identity the same way decision records do (fileIdentityIds: home chat, else the chat's last
 * pi-identity entry, else a past home chat). Never from payerRole. Chats without an identity get no role: their usage
 * stays unknown for every role (W5 records invalid-subject-binding) rather than being guessed.
 */
import { fileIdentityIds, identityRegistry } from "./identities.js";
import { sessionIndex } from "./session-index.js";
import { METER_LIMITS } from "./usage-accounting-meter-contract.js";
import type { UsageRoleWitness } from "./usage-accounting-host.js";

const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION = /^[A-Za-z0-9_.:@+-]{1,100}$/;
/** Chats touched in the last 8 days: the current Pacific week plus last week's 10-minute grace. */
const RECENT_MS = 8 * 24 * 60 * 60 * 1000;

export async function usageRoleWitness(sessionRoot: string | undefined, now = Date.now()): Promise<UsageRoleWitness> {
	const { identities } = identityRegistry();
	const roles = identities
		.map((i) => i.id)
		.filter((id) => ROLE.test(id))
		.sort()
		.slice(0, METER_LIMITS.subjects);
	const known = new Set(roles);
	const rows = (await sessionIndex.listAll(sessionRoot)).filter((r) => r.modified.getTime() >= now - RECENT_MS);
	const ids = roles.length
		? await fileIdentityIds(
				rows.map((r) => r.path),
				identities,
			)
		: new Map<string, null>();
	const byId = new Map<string, string | null>();
	for (const r of rows) {
		const role = ids.get(r.path) ?? null;
		if (!SESSION.test(r.id) || !role || !known.has(role)) continue;
		// Two files with one session id and different roles: neither is trusted.
		byId.set(r.id, byId.has(r.id) && byId.get(r.id) !== role ? null : role);
	}
	const sessions = [...byId]
		.filter((p): p is [string, string] => p[1] !== null)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return { roles, sessions };
}
