/**
 * Deterministic cross-queue dependency, blocker, wait, and queued-detail resolver
 * for the Roles & Initiatives rework (CONTRACT.md Area 4).
 *
 * Pure functions operating over in-memory queue snapshots (0 I/O, 0 model calls).
 */

import type {
	TaskDepDeadlockReason,
	UiNormalizedTouch,
	UiResolvedTaskDep,
	UiRoleTaskBlocked,
	UiRoleTaskQueuedDetail,
	UiRoleTaskWait,
	UiTaskLifecycleStatus,
} from "../protocol.js";
import { resolveTaskLifecycleAndDelivery } from "./task-delivery-resolver.js";
import { normalizeTouches } from "./touch-normalizer.js";

const MAX_DEP_WALK_DEPTH = 16;

export interface RawTaskRefObject {
	file?: string;
	name?: string;
	id: number;
	status?: string;
	title?: string;
	dropped?: string;
	held?: boolean;
	over?: { at: number; removed?: boolean; dropped?: string };
}

export type RawTaskRefInput = number | string | RawTaskRefObject;

export interface QueueTaskForDeps {
	id: number;
	title?: string;
	plan?: { title?: string };
	status: string;
	lifecycleStatus?: UiTaskLifecycleStatus;
	paused?: unknown;
	hold?: unknown;
	touches?: readonly string[];
	normalizedTouches?: readonly UiNormalizedTouch[];
	after?: ReadonlyArray<number | string>;
	waitingFor?: readonly number[];
	outside?: readonly RawTaskRefObject[];
	block?: {
		on?: ReadonlyArray<RawTaskRefInput>;
		need?: string;
		lead?: string;
		owes?: string;
	};
	blocked?: {
		on?: readonly string[];
		need?: string;
		lead?: string;
		owes?: string;
	};
	wait?: {
		what?: string;
		check?: string;
	};
	question?: string;
}

export interface QueueSnapshotForDeps {
	running?: boolean;
	queueRunning?: boolean;
	paused?: unknown;
	hold?: unknown;
	lanesAtOnce?: number;
	tasks: readonly QueueTaskForDeps[];
}

export type QueuesByRoleInput =
	ReadonlyMap<string, QueueSnapshotForDeps> | Readonly<Record<string, QueueSnapshotForDeps>>;

export interface ParsedTaskRef {
	/** Verbatim reference string (e.g. "#12" or "backend #412"). */
	ref: string;
	/** Resolved role id (lowercase), if known. */
	role?: string;
	/** Resolved numeric task id, if valid. */
	taskId?: number;
	/** Canonical cross-role reference string ("<role> #<id>" or "#<id>"). */
	canonicalRef: string;
}

const SAME_ROLE_REF_RE = /^#?(\d+)$/;
const CROSS_ROLE_REF_RE = /^([a-z0-9][a-z0-9_-]*)\s+#(\d+)$/i;

/**
 * Parses a raw task reference (`12`, `"#12"`, `"backend #412"`, or `{ name, id }`)
 * into `{ ref, role, taskId, canonicalRef }`.
 */
export function parseTaskRef(raw: RawTaskRefInput, currentRole?: string): ParsedTaskRef {
	const normCurrentRole = currentRole?.trim().toLowerCase() || undefined;

	if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) {
		const ref = `#${raw}`;
		const canonicalRef = normCurrentRole ? `${normCurrentRole} #${raw}` : ref;
		return {
			ref,
			...(normCurrentRole ? { role: normCurrentRole } : {}),
			taskId: raw,
			canonicalRef,
		};
	}

	if (typeof raw === "object" && raw !== null && typeof raw.id === "number") {
		const rawName = typeof raw.name === "string" ? raw.name.trim() : "";
		const role = (rawName ? rawName.toLowerCase() : normCurrentRole) || undefined;
		const ref = rawName ? `${rawName} #${raw.id}` : `#${raw.id}`;
		const canonicalRef = role ? `${role} #${raw.id}` : ref;
		return {
			ref,
			...(role ? { role } : {}),
			taskId: raw.id,
			canonicalRef,
		};
	}

	if (typeof raw === "string") {
		const trimmed = raw.trim();
		const sameMatch = SAME_ROLE_REF_RE.exec(trimmed);
		if (sameMatch) {
			const taskId = Number(sameMatch[1]);
			const ref = trimmed.startsWith("#") ? trimmed : `#${taskId}`;
			const canonicalRef = normCurrentRole ? `${normCurrentRole} #${taskId}` : ref;
			return {
				ref,
				...(normCurrentRole ? { role: normCurrentRole } : {}),
				taskId,
				canonicalRef,
			};
		}
		const crossMatch = CROSS_ROLE_REF_RE.exec(trimmed);
		if (crossMatch) {
			const role = crossMatch[1].toLowerCase();
			const taskId = Number(crossMatch[2]);
			const canonicalRef = `${role} #${taskId}`;
			return {
				ref: trimmed,
				role,
				taskId,
				canonicalRef,
			};
		}
		return { ref: trimmed, canonicalRef: trimmed };
	}

	return { ref: String(raw), canonicalRef: String(raw) };
}

