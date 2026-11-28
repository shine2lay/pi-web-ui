import { isAbsolute, resolve } from "node:path";
import { identityRegistry } from "./identities.js";
import { sessionIdFromTranscriptPath } from "./composer-drafts.js";
import type { CanonicalHome } from "./lead-compaction-contract.js";

const bindings = new Map<string, { key: string; epoch: number }>();
/** Registry metadata only. Never opens/scans a native journal to enumerate sleeping homes. */
function homes() {
	return identityRegistry().identities.flatMap((role) => {
		const source = role.homeChat;
		if (!source || !isAbsolute(source)) return [];
		const sessionId = sessionIdFromTranscriptPath(source);
		return sessionId ? [{ role: role.id, sessionId, source: resolve(source) }] : [];
	});
}
export function enumerateCanonicalHomes(): readonly CanonicalHome[] {
	const rows = homes();
	return rows
		.filter((row) => rows.filter((other) => other.sessionId === row.sessionId).length === 1)
		.map(({ role, sessionId }) => ({ role, sessionId }));
}
export function resolveCanonicalLeadHome(
	sessionId: string,
): { role: string; source: string; bindingEpoch: number } | undefined {
	const rows = homes().filter((row) => row.sessionId === sessionId);
	const key = JSON.stringify(rows);
	const prior = bindings.get(sessionId);
	const binding = prior?.key === key ? prior : { key, epoch: (prior?.epoch ?? 0) + 1 };
	bindings.set(sessionId, binding);
	return rows.length === 1 ? { role: rows[0]!.role, source: rows[0]!.source, bindingEpoch: binding.epoch } : undefined;
}
