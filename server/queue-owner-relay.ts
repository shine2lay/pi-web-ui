/**
 * queue-owner-relay (Ops #676): the host half of relaying the owner's existing dialog answer from one department's
 * home chat (the source, where he answered the dialog) to a task in another department's queue (the target).
 *
 * The host only authenticates and transports: the calling session must be its role's registered home chat, the
 * target is the one home chat of the named role (identity.json, never a caller path), and the target home gets a
 * single-use ticket through its native /queue command. The target home (pi-queue) re-reads its task's current
 * question, has the source chat check its own dialog, and delivers through the ordinary owner-record relay; its one
 * reply comes back here. Never a model message, and never an answer of its own. docs/queue-owner-relay.md.
 */
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { samePath } from "./identities.js";

/** Mirror of pi-queue owner-relay-port.ts (version 1). */
export interface OwnerRelayRequest {
	role: string;
	id: number;
	record: string;
	note?: string;
}
export interface OwnerRelayParty {
	role: string;
	sessionId: string;
	file: string;
}
export interface OwnerRelayGrant extends OwnerRelayRequest {
	source: OwnerRelayParty;
	target: OwnerRelayParty;
}
export type OwnerRelayResult =
	| { status: "relayed" | "kept" | "already"; task: { id: number; chat?: string; title?: string }; detail: string }
	| { status: "refused" | "failed" | "uncertain"; reason: string };
export interface OwnerRelayCapability {
	request: OwnerRelayGrant;
	finish(result: OwnerRelayResult): void;
}

export interface OwnerRelayHost {
	/** A registered, open native session that is its own role's one home chat; else undefined. */
	roleHome(sessionId: string): { role: string; file: string } | undefined;
	/** The one home chat file of the role with exactly this id (owner-only identity records). */
	homeOf(role: string): string | undefined;
	/** The open session's id for a file. */
	sessionIdOf(file: string): string | undefined;
	/** Opens without prompting a model. */
	prepare(file: string): Promise<void>;
	dispatch(file: string, command: string): Promise<boolean>;
}

interface Ticket {
	grant: OwnerRelayGrant;
	consumed: boolean;
	finished: boolean;
	complete(result: OwnerRelayResult): void;
}

const ROLE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RECORD = /^dr-[0-9a-f]{12}$/;
/** pi-queue keeps notes far shorter; this only bounds what the host holds. */
const NOTE_MAX = 8_000;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const refused = (reason: string): OwnerRelayResult => ({ status: "refused", reason });

/** The request, exactly as given, if it has the protocol's shape; never trimmed or case-folded. */
export function ownerRelayRequest(raw: unknown): OwnerRelayRequest | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as Record<string, unknown>;
	if (Object.keys(r).some((key) => !["role", "id", "record", "note"].includes(key))) return undefined;
	if (typeof r.role !== "string" || r.role.length > 40 || !ROLE.test(r.role)) return undefined;
	if (typeof r.id !== "number" || !Number.isSafeInteger(r.id) || r.id <= 0) return undefined;
	if (typeof r.record !== "string" || !RECORD.test(r.record)) return undefined;
	if (r.note !== undefined && (typeof r.note !== "string" || r.note.length > NOTE_MAX)) return undefined;
	return { role: r.role, id: r.id, record: r.record, ...(typeof r.note === "string" && r.note ? { note: r.note } : {}) };
}

/** The target home's one reply, checked; anything else counts as unknown, never as success. */
function relayResult(raw: unknown): OwnerRelayResult {
	const r = raw as Record<string, unknown> | undefined;
	if (r && (r.status === "relayed" || r.status === "kept" || r.status === "already")) {
		const task = r.task as Record<string, unknown> | undefined;
		if (task && typeof task.id === "number" && typeof r.detail === "string") {
			return {
				status: r.status,
				task: {
					id: task.id,
					...(typeof task.chat === "string" ? { chat: task.chat } : {}),
					...(typeof task.title === "string" ? { title: task.title } : {}),
				},
				detail: r.detail,
			};
		}
	}
	if (r && (r.status === "refused" || r.status === "failed" || r.status === "uncertain") && typeof r.reason === "string") {
		return { status: r.status, reason: r.reason };
	}
	return { status: "uncertain", reason: "the target home's reply had an unknown shape" };
}

export class OwnerRelayCoordinator {
	/** One relay at a time per target home. */
	private readonly lanes = new Map<string, Promise<unknown>>();
	private readonly tickets = new Map<string, Ticket>();

	constructor(private readonly host: OwnerRelayHost) {}