function getQueueForRole(
	queuesByRole: QueuesByRoleInput | undefined,
	role: string | undefined,
): QueueSnapshotForDeps | undefined {
	if (!queuesByRole || !role) return undefined;
	const key = role.toLowerCase();
	if (queuesByRole instanceof Map) {
		return (
			(queuesByRole as ReadonlyMap<string, QueueSnapshotForDeps>).get(key) ??
			(queuesByRole as ReadonlyMap<string, QueueSnapshotForDeps>).get(role)
		);
	}
	const rec = queuesByRole as Readonly<Record<string, QueueSnapshotForDeps>>;
	return rec[key] ?? rec[role];
}

function inferTargetLifecycleStatus(target: QueueTaskForDeps, queuePaused: boolean): UiTaskLifecycleStatus {
	if (target.lifecycleStatus) return target.lifecycleStatus;
	return resolveTaskLifecycleAndDelivery(
		{
			id: target.id,
			status: target.status,
			paused: Boolean(target.paused || target.hold),
			touches: target.touches,
			normalizedTouches: target.normalizedTouches,
			wait: target.wait,
		},
		{ queuePaused },
	).lifecycleStatus;
}

function isLifecycleSatisfied(rawStatus: string, lifecycleStatus: UiTaskLifecycleStatus): boolean {
	return (
		rawStatus === "done" ||
		lifecycleStatus === "done" ||
		lifecycleStatus === "landed" ||
		lifecycleStatus === "deploying" ||
		lifecycleStatus === "live"
	);
}

function extractUpstreamRefsOfTask(task: QueueTaskForDeps): RawTaskRefInput[] {
	const out: RawTaskRefInput[] = [];
	if (Array.isArray(task.block?.on)) out.push(...task.block.on);
	else if (Array.isArray(task.blocked?.on)) out.push(...task.blocked.on);
	if (Array.isArray(task.after)) out.push(...task.after);
	if (Array.isArray(task.outside)) out.push(...task.outside);
	return out;
}

interface InternalResolvedDep {
	dep: UiResolvedTaskDep;
	rootBlocker?: UiResolvedTaskDep;
}

