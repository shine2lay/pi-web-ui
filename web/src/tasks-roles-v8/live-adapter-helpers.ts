import type {
	UiRoleAsk as ProtocolUiRoleAsk,
	UiRolesOverview as ProtocolUiRolesOverview,
	UiRoleTask as ProtocolUiRoleTask,
	UiWorkPage as ProtocolUiWorkPage,
} from "../../../server/protocol.js";
import type { TaskPriority } from "../components/TaskPriorityBadge.js";
import type { InitiativesExactInput } from "../initiatives-exact-model.js";
import type { WorkPageFeed } from "../initiatives-page/model.js";
import type { RolesState } from "../roles-state.js";
import type {
	TasksRolesV8Dataset,
	UiRoleTask,
	UiRoleTaskBlocked,
	UiRoleTaskQueuedDetail,
	UiRoleTaskRawStatus,
	UiRoleTaskWait,
	UiTaskDeliveryState,
	UiTaskLifecycleStatus,
} from "./types.js";

const APP_DISPLAY_LABELS: Readonly<Record<string, string>> = {
	rollcall: "RollCall",
	"pi-web-ui": "Pi Web UI",
	inkflow: "Inkflow",
	showtell: "Show&Tell",
	"show-and-tell": "Show&Tell",
	temper: "Temper",
	"temper-ai": "Temper",
	standee: "Standee",
	"pi-agent": "Pi Agent",
	general: "Workspace",
};

const ROLE_SHORT_TITLES: Readonly<Record<string, string>> = {
	architecture: "Architecture",
	backend: "Backend",
	coo: "COO",
	data: "Data",
	design: "Design",
	docs: "Docs",
	frontend: "Frontend",
	marketing: "Marketing",
	ops: "Ops",
	product: "Product",
	qa: "QA",
	rollcall: "RollCall",
	security: "Security",
	systems: "Systems",
	temper: "Temper",
};

export interface LiveChatTarget {
	file: string;
	focus?: {
		kind: "tldr" | "task" | "question";
		id: string;
	};
	jumpAt?: number;
}

export interface LiveTasksRolesAdapterInput {
	overview?: ProtocolUiRolesOverview | null;
	workPage?: ProtocolUiWorkPage | null;
	rolesState?: RolesState | null;
	workState?: WorkPageFeed | null;
	exactInput?: InitiativesExactInput | null;
	now?: number;
}

export interface LiveTasksRolesAdaptedResult {
	dataset: TasksRolesV8Dataset;
	mode: "normal" | "loading" | "empty" | "error";
	asksByTaskId: ReadonlyMap<number, ProtocolUiRoleAsk>;
	chatByTaskId: ReadonlyMap<number, LiveChatTarget>;
	chatByRoleId: ReadonlyMap<string, string>;
	tasksById: ReadonlyMap<number, UiRoleTask>;
}

/** Flexible task input accepting protocol UiRoleTask, UiWorkPageTask, or v8 task fields. */
export type AdaptableTaskInput = Omit<
	Partial<ProtocolUiRoleTask>,
	"status" | "delivery" | "blocked" | "wait" | "paused" | "updatedAt"
> & {
	id: number;
	status: UiRoleTaskRawStatus;
	priority?: TaskPriority;
	text?: string;
	summary?: string;
	endedAt?: number;
	updatedAt?: number | string;
	updatedAtMs?: number;
	question?: string;
	choices?: readonly string[];
	pipelineStage?: 1 | 2 | 3 | 4 | 5;
	paused?: boolean | { why?: string; at?: number };
	pausedReason?: string;
	latestTldr?: { text: string; at?: number; age?: string };
	delivery?: Partial<UiTaskDeliveryState>;
	blocked?: Partial<UiRoleTaskBlocked>;
	wait?: Partial<UiRoleTaskWait>;
};

export function shortRoleTitle(roleId: string, fallbackTitle?: string): string {
	const key = roleId.trim().toLowerCase();
	if (ROLE_SHORT_TITLES[key]) return ROLE_SHORT_TITLES[key];
	if (fallbackTitle && fallbackTitle.trim()) return fallbackTitle.trim();
	return key ? key.charAt(0).toUpperCase() + key.slice(1) : "Dept";
}

