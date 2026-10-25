/**
 * Worker entry for design B's pass (Ops #423). The host (usage-accounting-pass-host.ts) starts it with
 * METER_WORKER_RESOURCE_LIMITS and B4's usage-accounting-host.ts posts {kind:"tick"} every 30 s. A tick that arrives
 * while a pass runs is dropped, never queued (Architecture C3). All I/O, hashing, folding and the W5 build happen here
 * (C5); the host only receives the bounded W5 snapshot.
 *
 * B4 (Ops #322): a tick may carry {build, witness}. build:false skips the W5 build (the pass itself always runs, so
 * its cursors and the week log stay current); witness = the roles to report on and each chat session's role, taken on
 * the main thread from the chat's identity (fileIdentityIds). The witness replaces the previous one only when it
 * passes the checks below; a fact whose session has no role in it gets no witness row (unknown, never guessed, and
 * never derived from payerRole).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { METER_LIMITS } from "./usage-accounting-meter-contract.js";
import { closePassState, openPassState, runPass, type PassOptions } from "./usage-accounting-pass.js";
import { buildUsageMeterSnapshot } from "./usage-accounting-snapshot.js";

export type UsagePassWorkerData = Omit<PassOptions, "roleOf" | "now" | "clock" | "slow" | "readOrder">;
export type UsagePassMessage =
	| {
			kind: "pass";
			status: string;
			sequence: number;
			/** The pass's own time (W5's evaluatedAt when it built). */
			asOf: string | null;
			snapshot: unknown;
			w5Ms: number;
			workMs: number;
			bytesRead: number;
			ledgerBytes: number;
			backlogFiles: number;
			/** Why an unavailable pass was refused: a store or error code, never source contents. */
			code: string | null;
	  }
	| { kind: "dropped" };
/** What B4's host sends with a tick. sessions: [session id, role] pairs; every role is one of roles. */
export interface UsagePassTick {
	build?: boolean;
	witness?: { roles: string[]; sessions: [string, string][] };
}

const ROLE = /^[a-z][a-z0-9-]{0,31}$/;
// The evidence ref "chat-identity:<session id>" stays within the pass's 128-character ref.
const SESSION = /^[A-Za-z0-9_.:@+-]{1,100}$/;
/** The witness as maps, or null when anything in it is off (then the previous witness stays). */
export function readWitness(raw: unknown): { roles: string[]; sessions: Map<string, string> } | null {
	if (!raw || typeof raw !== "object") return null;
	const { roles, sessions } = raw as { roles?: unknown; sessions?: unknown };
	if (!Array.isArray(roles) || roles.length > METER_LIMITS.subjects || !Array.isArray(sessions)) return null;
	if (!roles.every((r) => typeof r === "string" && ROLE.test(r)) || new Set(roles).size !== roles.length) return null;
	const known = new Set(roles as string[]);
	const map = new Map<string, string>();
	for (const pair of sessions) {
		if (!Array.isArray(pair) || pair.length !== 2) return null;
		const [id, role] = pair as unknown[];
		if (typeof id !== "string" || !SESSION.test(id) || typeof role !== "string" || !known.has(role)) return null;
		if (map.has(id) && map.get(id) !== role) return null;
		map.set(id, role);
	}
	return { roles: roles as string[], sessions: map };
}

if (!isMainThread && parentPort && (workerData as { usagePass?: UsagePassWorkerData } | null)?.usagePass) {
	const port = parentPort;
	const state = openPassState((workerData as { usagePass: UsagePassWorkerData }).usagePass);
	let sessions = new Map<string, string>();
	// Session ids only: a chat file's facts and the ledger's lines both carry the chat's session id (links.session).
	state.options.roleOf = (_file, fact) => {
		const id = fact.links.session;
		const role = id ? sessions.get(id) : undefined;
		return role && id ? { role, evidenceRef: `chat-identity:${id}` } : null;
	};
	let running = false,
		closing = false;
	const close = () => {
		closePassState(state);
		port.close();
	};
	port.on("message", (m: { kind?: string } & UsagePassTick) => {
		if (closing) return;
		if (m?.kind === "close") {
			// Never close the store under a running pass: the pass finishes (bounded by its budget), then the store closes.
			closing = true;
			if (!running) close();
			return;
		}
		if (m?.kind !== "tick") return;
		// The middle of three overlap guards (the host's outstanding tick, this one, runPass's own s.running). It is the
		// one that also covers the W5 build after runPass returns, which runPass's guard does not; tested on its own.
		if (running) {
			port.postMessage({ kind: "dropped" } satisfies UsagePassMessage);
			return;
		}
		const witness = m.witness === undefined ? null : readWitness(m.witness);
		if (witness) {
			sessions = witness.sessions;
			state.options.subjects = witness.roles.map((role) => ({ subject: { kind: "role", role }, policy: null }));
		}
		const build = m.build !== false;
		running = true;
		void (async () => {
			try {
				const r = await runPass(state);
				const t0 = performance.now();
				const snapshot = build && r.input ? buildUsageMeterSnapshot(r.input) : null;
				const store = state.store.status();
				port.postMessage({
					kind: "pass",
					status: r.status,
					sequence: r.sequence,
					asOf: r.asOf,
					snapshot,
					w5Ms: snapshot ? performance.now() - t0 : 0,
					workMs: r.stats.workMs,
					bytesRead: r.stats.bytesRead,
					ledgerBytes: r.stats.ledgerBytes,
					backlogFiles: r.stats.backlogFiles,
					code: r.status === "unavailable" ? (state.lastError ?? store.code ?? null) : null,
				} satisfies UsagePassMessage);
			} catch (error) {
				const code = (error as { code?: unknown })?.code;
				port.postMessage({
					kind: "pass",
					status: "unavailable",
					sequence: state.sequence,
					asOf: null,
					snapshot: null,
					w5Ms: 0,
					workMs: 0,
					bytesRead: 0,
					ledgerBytes: 0,
					backlogFiles: 0,
					code: typeof code === "string" && /^[a-z0-9-]{1,64}$/.test(code) ? code : "error",
				} satisfies UsagePassMessage);
			} finally {
				running = false;
				if (closing) close();
			}
		})();
	});
}