function resolveSingleDepInternal(
	rawRef: RawTaskRefInput,
	currentRole: string | undefined,
	queuesByRole: QueuesByRoleInput | undefined,
	visited: ReadonlySet<string>,
	depth: number,
): InternalResolvedDep {
	const parsed = parseTaskRef(rawRef, currentRole);
	const { ref, role, taskId } = parsed;

	if (role === undefined || taskId === undefined) {
		const dep: UiResolvedTaskDep = {
			ref,
			...(role ? { role } : {}),
			...(taskId !== undefined ? { taskId } : {}),
			satisfied: false,
			deadlockReason: "target_not_found",
		};
		return { dep, rootBlocker: dep };
	}

	const nodeKey = `${role}#${taskId}`;
	if (visited.has(nodeKey)) {
		const dep: UiResolvedTaskDep = {
			ref,
			role,
			taskId,
			satisfied: false,
			deadlockReason: "cycle_detected",
		};
		return { dep, rootBlocker: dep };
	}

	const queue = getQueueForRole(queuesByRole, role);
	const target = queue?.tasks.find((t) => t.id === taskId && t.status !== "removed" && t.status !== "gone");

	if (!queue || !target) {
		// Fall back to pre-populated status on UiTaskQueueRef if queuesByRole lacks the target queue
		if (typeof rawRef === "object" && rawRef !== null) {
			if (rawRef.over && !rawRef.over.removed && !rawRef.over.dropped) {
				return {
					dep: {
						ref,
						role,
						taskId,
						...(rawRef.title ? { title: rawRef.title } : {}),
						lifecycleStatus: "done",
						satisfied: true,
					},
				};
			}
			if (rawRef.status === "done") {
				return {
					dep: {
						ref,
						role,
						taskId,
						...(rawRef.title ? { title: rawRef.title } : {}),
						lifecycleStatus: "done",
						satisfied: true,
					},
				};
			}
			if (rawRef.status === "dropped" || rawRef.dropped || rawRef.over?.dropped) {
				const dep: UiResolvedTaskDep = {
					ref,
					role,
					taskId,
					...(rawRef.title ? { title: rawRef.title } : {}),
					lifecycleStatus: "dropped",
					satisfied: false,
					deadlockReason: "target_dropped",
				};
				return { dep, rootBlocker: dep };
			}
		}

		const dep: UiResolvedTaskDep = {
			ref,
			role,
			taskId,
			satisfied: false,
			deadlockReason: "target_not_found",
		};
		return { dep, rootBlocker: dep };
	}

	const queuePaused = Boolean(queue.paused || queue.hold);
	const paused = Boolean(target.paused || target.hold || queuePaused);
	const queueStopped = (queue.queueRunning ?? queue.running) === false;
	const lifecycleStatus = inferTargetLifecycleStatus(target, queuePaused);
	const satisfied = isLifecycleSatisfied(target.status, lifecycleStatus);
	const title = target.title ?? target.plan?.title;

	let deadlockReason: TaskDepDeadlockReason | undefined;
	if (!satisfied) {
		if (target.status === "dropped" || lifecycleStatus === "dropped") {
			deadlockReason = "target_dropped";
		} else if (paused) {
			deadlockReason = "target_paused";
		} else if (
			target.status === "stuck" ||
			target.status === "asking" ||
			lifecycleStatus === "stuck" ||
			lifecycleStatus === "asking"
		) {
			deadlockReason = "target_stuck";
		} else if (queueStopped) {
			deadlockReason = "queue_stopped";
		}
	}

	let targetBlockerSummary: string | undefined;
	let rootBlocker: UiResolvedTaskDep | undefined;

	if (!satisfied && depth < MAX_DEP_WALK_DEPTH) {
		const nextVisited = new Set(visited);
		nextVisited.add(nodeKey);
		const upstreamRefs = extractUpstreamRefsOfTask(target);
		const upstreamUnsatisfied: UiResolvedTaskDep[] = [];

		for (const upRef of upstreamRefs) {
			const upRes = resolveSingleDepInternal(upRef, role, queuesByRole, nextVisited, depth + 1);
			if (upRes.dep.deadlockReason === "cycle_detected") {
				deadlockReason = "cycle_detected";
			}
			if (!upRes.dep.satisfied) {
				upstreamUnsatisfied.push(upRes.dep);
				if (!rootBlocker && (upRes.rootBlocker || upRes.dep)) {
					rootBlocker = upRes.rootBlocker ?? upRes.dep;
				}
			}
		}

		if (upstreamUnsatisfied.length > 0) {
			targetBlockerSummary = `Waiting on ${upstreamUnsatisfied
				.map((u) => `${u.ref} (${u.lifecycleStatus ?? u.deadlockReason ?? "pending"})`)
				.join(", ")}`;
		} else if (target.wait?.what) {
			targetBlockerSummary = `Waiting on ${target.wait.what}`;
		} else if ((target.block?.lead || target.blocked?.lead) && (target.block?.owes || target.blocked?.owes)) {
			const l = target.block?.lead ?? target.blocked?.lead;
			const o = target.block?.owes ?? target.blocked?.owes;
			targetBlockerSummary = `Waiting on ${l} lead: ${o}`;
		}
	}

	const dep: UiResolvedTaskDep = {
		ref,
		role,
		taskId,
		...(title ? { title } : {}),
		lifecycleStatus,
		satisfied,
		paused,
		queueStopped,
		...(targetBlockerSummary ? { targetBlockerSummary } : {}),
		...(deadlockReason ? { deadlockReason } : {}),
	};

	if (!satisfied && !rootBlocker) {
		rootBlocker = dep;
	}

	return { dep, rootBlocker };
}