export function formatAppDisplayLabel(appOrSystem: string): string {
	const key = appOrSystem.trim().toLowerCase();
	if (APP_DISPLAY_LABELS[key]) return APP_DISPLAY_LABELS[key];
	return appOrSystem
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function formatRelativeAge(ts: number | undefined, now = Date.now()): string {
	if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return "just now";
	const diffSec = Math.max(0, Math.round((now - ts) / 1000));
	if (diffSec < 60) return "just now";
	const diffMin = Math.round(diffSec / 60);
	if (diffMin < 60) return `${diffMin}m ago`;
	const diffHr = Math.round(diffMin / 60);
	if (diffHr < 48) return `${diffHr}h ago`;
	const diffDays = Math.round(diffHr / 24);
	return `${diffDays}d ago`;
}

export function cleanTagSlug(raw: string): string {
	return raw
		.trim()
		.replace(/^#+/, "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function inferAppFromText(text: string): string | undefined {
	const lower = text.toLowerCase();
	if (lower.includes("rollcall")) return "rollcall";
	if (lower.includes("pi-web-ui") || lower.includes("roles") || lower.includes("initiatives")) return "pi-web-ui";
	if (lower.includes("inkflow")) return "inkflow";
	if (lower.includes("show&tell") || lower.includes("show-and-tell") || lower.includes("showtell")) return "showtell";
	if (lower.includes("temper")) return "temper";
	return undefined;
}

export function deriveLifecycleFromProtocolTask(task: AdaptableTaskInput, queueRunning = true): UiTaskLifecycleStatus {
	if (task.lifecycleStatus) {
		return task.lifecycleStatus;
	}
	if (task.status === "dropped") return "dropped";
	if (task.paused) return "paused";
	if (task.status === "stuck") return task.withLead ? "asking" : "stuck";
	if (task.status === "asking") return task.withLead ? "asking" : "stuck";
	if (task.status === "blocked") return "blocked";
	if (task.status === "waiting") return "waiting";
	if (task.status === "ready") {
		return queueRunning ? "queued" : "paused";
	}
	if (
		task.status === "done" ||
		(!task.status && (task.endedAt !== undefined || task.evidence !== undefined || task.summary !== undefined))
	) {
		const ev = task.evidence;
		if (ev && "at" in ev.live) return "live";
		if (ev && ("at" in ev.installed || "at" in ev.checked)) return "landed";
		return "done";
	}
	return "working";
}

export function mapProtocolDelivery(
	task: AdaptableTaskInput,
	appOrSystem: string,
	now: number,
): UiTaskDeliveryState | undefined {
	if (task.delivery) {
		const d = task.delivery;
		const landedAge = d.landedAge ?? (d.landedAt !== undefined ? formatRelativeAge(d.landedAt, now) : undefined);
		const deployedAge =
			d.deployedAge ?? (d.deployedAt !== undefined ? formatRelativeAge(d.deployedAt, now) : undefined);
		return {
			repo: d.repo ?? appOrSystem,
			deployableService: d.deployableService ?? true,
			...(d.landId ? { landId: d.landId } : {}),
			...(d.landStatus ? { landStatus: d.landStatus } : {}),
			...(d.headCommit ? { headCommit: d.headCommit } : {}),
			...(d.landingAge ? { landingAge: d.landingAge } : {}),
			...(d.landedCommit ? { landedCommit: d.landedCommit } : {}),
			...(d.landedAt !== undefined ? { landedAt: d.landedAt } : {}),
			...(landedAge ? { landedAge } : {}),
			...(d.deployingAge ? { deployingAge: d.deployingAge } : {}),
			...(d.deployStatus ? { deployStatus: d.deployStatus } : {}),
			...(d.liveCommit ? { liveCommit: d.liveCommit } : {}),
			...(d.deployedAt !== undefined ? { deployedAt: d.deployedAt } : {}),
			...(deployedAge ? { deployedAge } : {}),
			...(d.pendingReason ? { pendingReason: d.pendingReason } : {}),
			...(d.deployPendingReason ? { deployPendingReason: d.deployPendingReason } : {}),
			...(d.error ? { error: d.error } : {}),
		};
	}
	if (task.evidence) {
		const ev = task.evidence;
		const landedCommit = ev.commit;
		const liveAt = "at" in ev.live ? ev.live.at : undefined;
		const checkedAt = "at" in ev.checked ? ev.checked.at : undefined;
		return {
			repo: ev.repo ?? appOrSystem,
			deployableService: true,
			...(landedCommit ? { landedCommit } : {}),
			...(checkedAt !== undefined
				? { landedAt: checkedAt, landedAge: formatRelativeAge(checkedAt, now), landStatus: "succeeded" }
				: {}),
			...(liveAt !== undefined && landedCommit
				? {
						liveCommit: landedCommit,
						deployedAt: liveAt,
						deployedAge: formatRelativeAge(liveAt, now),
						deployStatus: "succeeded",
					}
				: {}),
		};
	}
	return undefined;
}

export function stripLeadingUnblockPrefix(text: string): string {
	return text.replace(/^(?:how to unblock:\s*)+/i, "").trim();
}

export function isRawShellCheckUnblock(text: string | undefined): boolean {
	if (!text) return false;
	return text.includes("bash -c") || text.includes("Wait on '") || text.includes("for f in /");
}

export function mapProtocolBlocked(task: AdaptableTaskInput, now: number): UiRoleTaskBlocked | undefined {
	const b = task.blocked as
		| (Partial<UiRoleTaskBlocked> & {
				deadlock?: boolean | string;
				sinceAge?: string;
				checkpointDueIn?: string;
		  })
		| undefined;
	if (!b) return undefined;
	const resolvedOn = (b.resolvedOn ?? []).map((dep) => ({
		ref: dep.ref,
		...(dep.role ? { role: dep.role } : {}),
		...(dep.taskId !== undefined ? { taskId: dep.taskId } : {}),
		...(dep.title ? { title: dep.title } : {}),
		...(dep.lifecycleStatus ? { lifecycleStatus: dep.lifecycleStatus } : {}),
		...((dep.status ?? dep.lifecycleStatus) ? { status: dep.status ?? dep.lifecycleStatus } : {}),
		satisfied: dep.satisfied,
		...(dep.paused !== undefined ? { paused: dep.paused } : {}),
		...(dep.queueStopped !== undefined ? { queueStopped: dep.queueStopped } : {}),
		...(dep.targetBlockerSummary ? { targetBlockerSummary: dep.targetBlockerSummary } : {}),
		...(dep.deadlockReason ? { deadlockReason: dep.deadlockReason } : {}),
		...(dep.halted ? { halted: dep.halted } : {}),
	}));
	const summaryParts = resolvedOn.map((d) => `${d.ref} (${d.lifecycleStatus ?? "pending"})`);
	if (b.lead && b.owes) summaryParts.push(`${b.lead} lead: ${b.owes}`);
	const unblockSummary =
		b.unblockSummary ||
		(summaryParts.length > 0
			? `Waiting on ${summaryParts.join(", ")}`
			: b.need || b.owes || (task.waitsOn ? `Waiting on ${task.waitsOn}` : "Blocked on upstream dependency"));
	const rawHowToUnblock = b.howToUnblock || task.howToUnblock || `Resolve ${unblockSummary}`;
	const howToUnblock = stripLeadingUnblockPrefix(rawHowToUnblock);
	const deadlockReasonFromDep = resolvedOn.find((d) => d.deadlockReason)?.deadlockReason;
	const deadlock =
		b.deadlock ??
		(deadlockReasonFromDep
			? true
			: resolvedOn.some((d) => d.paused || d.queueStopped)
				? `Target dependency is paused or queue-stopped`
				: undefined);
	const sinceAge = b.sinceAge ?? (b.sinceAt ? formatRelativeAge(b.sinceAt, now) : undefined);
	return {
		...(b.on ? { on: b.on } : {}),
		resolvedOn,
		unsatisfiedCount: b.unsatisfiedCount ?? resolvedOn.filter((d) => !d.satisfied).length,
		...(b.need ? { need: b.need } : {}),
		...(b.lead ? { lead: b.lead } : {}),
		...(b.owes ? { owes: b.owes } : {}),
		sinceAt: b.sinceAt ?? now,
		...(sinceAge ? { sinceAge } : {}),
		...(b.checkpointDueAt !== undefined ? { checkpointDueAt: b.checkpointDueAt } : {}),
		...(b.checkpointDueIn ? { checkpointDueIn: b.checkpointDueIn } : {}),
		...(b.checkpointOverdue !== undefined ? { checkpointOverdue: b.checkpointOverdue } : {}),
		...(b.remindersSent !== undefined ? { remindersSent: b.remindersSent } : {}),
		...(b.nextReminderAt !== undefined ? { nextReminderAt: b.nextReminderAt } : {}),
		...(deadlock !== undefined ? { deadlock } : {}),
		unblockSummary,
		howToUnblock,
	} as UiRoleTaskBlocked;
}

export function mapProtocolWait(task: AdaptableTaskInput, now: number): UiRoleTaskWait | undefined {
	const w = task.wait;
	if (!w) return undefined;
	const elapsedMin = w.elapsedMin ?? Math.max(1, Math.round((now - (w.sinceAt || now)) / 60000));
	const expectMin = w.expectMin ?? Math.max(1, Math.round(((w.expectByAt || now) - (w.sinceAt || now)) / 60000));
	const everyMin = w.everyMin ?? Math.max(1, Math.round((w.everyMs || 120000) / 60000));
	const overdue = Boolean(w.overdue);
	const what = w.what ?? "external check";
	const overdueNote =
		w.overdueNote ?? (overdue ? `⚠ Overdue (${elapsedMin}m elapsed vs ${expectMin}m expected)` : undefined);
	const fallbackWaitUnblock = overdue
		? `Check overdue (${elapsedMin}m elapsed vs ${expectMin}m expected): inspect ${what}`
		: `Waiting on ${what}`;
	const candidateUnblock = w.howToUnblock || task.howToUnblock;
	const cleanWaitUnblock =
		candidateUnblock && !isRawShellCheckUnblock(candidateUnblock)
			? stripLeadingUnblockPrefix(candidateUnblock)
			: fallbackWaitUnblock;
	return {
		what,
		checkCmd: w.checkCmd || (w as { check?: string }).check || "check",
		sinceAt: w.sinceAt ?? now,
		everyMs: w.everyMs ?? everyMin * 60000,
		expectByAt: w.expectByAt ?? now + expectMin * 60000,
		giveUpAt: w.giveUpAt ?? now + 24 * 3600 * 1000,
		elapsedMin,
		expectMin,
		everyMin,
		overdue,
		...(overdueNote ? { overdueNote } : {}),
		...(w.lastCheckedAt !== undefined ? { lastCheckedAt: w.lastCheckedAt } : {}),
		...(w.lastExitCode !== undefined ? { lastExitCode: w.lastExitCode } : {}),
		...(w.lastOutput ? { lastOutput: w.lastOutput } : {}),
		howToUnblock: cleanWaitUnblock,
	} as UiRoleTaskWait;
}

export function mapProtocolQueued(task: AdaptableTaskInput, roleId: string): UiRoleTaskQueuedDetail | undefined {
	const q = task.queuedDetail;
	if (!q) {
		if (task.after && task.after.length > 0) {
			return {
				reason: "after",
				summary: `Starts when ${task.after.map((id) => `${roleId} #${id}`).join(", ")} finishes`,
				resolvedAfter: task.after.map((id) => ({
					ref: `${roleId} #${id}`,
					role: roleId,
					...(typeof id === "number" ? { taskId: id } : {}),
					satisfied: false,
				})),
			};
		}
		return undefined;
	}
	return {
		reason: q.reason,
		summary:
			q.summary ||
			(q.reason === "after" && q.resolvedAfter?.length
				? `Starts when ${q.resolvedAfter.map((d) => d.ref).join(", ")} finishes`
				: q.reason === "lane_busy" && q.conflictingTasks?.length
					? `Lane busy: ${q.conflictingTasks.map((c) => `${c.touch} (#${c.id})`).join(", ")}`
					: q.reason === "slot_full"
						? "Waiting for a free department lane"
						: q.reason === "queue_stopped"
							? "Queue is currently stopped"
							: "Queued next in line"),
		...(q.resolvedAfter ? { resolvedAfter: q.resolvedAfter } : {}),
		...(q.conflictingTasks ? { conflictingTasks: q.conflictingTasks } : {}),
	};
}

export function parseTaskNumberFromFocus(focus: string | undefined, key: string | undefined): number | null {
	for (const candidate of [focus, key]) {
		if (!candidate) continue;
		const m = /(?:^|:)task:(\d+)$/.exec(candidate) ?? /^#?(\d+)$/.exec(candidate);
		if (m) {
			const n = Number(m[1]);
			if (Number.isFinite(n) && n > 0) return n;
		}
	}
	return null;
}