	relayOwnerAnswer = (sourceSessionId: string, raw: OwnerRelayRequest): Promise<OwnerRelayResult> => {
		const request = ownerRelayRequest(raw);
		if (!request || typeof sourceSessionId !== "string" || !sourceSessionId) {
			return Promise.resolve(refused("invalid owner-relay request"));
		}
		let home: string | undefined;
		try {
			home = this.host.homeOf(request.role);
		} catch (error) {
			return Promise.resolve(refused(errorText(error)));
		}
		if (!home) return Promise.resolve(refused(`there is no single home chat for role ${request.role}`));
		const key = resolve(home);
		const previous = this.lanes.get(key) ?? Promise.resolve();
		const run = previous.then(() => this.relay(sourceSessionId, Object.freeze(request), home));
		this.lanes.set(key, run);
		void run.then(() => {
			if (this.lanes.get(key) === run) this.lanes.delete(key);
		});
		return run;
	};

	private async relay(source: string, request: OwnerRelayRequest, home: string): Promise<OwnerRelayResult> {
		try {
			const from = this.host.roleHome(source);
			if (!from) return refused("the calling chat isn't its department's registered home chat");
			if (from.role === request.role || samePath(from.file, home)) {
				return refused("the source and the target are the same department: relay without target_role");
			}
			await this.host.prepare(home);
			// From here to the dispatch nothing awaits: the target home found open below is still open when the dispatch
			// runs, so its command runs outside the host's chat-opening chain, which its delivery may need for the task chat.
			const targetId = this.host.sessionIdOf(home);
			const to = targetId ? this.host.roleHome(targetId) : undefined;
			if (!targetId || !to || to.role !== request.role || !samePath(to.file, home)) {
				return refused(`the ${request.role} home chat isn't open with its queue`);
			}
			const again = this.host.roleHome(source);
			if (!again || again.role !== from.role || again.file !== from.file) return refused("the calling home chat changed");
			const grant: OwnerRelayGrant = Object.freeze({
				...request,
				source: Object.freeze({ role: from.role, sessionId: source, file: from.file }),
				target: Object.freeze({ role: to.role, sessionId: targetId, file: to.file }),
			});
			return await this.dispatch(grant);
		} catch (error) {
			return refused(errorText(error));
		}
	}

	private dispatch(grant: OwnerRelayGrant): Promise<OwnerRelayResult> {
		return new Promise((resolveResult) => {
			const token = randomBytes(32).toString("hex");
			const ticket: Ticket = {
				grant,
				consumed: false,
				finished: false,
				complete: (result) => {
					if (ticket.finished) return;
					ticket.finished = true;
					this.tickets.delete(token);
					resolveResult(result);
				},
			};
			this.tickets.set(token, ticket);
			const failure = (error: unknown) => {
				if (ticket.finished) {
					console.error("[owner-relay] command failed after its reply:", errorText(error));
					return;
				}
				ticket.complete(ticket.consumed ? { status: "uncertain", reason: errorText(error) } : refused(errorText(error)));
			};
			try {
				void this.host.dispatch(grant.target.file, `/queue owner-relay ${token}`).then((ok) => {
					if (ticket.finished) return;
					// Not taken by now: the ticket dies here, so a late command can't use it.
					if (!ticket.consumed) ticket.complete(refused(ok ? "the target home didn't take the relay" : "the target home has no queue command"));
					else ticket.complete({ status: "uncertain", reason: "the target home returned without its reply" });
				}, failure);
			} catch (error) {
				failure(error);
			}
		});
	}

	/** In the target home, once: the grant for this session, if the ticket is live and both homes are unchanged. */
	consumeOwnerRelay = (token: string, targetSessionId: string): OwnerRelayCapability | undefined => {
		const ticket = typeof token === "string" ? this.tickets.get(token) : undefined;
		if (ticket) this.tickets.delete(token);
		if (!ticket || ticket.finished || ticket.consumed) return undefined;
		const { source, target } = ticket.grant;
		try {
			const to = this.host.roleHome(targetSessionId);
			const from = this.host.roleHome(source.sessionId);
			if (
				targetSessionId !== target.sessionId ||
				!to ||
				to.role !== target.role ||
				to.file !== target.file ||
				!from ||
				from.role !== source.role ||
				from.file !== source.file
			) {
				ticket.complete(refused("the source or target home changed before delivery"));
				return undefined;
			}
		} catch (error) {
			ticket.complete(refused(errorText(error)));
			return undefined;
		}
		ticket.consumed = true;
		return Object.freeze({
			request: ticket.grant,
			finish: (result: OwnerRelayResult) => ticket.complete(relayResult(result)),
		});
	};
}