/**
 * Resolves an array of task references (`"#12"`, `"backend #412"`, etc.) across `queuesByRole`.
 */
export function resolveTaskDeps(
	refs: ReadonlyArray<RawTaskRefInput> | undefined,
	currentRole: string | undefined,
	queuesByRole: QueuesByRoleInput | undefined,
	currentTaskId?: number,
): {
	resolved: UiResolvedTaskDep[];
	canonicalRefs: string[];
	rootBlocker?: UiResolvedTaskDep;
} {
	if (!refs || refs.length === 0) {
		return { resolved: [], canonicalRefs: [] };
	}

	const initialVisited = new Set<string>();
	if (currentRole && currentTaskId !== undefined) {
		initialVisited.add(`${currentRole.toLowerCase()}#${currentTaskId}`);
	}

	const resolved: UiResolvedTaskDep[] = [];
	const canonicalRefs: string[] = [];
	const seenCanonical = new Set<string>();
	let rootBlocker: UiResolvedTaskDep | undefined;

	for (const rawRef of refs) {
		const parsed = parseTaskRef(rawRef, currentRole);
		if (parsed.canonicalRef && !seenCanonical.has(parsed.canonicalRef)) {
			seenCanonical.add(parsed.canonicalRef);
			canonicalRefs.push(parsed.canonicalRef);
		}
		const item = resolveSingleDepInternal(rawRef, currentRole, queuesByRole, initialVisited, 0);
		resolved.push(item.dep);
		if (!item.dep.satisfied) {
			const candidateRoot = item.rootBlocker ?? item.dep;
			// Prefer a root blocker with an actionable deadlock (queue_stopped, target_paused, target_stuck, target_dropped, cycle_detected)
			if (
				!rootBlocker ||
				(!rootBlocker.deadlockReason && candidateRoot.deadlockReason) ||
				(rootBlocker.deadlockReason === "target_not_found" &&
					candidateRoot.deadlockReason &&
					candidateRoot.deadlockReason !== "target_not_found")
			) {
				rootBlocker = candidateRoot;
			}
		}
	}

	return { resolved, canonicalRefs, ...(rootBlocker ? { rootBlocker } : {}) };
}

/**
 * Collects canonical upstream dependency refs (`"<role> #<id>"`, union of `blocked.on`, `after`, and `outside`)
 * for browser-side dependency DAG reconstruction (CONTRACT.md §4.3, Owner comment #3-reply).
 */
export function collectDependsOnRefs(
	currentRole: string | undefined,
	blockedOn?: ReadonlyArray<RawTaskRefInput>,
	after?: ReadonlyArray<number | string>,
	outside?: ReadonlyArray<RawTaskRefObject>,
): string[] | undefined {
	const seen = new Set<string>();
	const out: string[] = [];
	const pushRef = (raw: RawTaskRefInput) => {
		const { canonicalRef } = parseTaskRef(raw, currentRole);
		if (canonicalRef && !seen.has(canonicalRef)) {
			seen.add(canonicalRef);
			out.push(canonicalRef);
		}
	};
	if (Array.isArray(blockedOn)) {
		for (const r of blockedOn) pushRef(r);
	}
	if (Array.isArray(after)) {
		for (const r of after) pushRef(r);
	}
	if (Array.isArray(outside)) {
		for (const r of outside) pushRef(r);
	}
	return out.length > 0 ? out : undefined;
}

