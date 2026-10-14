/** I-QUEUE -> C0, Q0 (#137). INERT: no production importer, instance, registration, I/O or writer.
 * This adapter accepts the canonical add-on projection; it never replays or schedules a queue.
 * A DTO is not a receipt. T02/T05 are still absent; native validation stays unavailable.
 */
import {
	rtpiValidate,
	type RtpiCapability,
	type RtpiQualification,
	type RtpiRef,
	type RtpiVerdict,
} from "./rtpi-core.js";

/** Narrow structural seam, compatible with pi-queue's QueueProjection without a deployment-path dependency.
 * Counts/index/display windows remain in I-QUEUE. C0's 8 KiB snapshot exports totals, not capped task rows.
 */
export interface RolesQueueInput {
	readonly schema: "i-queue/1";
	readonly binding: {
		readonly queueId: string;
		readonly sessionId: string;
		readonly sessionEpoch: string;
		readonly branchId: string;
		readonly homeRevision: number;
	} | null;
	readonly revision: string | null;
	readonly queueCoverage: "complete" | "partial" | "stale" | "unknown";
	readonly runtimeCoverage: "complete" | "partial" | "stale" | "unknown";
	readonly counts: Readonly<
		Record<"ready" | "working" | "asking" | "stuck" | "waiting" | "blocked" | "done" | "removed", number>
	> | null;
	readonly capacity: number | null;
	readonly working: number | null;
	readonly free: number | null;
}
/** Native envelope must eventually come from the admitted issuer/outbox, never model/tool/client arguments. */
export interface RolesQueueEnvelope {
	readonly eventId: string;
	readonly source: RtpiRef;
	readonly issuer: RtpiRef;
	readonly subject: RtpiRef;
	readonly lineage: RtpiRef;
	readonly incarnation: string;
	readonly sequence: number;
	readonly revision: number;
	readonly expectedRevision: number;
	readonly occurredAt: number;
}
export interface RolesQueueSnapshot {
	readonly state: "off" | "unknown" | "validated" | "unavailable" | "rejected";
	readonly reason: string;
	readonly verdict: RtpiVerdict | null;
}
const COUNT_KEYS = ["ready", "working", "asking", "stuck", "waiting", "blocked", "done"] as const;
const token = (v: unknown): v is string =>
	typeof v === "string" && v.length > 0 && v.length <= 128 && !/[^A-Za-z0-9_.:-]/.test(v);
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Off unless explicitly called with enabled=true. No producer or journal is registered even then. */
export function rolesQueueSnapshot(
	input: RolesQueueInput | null,
	envelope: RolesQueueEnvelope,
	options: { enabled?: boolean; capability?: RtpiCapability; qualification?: RtpiQualification } = {},
): RolesQueueSnapshot {
	if (options.enabled !== true) return { state: "off", reason: "queue-adapter-off", verdict: null };
	const b = input?.binding;
	if (
		!input ||
		input.schema !== "i-queue/1" ||
		!b ||
		!token(input.revision) ||
		![b.queueId, b.sessionId, b.sessionEpoch, b.branchId].every(token) ||
		b.queueId !== b.sessionId ||
		!nonnegative(b.homeRevision) ||
		b.homeRevision < 1
	) {
		return { state: "unknown", reason: "queue-binding-unknown", verdict: null };
	}
	const complete = input.queueCoverage === "complete" && input.runtimeCoverage === "complete";
	if (
		complete &&
		(!nonnegative(input.capacity) ||
			input.capacity < 1 ||
			!nonnegative(input.working) ||
			input.working > input.capacity ||
			input.free !== input.capacity - input.working ||
			!input.counts ||
			!COUNT_KEYS.every((k) => nonnegative(input.counts?.[k])))
	) {
		return { state: "rejected", reason: "canonical-queue-counts-invalid", verdict: null };
	}
	const ref = (kind: string, id: string, revision: string): RtpiRef => ({
		namespace: envelope.source.namespace,
		kind,
		id,
		revision,
	});
	const root = {
		schema: "rtpi/event/1",
		...envelope,
		context: {
			queue: ref("queue", b.queueId, input.revision),
			taskId: null,
			planRevision: null,
			session: ref("session", b.sessionId, b.branchId),
			epoch: ref("epoch", b.sessionEpoch, String(b.homeRevision)),
			turn: null,
			run: null,
			attempt: null,
			recipient: null,
			channel: "unknown",
			action: null,
			artifact: null,
			owner: null,
			client: null,
			window: null,
			projection: ref("projection", input.revision, input.revision),
			coverage: ref("coverage", input.revision, complete ? "complete" : "unknown"),
			policy: null,
			challenge: null,
		},
		body: {
			fact: "queue-snapshot",
			status: complete ? "known" : "unknown",
			capacity: complete ? input.capacity : null,
			occupied: complete ? input.working : null,
			counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, complete ? input.counts?.[k] : null])),
			fullIndex: complete,
			refs: [],
		},
	};
	const verdict = rtpiValidate(root, options.capability ?? null, options.qualification);
	return verdict.status === "accepted"
		? {
				state: complete ? "validated" : "unknown",
				reason: complete ? "fixture-or-admitted-snapshot" : "coverage-unknown",
				verdict,
			}
		: { state: verdict.status, reason: verdict.reason, verdict };
}