function joinWithAnd(items: readonly string[], commaBeforeAnd: boolean = true): string {
	if (items.length === 0) return "";
	if (items.length === 1) return items[0];
	if (items.length === 2) {
		return `${items[0]}${commaBeforeAnd ? ", and " : " and "}${items[1]}`;
	}
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatDepUnblockClause(dep: UiResolvedTaskDep): string | undefined {
	const displayRef = dep.role && dep.taskId !== undefined ? `${dep.role} #${dep.taskId}` : dep.ref;
	switch (dep.deadlockReason) {
		case "queue_stopped":
			return dep.role ? `Resume ${dep.role}'s queue so ${displayRef} can run` : `Resume queue so ${displayRef} can run`;
		case "target_paused":
			return `Resume paused task ${displayRef}`;
		case "target_stuck":
			return `Answer ${displayRef}'s pending question`;
		case "target_dropped":
			return `Replace dropped dependency ${displayRef}`;
		case "cycle_detected":
			return `Break dependency cycle on ${displayRef}`;
		default:
			return undefined;
	}
}

export interface RawBlockInput {
	on?: ReadonlyArray<RawTaskRefInput>;
	need?: string;
	lead?: string;
	owes?: string;
	since?: number;
	sinceAt?: number;
	checkpoint?: number;
	checkpointDueAt?: number;
	reminders?: readonly number[];
	remindersSent?: number;
	nextRemindAt?: number;
	nextReminderAt?: number;
}

/**
 * Resolves `UiRoleTaskBlocked` with cross-queue `resolvedOn`, `unsatisfiedCount`,
 * `checkpointOverdue`, `unblockSummary`, and `howToUnblock`.
 */
export function resolveBlockedState(
	block: RawBlockInput,
	options: {
		currentRole?: string;
		currentTaskId?: number;
		queuesByRole?: QueuesByRoleInput;
		now?: number;
	},
): {
	blocked: UiRoleTaskBlocked;
	dependsOnRefs?: string[];
	rootBlockerRef?: string;
} {
	const now = options.now ?? Date.now();
	const rawOn = block.on ?? [];
	const onStrings = rawOn.map((r) => parseTaskRef(r, options.currentRole).ref);

	const {
		resolved: resolvedOn,
		canonicalRefs,
		rootBlocker,
	} = resolveTaskDeps(rawOn, options.currentRole, options.queuesByRole, options.currentTaskId);

	const unsatisfiedDeps = resolvedOn.filter((d) => !d.satisfied);
	const unsatisfiedCount = unsatisfiedDeps.length;
	const sinceAt = block.sinceAt ?? block.since ?? 0;
	const checkpointDueAt = block.checkpointDueAt ?? block.checkpoint;
	const checkpointOverdue = checkpointDueAt !== undefined ? now >= checkpointDueAt : undefined;
	const remindersSent =
		typeof block.remindersSent === "number"
			? block.remindersSent
			: Array.isArray(block.reminders)
				? block.reminders.length
				: undefined;
	const nextReminderAt = block.nextReminderAt ?? block.nextRemindAt;

	// Build 1-line unblockSummary ("Waiting on ...")
	const waitingParts: string[] = [];
	for (const dep of unsatisfiedDeps) {
		if (dep.deadlockReason === "queue_stopped") {
			waitingParts.push(`${dep.ref} (${dep.lifecycleStatus ?? "queued"} — queue stopped)`);
		} else if (dep.deadlockReason === "target_paused") {
			waitingParts.push(`${dep.ref} (paused)`);
		} else if (dep.deadlockReason === "target_dropped") {
			waitingParts.push(`${dep.ref} (dropped)`);
		} else if (dep.deadlockReason === "target_not_found") {
			waitingParts.push(`${dep.ref} (not found)`);
		} else if (dep.deadlockReason === "cycle_detected") {
			waitingParts.push(`${dep.ref} (cycle detected)`);
		} else {
			waitingParts.push(`${dep.ref} (${dep.lifecycleStatus ?? "pending"})`);
		}
	}
	if (block.lead && block.owes) {
		waitingParts.push(`${block.lead} lead: ${block.owes}`);
	} else if (block.lead) {
		waitingParts.push(`${block.lead} lead`);
	} else if (block.need) {
		waitingParts.push(block.need);
	}
	const unblockSummary =
		waitingParts.length > 0
			? `Waiting on ${joinWithAnd(waitingParts, waitingParts.length >= 2)}`
			: "Waiting on upstream blocker";

	// Build actionable howToUnblock ("How to unblock: ...")
	const clauses: string[] = [];
	for (const dep of unsatisfiedDeps) {
		const clause = formatDepUnblockClause(dep);
		if (clause && !clauses.includes(clause)) {
			clauses.push(clause);
		}
	}
	if (clauses.length === 0 && rootBlocker) {
		const rootClause = formatDepUnblockClause(rootBlocker);
		if (rootClause) clauses.push(rootClause);
	}
	if (clauses.length === 0 && !block.lead) {
		const missingDeps = unsatisfiedDeps.filter((d) => d.deadlockReason === "target_not_found");
		if (missingDeps.length > 0) {
			clauses.push(`Verify or replace missing dependency ${missingDeps.map((d) => d.ref).join(", ")}`);
		} else if (unsatisfiedDeps.length > 0) {
			clauses.push(`Wait for ${unsatisfiedDeps.map((d) => d.ref).join(", ")} to finish`);
		}
	}

	if (block.lead && block.owes) {
		clauses.push(
			clauses.length > 0
				? `have ${block.lead} lead provide ${block.owes}`
				: `Have ${block.lead} lead provide ${block.owes}`,
		);
	} else if (block.lead) {
		clauses.push(clauses.length > 0 ? `have ${block.lead} lead respond` : `Have ${block.lead} lead respond`);
	} else if (block.need && clauses.length === 0) {
		clauses.push(`Provide ${block.need}`);
	}

	const howToUnblock =
		clauses.length > 0
			? `How to unblock: ${joinWithAnd(clauses, true)}`
			: "How to unblock: Resolve the upstream dependency or requirement";

	const rootBlockerRef = rootBlocker
		? rootBlocker.role && rootBlocker.taskId !== undefined
			? `${rootBlocker.role} #${rootBlocker.taskId}`
			: rootBlocker.ref
		: undefined;

	return {
		blocked: {
			...(onStrings.length > 0 ? { on: onStrings } : {}),
			...(resolvedOn.length > 0 ? { resolvedOn } : {}),
			unsatisfiedCount,
			...(block.need ? { need: block.need } : {}),
			...(block.lead ? { lead: block.lead } : {}),
			...(block.owes ? { owes: block.owes } : {}),
			sinceAt,
			...(checkpointDueAt !== undefined ? { checkpointDueAt } : {}),
			...(checkpointOverdue !== undefined ? { checkpointOverdue } : {}),
			...(remindersSent !== undefined ? { remindersSent } : {}),
			...(nextReminderAt !== undefined ? { nextReminderAt } : {}),
			unblockSummary,
			howToUnblock,
		},
		...(canonicalRefs.length > 0 ? { dependsOnRefs: canonicalRefs } : {}),
		...(rootBlockerRef ? { rootBlockerRef } : {}),
	};
}

export interface RawWaitInput {
	what: string;
	check?: string;
	checkCmd?: string;
	since?: number;
	sinceAt?: number;
	everyMs?: number;
	everyMinutes?: number;
	expectByAt?: number;
	expectMinutes?: number;
	until?: number;
	giveUpAt?: number;
	giveUpHours?: number;
	overdue?: boolean;
	lastCheckedAt?: number;
	lastExitCode?: number;
	lastOutput?: string;
	failed?: string;
}

/**
 * Resolves `UiRoleTaskWait` timing, overdue state, and `howToUnblock`.
 */
export function resolveWaitState(wait: RawWaitInput, now: number = Date.now()): UiRoleTaskWait {
	const sinceAt = wait.sinceAt ?? wait.since ?? 0;
	const everyMs =
		wait.everyMs ??
		(typeof wait.everyMinutes === "number" && wait.everyMinutes > 0 ? wait.everyMinutes * 60_000 : 120_000);
	const expectByAt =
		wait.expectByAt ??
		(typeof wait.expectMinutes === "number" && wait.expectMinutes > 0
			? sinceAt + wait.expectMinutes * 60_000
			: sinceAt + 30 * 60_000);
	const giveUpAt =
		wait.giveUpAt ??
		wait.until ??
		(typeof wait.giveUpHours === "number" && wait.giveUpHours > 0
			? sinceAt + wait.giveUpHours * 3_600_000
			: sinceAt + 24 * 3_600_000);
	const overdue = typeof wait.overdue === "boolean" ? wait.overdue : now >= expectByAt;
	const checkCmd = (wait.checkCmd ?? wait.check ?? "").slice(0, 240);
	const lastOutput =
		typeof wait.lastOutput === "string" && wait.lastOutput.trim()
			? wait.lastOutput.trim().slice(0, 240)
			: typeof wait.failed === "string" && wait.failed.trim()
				? wait.failed.trim().slice(0, 240)
				: undefined;

	let howToUnblock: string;
	if (overdue || (typeof wait.lastExitCode === "number" && wait.lastExitCode > 1) || wait.failed) {
		const minsOverdue = Math.max(1, Math.round(Math.max(0, now - expectByAt) / 60_000));
		const exitSuffix = typeof wait.lastExitCode === "number" ? ` (last exit ${wait.lastExitCode})` : "";
		howToUnblock = `How to unblock: Check is overdue by ${minsOverdue}m${exitSuffix} — inspect ${wait.what || "check"} output or wake worker`;
	} else {
		const minsLeft = Math.max(1, Math.round(Math.max(0, expectByAt - now) / 60_000));
		howToUnblock = `Automatic once ${wait.what || "wait"} check passes (~${minsLeft}m left)`;
	}

	return {
		what: wait.what,
		checkCmd,
		sinceAt,
		everyMs,
		expectByAt,
		giveUpAt,
		overdue,
		...(wait.lastCheckedAt !== undefined ? { lastCheckedAt: wait.lastCheckedAt } : {}),
		...(wait.lastExitCode !== undefined ? { lastExitCode: wait.lastExitCode } : {}),
		...(lastOutput ? { lastOutput } : {}),
		howToUnblock,
	};
}

/**
 * Resolves `UiRoleTaskQueuedDetail` explaining why a `"queued"` / `"ready"` task has not started yet.
 */
export function resolveQueuedDetail(
	task: QueueTaskForDeps,
	options: {
		currentRole?: string;
		queueRunning?: boolean;
		lanesAtOnce?: number;
		queueTasks?: readonly QueueTaskForDeps[];
		queuesByRole?: QueuesByRoleInput;
	},
): {
	queuedDetail: UiRoleTaskQueuedDetail;
	dependsOnRefs?: string[];
	hasUpstreamDeadlock: boolean;
	howToUnblock?: string;
	rootBlockerRef?: string;
} {
	const rawAfter: RawTaskRefInput[] = [...(task.after ?? []), ...(task.outside ?? [])];
	const {
		resolved: resolvedAfter,
		canonicalRefs,
		rootBlocker,
	} = resolveTaskDeps(rawAfter, options.currentRole, options.queuesByRole, task.id);
	const unsatisfiedAfter = resolvedAfter.filter((d) => !d.satisfied);
	const queueRunning = options.queueRunning !== false;

	// 1. Waiting on unsatisfied `after` tasks
	if (unsatisfiedAfter.length > 0) {
		const deadlockedDeps = unsatisfiedAfter.filter((d) => Boolean(d.deadlockReason));
		const clauses: string[] = [];
		for (const dep of deadlockedDeps) {
			const c = formatDepUnblockClause(dep);
			if (c && !clauses.includes(c)) clauses.push(c);
		}
		if (clauses.length === 0 && rootBlocker) {
			const rc = formatDepUnblockClause(rootBlocker);
			if (rc) clauses.push(rc);
		}
		const howToUnblock = clauses.length > 0 ? `How to unblock: ${joinWithAnd(clauses, true)}` : undefined;
		const rootBlockerRef = rootBlocker
			? rootBlocker.role && rootBlocker.taskId !== undefined
				? `${rootBlocker.role} #${rootBlocker.taskId}`
				: rootBlocker.ref
			: undefined;

		return {
			queuedDetail: {
				reason: "after",
				resolvedAfter,
				summary: `After ${unsatisfiedAfter
					.map((d) => `${d.ref} (${d.lifecycleStatus ?? d.deadlockReason ?? "pending"})`)
					.join(", ")}`,
			},
			...(canonicalRefs.length > 0 ? { dependsOnRefs: canonicalRefs } : {}),
			hasUpstreamDeadlock: deadlockedDeps.length > 0 || Boolean(rootBlocker?.deadlockReason),
			...(howToUnblock ? { howToUnblock } : {}),
			...(rootBlockerRef ? { rootBlockerRef } : {}),
		};
	}

	// 2. Queue is stopped
	if (!queueRunning) {
		const rolePrefix = options.currentRole ? `${options.currentRole}'s` : "the";
		return {
			queuedDetail: {
				reason: "queue_stopped",
				...(resolvedAfter.length > 0 ? { resolvedAfter } : {}),
				summary: "Queue is stopped",
			},
			...(canonicalRefs.length > 0 ? { dependsOnRefs: canonicalRefs } : {}),
			hasUpstreamDeadlock: true,
			howToUnblock: `How to unblock: Resume ${rolePrefix} queue so ${options.currentRole ? `${options.currentRole} ` : ""}#${task.id} can run`,
		};
	}

	// 3. Conflicting non-shareable touch/lane held by an active task in this queue
	const myTouches = task.normalizedTouches ?? normalizeTouches(task.touches);
	const myNonShareableByRaw = new Map<string, string>();
	for (const t of myTouches) {
		if (!t.shareable) {
			myNonShareableByRaw.set(t.raw.toLowerCase(), t.raw);
			myNonShareableByRaw.set(t.appOrSystem.toLowerCase(), t.raw);
		}
	}

	const queueTasks = options.queueTasks ?? [];
	const activePeers = queueTasks.filter(
		(peer) =>
			peer.id !== task.id &&
			(peer.status === "working" ||
				peer.status === "in_progress" ||
				peer.status === "asking" ||
				peer.status === "stuck" ||
				peer.status === "blocked"),
	);

	if (myNonShareableByRaw.size > 0 && activePeers.length > 0) {
		const conflictingTasks: Array<{ id: number; title: string; touch: string }> = [];
		for (const peer of activePeers) {
			const peerTouches = peer.normalizedTouches ?? normalizeTouches(peer.touches);
			for (const pt of peerTouches) {
				if (pt.shareable) continue;
				const matchTouch =
					myNonShareableByRaw.get(pt.raw.toLowerCase()) ?? myNonShareableByRaw.get(pt.appOrSystem.toLowerCase());
				if (matchTouch) {
					conflictingTasks.push({
						id: peer.id,
						title: peer.title ?? peer.plan?.title ?? `Task #${peer.id}`,
						touch: matchTouch,
					});
					break;
				}
			}
		}
		if (conflictingTasks.length > 0) {
			const first = conflictingTasks[0];
			return {
				queuedDetail: {
					reason: "lane_busy",
					...(resolvedAfter.length > 0 ? { resolvedAfter } : {}),
					conflictingTasks,
					summary: `Lane busy: ${first.touch} held by #${first.id}`,
				},
				...(canonicalRefs.length > 0 ? { dependsOnRefs: canonicalRefs } : {}),
				hasUpstreamDeadlock: false,
			};
		}
	}

	// 4. All worker slots full
	const lanesAtOnce = options.lanesAtOnce ?? 2;
	if (activePeers.length >= lanesAtOnce) {
		return {
			queuedDetail: {
				reason: "slot_full",
				...(resolvedAfter.length > 0 ? { resolvedAfter } : {}),
				summary: `Waiting for a free worker slot (${activePeers.length}/${lanesAtOnce} busy)`,
			},
			...(canonicalRefs.length > 0 ? { dependsOnRefs: canonicalRefs } : {}),
			hasUpstreamDeadlock: false,
		};
	}

	// 5. Ready to start on next tick
	return {
		queuedDetail: {
			reason: "ready",
			...(resolvedAfter.length > 0 ? { resolvedAfter } : {}),
			summary: "Ready to start next",
		},
		...(canonicalRefs.length > 0 ? { dependsOnRefs: canonicalRefs } : {}),
		hasUpstreamDeadlock: false,
	};
}
