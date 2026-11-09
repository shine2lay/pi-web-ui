import type {
	UiRoleOverview,
	UiRolesOverview,
	UiRoleTask as LegacyUiRoleTask,
	UiTaskRequester,
} from "../../../server/protocol";

export type { UiRoleOverview, UiRolesOverview };

export const TAG_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
export const MAX_TAGS_PER_ITEM = 16;

export type TagCheckResult = { ok: true; value: string[] | undefined } | { ok: false; error: string };

/**
 * Validates and deduplicates an optional tags input at a tool or API boundary.
 * Fails loud and fast on non-arrays, non-strings, uppercase, spaces, underscores,
 * leading hyphens, >60 chars, or >maxTags unique tags.
 */
export function checkTags(raw: unknown, maxTags: number = MAX_TAGS_PER_ITEM): TagCheckResult {
	if (raw === undefined) return { ok: true, value: undefined };
	if (!Array.isArray(raw)) {
		return {
			ok: false,
			error: "tags must be an array of tag slugs (lowercase letters, digits, and dashes; 1-60 chars each).",
		};
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (typeof item !== "string") {
			return {
				ok: false,
				error: `invalid tag at index ${i}: each tag must be a string slug.`,
			};
		}
		const trimmed = item.trim();
		if (trimmed.length === 0 || trimmed.length > 60 || !TAG_SLUG_RE.test(trimmed)) {
			return {
				ok: false,
				error: `invalid tag "${item}": use lowercase letters, digits, and dashes (at most 60 characters, e.g. "roles-rework").`,
			};
		}
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			out.push(trimmed);
		}
	}
	if (out.length > maxTags) {
		return {
			ok: false,
			error: `too many tags (${out.length}): at most ${maxTags} tags are allowed per item.`,
		};
	}
	return { ok: true, value: out };
}

/**
 * Merges inherited tags from turn origin inputs when caller omits explicit tags on task creation.
 */
export function resolveInheritedTags(
	explicitTags: string[] | undefined,
	originInputs: ReadonlyArray<{ tags?: string[] }> | undefined,
	maxTags: number = MAX_TAGS_PER_ITEM,
): string[] | undefined {
	if (explicitTags !== undefined) {
		return explicitTags.length > 0 ? explicitTags : undefined;
	}
	if (!originInputs || originInputs.length === 0) return undefined;
	const seen = new Set<string>();
	const inherited: string[] = [];
	for (const input of originInputs) {
		if (!Array.isArray(input.tags)) continue;
		for (const tag of input.tags) {
			if (typeof tag === "string" && TAG_SLUG_RE.test(tag) && !seen.has(tag)) {
				seen.add(tag);
				inherited.push(tag);
				if (inherited.length >= maxTags) break;
			}
		}
		if (inherited.length >= maxTags) break;
	}
	return inherited.length > 0 ? inherited : undefined;
}

/**
 * Resolves stored tags for queue_add create and update operations per CONTRACT.md §1.3.
 */
export function resolveQueueTaskTags(params: {
	isUpdate: boolean;
	explicitTags?: string[];
	originInputs?: ReadonlyArray<{ tags?: string[] }>;
	existingTaskTags?: ReadonlyArray<string>;
	maxTags?: number;
}): string[] {
	const maxTags = params.maxTags ?? MAX_TAGS_PER_ITEM;
	if (params.explicitTags !== undefined) {
		const checked = checkTags(params.explicitTags, maxTags);
		if (!checked.ok) {
			throw new Error(checked.error);
		}
		return checked.value ?? [];
	}
	if (params.isUpdate) {
		return params.existingTaskTags ? [...params.existingTaskTags] : [];
	}
	return resolveInheritedTags(undefined, params.originInputs, maxTags) ?? [];
}

export type TouchKind = "repo" | "deploy" | "service" | "config" | "artifact";

export interface UiNormalizedTouch {
	raw: string;
	appOrSystem: string;
	repo?: string;
	kind: TouchKind;
	shareable: boolean;
}

/**
 * Pure deterministic normalizer mapping raw touch strings to canonical appOrSystem & repo keys
 * per CONTRACT.md §2.3. Fails loud if raw is not a non-empty string.
 */
export function normalizeTouch(raw: string): UiNormalizedTouch {
	if (typeof raw !== "string" || raw.trim().length === 0) {
		throw new Error("normalizeTouch requires a non-empty string.");
	}
	const trimmed = raw.trim();
	const lower = trimmed.toLowerCase();

	if (lower === "pi-web-ui repo" || lower === "pi-web-ui" || lower.startsWith("/home/shinelay/projects/pi-web-ui")) {
		return { raw, appOrSystem: "pi-web-ui", repo: "pi-web-ui", kind: "repo", shareable: true };
	}
	if (lower === "pi-web-deploy") {
		return { raw, appOrSystem: "pi-web-ui", repo: "pi-web-ui", kind: "deploy", shareable: true };
	}
	if (lower === "rollcall repo" || lower === "rollcall" || lower.startsWith("/home/shinelay/rollcall")) {
		return { raw, appOrSystem: "rollcall", repo: "rollcall", kind: "repo", shareable: true };
	}
	if (lower === "rollcall-deploy" || lower === "wt deploy rollcall") {
		return { raw, appOrSystem: "rollcall", repo: "rollcall", kind: "deploy", shareable: true };
	}
	if (lower === "inkflow repo" || lower === "inkflow" || lower.startsWith("/home/shinelay/projects/inkflow")) {
		return { raw, appOrSystem: "inkflow", repo: "inkflow", kind: "repo", shareable: true };
	}
	if (lower === "inkflow-deploy" || lower === "wt deploy inkflow") {
		return { raw, appOrSystem: "inkflow", repo: "inkflow", kind: "deploy", shareable: true };
	}
	if (
		lower === "temper-ai repo" ||
		lower === "temper repo" ||
		lower === "temper-ai" ||
		lower.startsWith("/home/shinelay/temper-ai")
	) {
		return { raw, appOrSystem: "temper", repo: "temper-ai", kind: "repo", shareable: true };
	}
	if (lower === "temper-deploy") {
		return { raw, appOrSystem: "temper", repo: "temper-ai", kind: "deploy", shareable: true };
	}
	if (lower === "temper-dev") {
		return { raw, appOrSystem: "temper", repo: "temper-ai", kind: "service", shareable: false };
	}
	if (
		lower === "show-and-tell repo" ||
		lower === "show-and-tell" ||
		lower === "showtell" ||
		lower.startsWith("/home/shinelay/projects/show-and-tell")
	) {
		return { raw, appOrSystem: "show-and-tell", repo: "show-and-tell", kind: "repo", shareable: true };
	}
	if (lower === "showtell-deploy") {
		return { raw, appOrSystem: "show-and-tell", repo: "show-and-tell", kind: "deploy", shareable: true };
	}
	if (
		lower === "agent-tools repo" ||
		lower === "agent-tools" ||
		lower.startsWith("/home/shinelay/projects/agent-tools")
	) {
		return { raw, appOrSystem: "agent-tools", repo: "agent-tools", kind: "repo", shareable: true };
	}
	if (lower === "standee") {
		return { raw, appOrSystem: "standee", kind: "service", shareable: false };
	}
	if (lower === "scheduler") {
		return { raw, appOrSystem: "scheduler", kind: "service", shareable: false };
	}
	if (lower === "pi settings.json" || lower === "settings.json" || lower === "~/.pi/agent/settings.json") {
		return { raw, appOrSystem: "pi-agent", kind: "config", shareable: false };
	}

	const repoMatch = /^([a-z0-9][a-z0-9-]*) repo$/.exec(lower);
	if (repoMatch) {
		return {
			raw,
			appOrSystem: repoMatch[1],
			repo: repoMatch[1],
			kind: "repo",
			shareable: true,
		};
	}

	const folderMatch = /^([a-z0-9][a-z0-9-]*) (?:contract|doc|work|proof) folder$/.exec(lower);
	if (folderMatch) {
		return {
			raw,
			appOrSystem: folderMatch[1],
			kind: "artifact",
			shareable: false,
		};
	}

	const firstToken = lower
		.split(/\s+/)[0]
		?.replace(/[^a-z0-9-]/g, "")
		.replace(/^-+|-+$/g, "");
	return {
		raw,
		appOrSystem: firstToken || "workspace",
		kind: "artifact",
		shareable: false,
	};
}

export function normalizeTouches(rawTouches: ReadonlyArray<string> | undefined): UiNormalizedTouch[] {
	if (!Array.isArray(rawTouches)) return [];
	const out: UiNormalizedTouch[] = [];
	for (const raw of rawTouches) {
		if (typeof raw === "string" && raw.trim().length > 0) {
			out.push(normalizeTouch(raw));
		}
	}
	return out;
}

export type UiTaskLifecycleStatus =
	| "paused"
	| "stuck"
	| "asking"
	| "blocked"
	| "waiting"
	| "queued"
	| "working"
	| "landing"
	| "landed"
	| "deploying"
	| "live"
	| "done"
	| "dropped";

export type DeployPendingReason = "not_deployed_yet" | "commit_behind" | "last_deploy_failed" | "health_unverified";

export interface UiTaskDeliveryState {
	repo: string;
	deployableService: boolean;
	landId?: string;
	landStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	landedCommit?: string;
	landedAt?: number;
	headCommit?: string;
	landingAge?: string;
	landedAge?: string;
	deployingAge?: string;
	deployedAge?: string;
	pendingReason?: string;
	deployStatus?: "deploying" | "succeeded" | "failed" | "rolled_back";
	liveCommit?: string;
	deployedAt?: number;
	deployPendingReason?: DeployPendingReason;
	error?: string;
}

export type UiGroupRollupStatus =
	| "needs_you"
	| "needs_lead"
	| "stalled"
	| "deploying"
	| "landing"
	| "working"
	| "landed_pending_deploy"
	| "queued"
	| "paused"
	| "live"
	| "done"
	| "dropped";

export type UiStatusTone =
	| "needs_you"
	| "needs_lead"
	| "asking_lead"
	| "blocked"
	| "waiting"
	| "paused"
	| "queued"
	| "working"
	| "landed"
	| "deploying"
	| "live"
	| "done"
	| "dropped"
	| "active";

export type TaskDepDeadlockReason =
	"target_not_found" | "target_dropped" | "target_paused" | "queue_stopped" | "target_stuck" | "cycle_detected";

export interface UiResolvedTaskDep {
	ref: string;
	role?: string;
	taskId?: number;
	title?: string;
	lifecycleStatus?: UiTaskLifecycleStatus;
	status?: UiTaskLifecycleStatus;
	satisfied: boolean;
	paused?: boolean;
	queueStopped?: boolean;
	targetBlockerSummary?: string;
	deadlockReason?: TaskDepDeadlockReason;
	halted?: string;
}

export interface UiRoleTaskBlocked {
	on?: string[];
	resolvedOn?: UiResolvedTaskDep[];
	unsatisfiedCount: number;
	need?: string;
	lead?: string;
	owes?: string;
	sinceAt: number;
	checkpointDueAt?: number;
	checkpointOverdue?: boolean;
	remindersSent?: number;
	nextReminderAt?: number;
	dueIn?: string;
	haltedWarning?: string;
	unblockSummary: string;
	howToUnblock: string;
}

export interface UiRoleTaskWait {
	what: string;
	checkCmd: string;
	sinceAt: number;
	everyMs: number;
	expectByAt: number;
	giveUpAt: number;
	overdue: boolean;
	elapsedMin?: number;
	expectMin?: number;
	everyMin?: number;
	overdueNote?: string;
	lastCheckedAt?: number;
	lastExitCode?: number;
	lastOutput?: string;
	howToUnblock: string;
}

export type QueuedWaitReason = "ready" | "after" | "lane_busy" | "slot_full" | "queue_stopped";

export interface UiRoleTaskQueuedDetail {
	reason: QueuedWaitReason;
	resolvedAfter?: UiResolvedTaskDep[];
	conflictingTasks?: Array<{ id: number; title: string; touch: string }>;
	summary: string;
}

export type UiRoleTaskRawStatus =
	| "in_progress"
	| "working"
	| "ready"
	| "waiting"
	| "blocked"
	| "stuck"
	| "asking"
	| "queued"
	| "paused"
	| "done"
	| "dropped";

export interface UiRoleTask {
	id: number;
	displayId?: number;
	taskKey?: string;
	role?: string;
	roleTitle?: string;
	title: string;
	status: UiRoleTaskRawStatus;
	lifecycleStatus: UiTaskLifecycleStatus;
	statusTone: UiStatusTone;
	howToUnblock?: string;
	dependsOnRefs?: string[];
	paused?: boolean;
	pausedReason?: string;
	initiative?: string;
	project?: string;
	appOrSystem?: string;
	appLabel?: string;
	tags?: string[];
	touches?: string[];
	normalizedTouches?: UiNormalizedTouch[];
	standalone?: boolean;
	pipelineStage?: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	updatedAt: number;
	updatedAtMs?: number;
	origin?: UiTaskRequester;
	goal?: string;
	doneSummary?: string;
	latestTldr?: { text: string; at?: number; age?: string };
	delivery?: UiTaskDeliveryState;
	wait?: UiRoleTaskWait;
	blocked?: UiRoleTaskBlocked;
	stuck?: {
		question: string;
		choices?: string[];
		needsOwner?: { kind: string; why: string };
		sinceAt?: number;
		age?: string;
		tier?: "lead" | "owner";
	};
	askingLead?: {
		leadRole: string;
		question: string;
		age?: string;
		sinceAt?: number;
	};
	after?: (number | string)[];
	queuedDetail?: UiRoleTaskQueuedDetail;
	chat?: { file: string; title?: string };
}

export type V8Task = UiRoleTask;
export type { V8FilterState } from "./filters";

/**
 * Parses an epoch-ms number, numeric string, or ISO timestamp string into epoch milliseconds.
 * Returns `undefined` when the value is absent, zero, or not a valid positive timestamp.
 */
export function parseTimestampMs(raw: unknown): number | undefined {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
		return raw;
	}
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		if (/^\d+(\.\d+)?$/.test(trimmed)) {
			const num = Number(trimmed);
			if (Number.isFinite(num) && num > 0) return num;
		}
		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return undefined;
}

export interface UiTaskGroupRollup {
	key: string;
	kind: "tag" | "project" | "initiative";
	title?: string;
	whySummary?: string;
	appOrSystem?: string;
	appLabel?: string;
	tags?: string[];
	rollupStatus: UiGroupRollupStatus;
	statusTone: UiStatusTone;
	howToUnblock?: string;
	rootBlockerRef?: string | null;
	totalTasks: number;
	countsByStatus: Partial<Record<UiTaskLifecycleStatus, number>>;
	hasBlockedPeers: boolean;
	roles: string[];
	appsOrSystems: string[];
	updatedAt: number;
	handoff?: Array<{
		role: string;
		roleTitle: string;
		status: UiTaskLifecycleStatus;
		summary: string;
	}>;
	tasks?: UiRoleTask[];
}

export interface UiTouchSystemSummary {
	appOrSystem: string;
	label?: string;
	repo?: string;
	activeTaskCount: number;
	totalTaskCount: number;
	tags: string[];
}

export interface V8DepartmentSummary {
	id: string;
	title: string;
	inUse: number;
	atOnce: number;
	queueRunning: boolean;
	homeChat?: { file: string; title?: string };
	note?: string;
}

export interface V8TagOption {
	id: string;
	label: string;
	touches: string[];
}

export interface TasksRolesV8Dataset {
	askGroups: UiTaskGroupRollup[];
	tasks: UiRoleTask[];
	departments: V8DepartmentSummary[];
	idleDepartments: Array<{ id: string; title: string; note: string }>;
	touchSystems: Array<{ id: string; label: string; count: number }>;
	allTags: V8TagOption[];
	nowMs?: number;
}

const DEPLOYABLE_REPOS = new Set(["pi-web-ui", "rollcall", "inkflow", "temper-ai", "show-and-tell"]);

export function statusToneForLifecycle(status: UiTaskLifecycleStatus): UiStatusTone {
	switch (status) {
		case "stuck":
			return "needs_you";
		case "asking":
			return "needs_lead";
		case "blocked":
			return "blocked";
		case "waiting":
			return "waiting";
		case "paused":
			return "paused";
		case "queued":
			return "queued";
		case "working":
			return "working";
		case "landing":
		case "landed":
			return "landed";
		case "deploying":
			return "deploying";
		case "live":
		case "done":
			return "live";
		case "dropped":
			return "dropped";
	}
}

export function statusToneForRollup(
	rollup: UiGroupRollupStatus,
	countsByStatus?: Partial<Record<UiTaskLifecycleStatus, number>>,
): UiStatusTone {
	switch (rollup) {
		case "needs_you":
			return "needs_you";
		case "needs_lead":
			return "needs_lead";
		case "stalled":
			return (countsByStatus?.blocked ?? 0) > 0 ? "blocked" : "waiting";
		case "deploying":
			return "deploying";
		case "landing":
		case "landed_pending_deploy":
			return "landed";
		case "working":
			return "working";
		case "queued":
			return "queued";
		case "paused":
			return "paused";
		case "live":
		case "done":
			return "live";
		case "dropped":
			return "dropped";
	}
}

export interface ResolveLifecycleInput {
	task: {
		id: number;
		role?: string;
		status: string;
		paused?: boolean;
		touches?: string[];
		doneSummary?: string;
		wait?: { what?: string; check?: string; since?: number };
		delivery?: {
			repo?: string;
			deployableService?: boolean;
			landId?: string;
			landStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled";
			landedCommit?: string;
			deployStatus?: "deploying" | "succeeded" | "failed" | "rolled_back";
			liveCommit?: string;
			deployPendingReason?: DeployPendingReason;
		};
	};
	queueRunning?: boolean;
	wtLandRecord?: {
		id: string;
		repo: string;
		status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
		headSha?: string;
		landedSha?: string;
	} | null;
	wtDeployRecord?: {
		repo: string;
		targetBranch?: string;
		status: "deploying" | "succeeded" | "failed" | "rolled_back";
		commit?: string;
		healthOk?: boolean;
		healthCommit?: string;
	} | null;
	isLandedCommitAncestorOfLive?: boolean;
}

export function resolveTaskLifecycleStatus(input: ResolveLifecycleInput): {
	lifecycleStatus: UiTaskLifecycleStatus;
	statusTone: UiStatusTone;
	delivery?: UiTaskDeliveryState;
} {
	const { task, queueRunning = true, wtLandRecord, wtDeployRecord } = input;
	const normalizedTouches = normalizeTouches(task.touches);
	const singleRepoTouch = normalizedTouches.find((t) => Boolean(t.repo));
	const repo = task.delivery?.repo || wtLandRecord?.repo || wtDeployRecord?.repo || singleRepoTouch?.repo;
	const deployableService = task.delivery?.deployableService ?? (repo ? DEPLOYABLE_REPOS.has(repo) : false);

	const landId = task.delivery?.landId || wtLandRecord?.id;
	const landStatus = task.delivery?.landStatus || wtLandRecord?.status;
	const landedCommit = task.delivery?.landedCommit || wtLandRecord?.landedSha;
	const deployStatus = task.delivery?.deployStatus || wtDeployRecord?.status;
	const liveCommit = task.delivery?.liveCommit || wtDeployRecord?.healthCommit || wtDeployRecord?.commit;

	const delivery: UiTaskDeliveryState | undefined = repo
		? {
				repo,
				deployableService,
				...(landId ? { landId } : {}),
				...(landStatus ? { landStatus } : {}),
				...(landedCommit ? { landedCommit } : {}),
				...(deployStatus ? { deployStatus } : {}),
				...(liveCommit ? { liveCommit } : {}),
			}
		: undefined;

	const finish = (lifecycleStatus: UiTaskLifecycleStatus, pendingReason?: DeployPendingReason) => {
		if (delivery && pendingReason) {
			delivery.deployPendingReason = pendingReason;
		}
		return {
			lifecycleStatus,
			statusTone: statusToneForLifecycle(lifecycleStatus),
			...(delivery ? { delivery } : {}),
		};
	};

	if (task.status === "dropped") return finish("dropped");
	if (task.paused === true && task.status !== "done") return finish("paused");
	if (task.status === "stuck") return finish("stuck");
	if (task.status === "asking") return finish("asking");
	if (task.status === "blocked") return finish("blocked");

	if (task.status === "waiting") {
		if (landStatus === "queued" || landStatus === "running") return finish("landing");
		if (deployStatus === "deploying") return finish("deploying");
		return finish("waiting");
	}

	if (task.status === "in_progress" || task.status === "working") {
		if (landStatus === "queued" || landStatus === "running") return finish("landing");
		if (deployStatus === "deploying") return finish("deploying");
		return finish("working");
	}

	if (task.status === "queued" || task.status === "ready") {
		return finish(queueRunning ? "queued" : "paused");
	}

	if (task.status === "done") {
		if (!landedCommit || !deployableService) {
			return finish("done");
		}
		const commitIncluded =
			input.isLandedCommitAncestorOfLive ??
			Boolean(liveCommit && (liveCommit.startsWith(landedCommit) || landedCommit.startsWith(liveCommit)));
		if (deployStatus === "deploying" && commitIncluded) {
			return finish("deploying");
		}
		if (deployStatus === "succeeded" && liveCommit && (wtDeployRecord?.healthOk ?? true) && commitIncluded) {
			return finish("live");
		}
		let pendingReason: DeployPendingReason = "not_deployed_yet";
		if (deployStatus === "failed") {
			pendingReason = "last_deploy_failed";
		} else if (deployStatus === "succeeded" && wtDeployRecord?.healthOk === false) {
			pendingReason = "health_unverified";
		} else if (liveCommit && !commitIncluded) {
			pendingReason = "commit_behind";
		}
		return finish("landed", pendingReason);
	}

	return finish("working");
}

/**
 * Computes the deterministic 9-tier group rollup status and statusTone per CONTRACT.md §3.4.
 */
export function computeGroupRollup(
	tasks: ReadonlyArray<{ lifecycleStatus: UiTaskLifecycleStatus } & Partial<Omit<UiRoleTask, "lifecycleStatus">>>,
	groupMeta: { key?: string; kind?: "tag" | "project" | "initiative" } = {},
): UiTaskGroupRollup {
	if (!Array.isArray(tasks)) {
		throw new Error("computeGroupRollup requires an array of tasks.");
	}
	const countsByStatus: Partial<Record<UiTaskLifecycleStatus, number>> = {};
	const rolesSet = new Set<string>();
	const appsSet = new Set<string>();
	let updatedAt = 0;

	for (const t of tasks) {
		const st: UiTaskLifecycleStatus = t.lifecycleStatus;
		countsByStatus[st] = (countsByStatus[st] ?? 0) + 1;
		if (t.role) rolesSet.add(t.role);
		if (t.appOrSystem) appsSet.add(t.appOrSystem);
		if (Array.isArray(t.normalizedTouches)) {
			for (const nt of t.normalizedTouches) {
				if (nt.appOrSystem) appsSet.add(nt.appOrSystem);
			}
		}
		if (typeof t.updatedAt === "number" && t.updatedAt > updatedAt) {
			updatedAt = t.updatedAt;
		}
	}

	const count = (s: UiTaskLifecycleStatus) => countsByStatus[s] ?? 0;
	const activeCount = count("working") + count("landing") + count("deploying");
	const blockedOrWaitingCount = count("blocked") + count("waiting");
	const nonDropped = tasks.filter((t) => t.lifecycleStatus !== "dropped");

	let rollupStatus: UiGroupRollupStatus;
	if (count("stuck") >= 1) {
		rollupStatus = "needs_you";
	} else if (count("asking") >= 1) {
		rollupStatus = "needs_lead";
	} else if (blockedOrWaitingCount >= 1 && activeCount === 0) {
		rollupStatus = "stalled";
	} else if (count("deploying") >= 1) {
		rollupStatus = "deploying";
	} else if (count("landing") >= 1) {
		rollupStatus = "landing";
	} else if (count("working") >= 1) {
		rollupStatus = "working";
	} else if (count("landed") >= 1) {
		rollupStatus = "landed_pending_deploy";
	} else if (count("queued") >= 1) {
		rollupStatus = "queued";
	} else if (nonDropped.length > 0 && nonDropped.every((t) => t.lifecycleStatus === "paused")) {
		rollupStatus = "paused";
	} else if (
		nonDropped.length > 0 &&
		nonDropped.every((t) => t.lifecycleStatus === "live" || t.lifecycleStatus === "done")
	) {
		rollupStatus = count("live") >= 1 ? "live" : "done";
	} else {
		rollupStatus = "dropped";
	}

	const isActiveRollup = rollupStatus === "working" || rollupStatus === "landing" || rollupStatus === "deploying";
	const hasBlockedPeers = isActiveRollup && blockedOrWaitingCount >= 1;
	const statusTone = statusToneForRollup(rollupStatus, countsByStatus);

	const firstUnblock = tasks.find((t) => Boolean(t.howToUnblock))?.howToUnblock;

	return {
		key: groupMeta.key ?? "default",
		kind: groupMeta.kind ?? "tag",
		rollupStatus,
		statusTone,
		...(firstUnblock ? { howToUnblock: firstUnblock } : {}),
		totalTasks: tasks.length,
		countsByStatus,
		hasBlockedPeers,
		roles: [...rolesSet].sort(),
		appsOrSystems: [...appsSet].sort(),
		updatedAt,
	};
}

export interface QueueSnapshotMap {
	[role: string]: {
		queueRunning: boolean;
		tasks: Array<{
			id: number;
			title: string;
			status: string;
			paused?: boolean;
		}>;
	};
}

/**
 * Resolves cross-queue task references for `blocked.on` per CONTRACT.md §4.1–§4.2.
 */
export function resolveBlockedDependencies(params: {
	currentRole: string;
	blocked: {
		on?: string[];
		need?: string;
		lead?: string;
		owes?: string;
		since: number;
		checkpointDueAt?: number;
		remindersSent?: number;
		nextReminderAt?: number;
	};
	now: number;
	queuesSnapshot: QueueSnapshotMap;
}): UiRoleTaskBlocked & { dependsOnRefs: string[] } {
	const { currentRole, blocked, now, queuesSnapshot } = params;
	const rawOn = Array.isArray(blocked.on) ? blocked.on : [];
	const resolvedOn: UiResolvedTaskDep[] = [];
	const dependsOnRefs: string[] = [];

	for (const rawRef of rawOn) {
		const trimmed = rawRef.trim();
		const m = /^(?:([a-z0-9-]+)\s+)?#(\d+)$/i.exec(trimmed);
		const role = m?.[1] ? m[1].toLowerCase() : currentRole;
		const taskId = m?.[2] ? Number(m[2]) : undefined;
		const canonicalRef = taskId !== undefined ? `${role} #${taskId}` : trimmed;
		dependsOnRefs.push(canonicalRef);

		const queueSnap = queuesSnapshot[role];
		const targetTask = taskId !== undefined ? queueSnap?.tasks.find((t) => t.id === taskId) : undefined;

		if (!targetTask) {
			resolvedOn.push({
				ref: canonicalRef,
				role,
				...(taskId !== undefined ? { taskId } : {}),
				satisfied: false,
				deadlockReason: "target_not_found",
			});
			continue;
		}

		const queueStopped = queueSnap ? !queueSnap.queueRunning : false;
		const paused = Boolean(targetTask.paused);
		let lifecycleStatus: UiTaskLifecycleStatus = "working";
		if (targetTask.status === "dropped") lifecycleStatus = "dropped";
		else if (paused) lifecycleStatus = "paused";
		else if (targetTask.status === "stuck") lifecycleStatus = "stuck";
		else if (targetTask.status === "asking") lifecycleStatus = "asking";
		else if (targetTask.status === "blocked") lifecycleStatus = "blocked";
		else if (targetTask.status === "waiting") lifecycleStatus = "waiting";
		else if (targetTask.status === "queued" || targetTask.status === "ready") {
			lifecycleStatus = "queued";
		} else if (targetTask.status === "done") {
			lifecycleStatus = "done";
		} else {
			lifecycleStatus = "working";
		}

		const satisfied = targetTask.status === "done";
		let deadlockReason: TaskDepDeadlockReason | undefined;
		if (!satisfied) {
			if (targetTask.status === "dropped") deadlockReason = "target_dropped";
			else if (paused) deadlockReason = "target_paused";
			else if (queueStopped) deadlockReason = "queue_stopped";
			else if (targetTask.status === "stuck" || targetTask.status === "asking") {
				deadlockReason = "target_stuck";
			}
		}

		resolvedOn.push({
			ref: canonicalRef,
			role,
			...(taskId !== undefined ? { taskId } : {}),
			title: targetTask.title,
			lifecycleStatus,
			satisfied,
			paused,
			queueStopped,
			...(deadlockReason ? { deadlockReason } : {}),
		});
	}

	const unsatisfiedCount = resolvedOn.filter((d) => !d.satisfied).length;
	const checkpointOverdue = typeof blocked.checkpointDueAt === "number" ? now >= blocked.checkpointDueAt : false;

	const actionParts: string[] = [];
	for (const dep of resolvedOn) {
		if (dep.deadlockReason === "queue_stopped" && dep.role) {
			actionParts.push(`Resume ${dep.role}'s queue so ${dep.ref} can run`);
		} else if (dep.deadlockReason === "target_paused") {
			actionParts.push(`Resume paused ${dep.ref}`);
		}
	}
	if (blocked.lead && blocked.owes) {
		actionParts.push(`have ${blocked.lead} lead provide ${blocked.owes}`);
	} else if (blocked.need) {
		actionParts.push(`provide ${blocked.need}`);
	}
	const howToUnblock =
		actionParts.length > 0
			? `How to unblock: ${actionParts.join(", and ")}`
			: `How to unblock: Wait for ${dependsOnRefs.join(", ")} to complete`;

	const summaryParts = resolvedOn.map((d) => {
		if (d.deadlockReason === "queue_stopped") return `${d.ref} (${d.lifecycleStatus} — queue stopped)`;
		if (d.deadlockReason === "target_not_found") return `${d.ref} (not found)`;
		return `${d.ref} (${d.lifecycleStatus ?? "pending"})`;
	});
	if (blocked.lead && blocked.owes) {
		summaryParts.push(`${blocked.lead} lead: ${blocked.owes}`);
	}
	const unblockSummary = `Waiting on ${summaryParts.join(", ")}`;

	return {
		on: rawOn,
		resolvedOn,
		unsatisfiedCount,
		...(blocked.need ? { need: blocked.need } : {}),
		...(blocked.lead ? { lead: blocked.lead } : {}),
		...(blocked.owes ? { owes: blocked.owes } : {}),
		sinceAt: blocked.since,
		...(blocked.checkpointDueAt !== undefined ? { checkpointDueAt: blocked.checkpointDueAt } : {}),
		checkpointOverdue,
		...(blocked.remindersSent !== undefined ? { remindersSent: blocked.remindersSent } : {}),
		...(blocked.nextReminderAt !== undefined ? { nextReminderAt: blocked.nextReminderAt } : {}),
		unblockSummary,
		howToUnblock,
		dependsOnRefs,
	};
}

/**
 * Backward-compatible derivation of a v8 `UiRoleTask` from an existing `server/protocol.ts`
 * `UiRoleTask` when optional v8 server fields are absent (before backend #120 lands).
 */
export function deriveV8TaskFromLegacyTask(
	legacy: LegacyUiRoleTask & Partial<Omit<UiRoleTask, "paused">>,
	roleOverview?: Partial<Pick<UiRoleOverview, "id" | "title" | "queue" | "asks">>,
): UiRoleTask {
	const role = legacy.role ?? roleOverview?.id ?? "workspace";
	const roleTitle = legacy.roleTitle ?? roleOverview?.title ?? role;
	const queueRunning = roleOverview?.queue?.running ?? true;

	let lifecycleStatus: UiTaskLifecycleStatus = legacy.lifecycleStatus ?? "working";
	if (!legacy.lifecycleStatus) {
		if (legacy.status === "dropped") lifecycleStatus = "dropped";
		else if (legacy.paused) lifecycleStatus = "paused";
		else if (legacy.status === "stuck") lifecycleStatus = "stuck";
		else if (legacy.status === "asking") lifecycleStatus = "asking";
		else if (legacy.status === "blocked") lifecycleStatus = "blocked";
		else if (legacy.status === "waiting") lifecycleStatus = "waiting";
		else if (legacy.status === "ready") lifecycleStatus = queueRunning ? "queued" : "paused";
		else if (legacy.status === "done") {
			const ev = legacy.evidence;
			if (ev && "at" in ev.live) lifecycleStatus = "live";
			else if (ev && "at" in ev.checked) lifecycleStatus = "landed";
			else lifecycleStatus = "done";
		} else {
			lifecycleStatus = "working";
		}
	}

	const statusTone = legacy.statusTone ?? statusToneForLifecycle(lifecycleStatus);
	const normalizedTouches = legacy.normalizedTouches ?? (legacy.touches ? normalizeTouches(legacy.touches) : []);
	const appOrSystem = legacy.appOrSystem ?? normalizedTouches[0]?.appOrSystem ?? legacy.evidence?.repo ?? "pi-web-ui";
	const appLabel = legacy.appLabel ?? appOrSystem;
	const parentProject = legacy.parent && "project" in legacy.parent ? legacy.parent.project : undefined;
	const parentInitiative = legacy.parent && "initiative" in legacy.parent ? legacy.parent.initiative : undefined;
	const tags =
		legacy.tags && legacy.tags.length > 0
			? legacy.tags
			: parentProject
				? [parentProject]
				: parentInitiative
					? [parentInitiative]
					: ["general"];

	const latestTldr =
		legacy.latestTldr ??
		(legacy.progress
			? { text: legacy.progress.text, at: legacy.progress.at, age: "just now" }
			: legacy.latest
				? { text: legacy.latest.text, at: legacy.latest.ts, age: "just now" }
				: undefined);

	const nextSummary: string | undefined =
		legacy.next && "what" in legacy.next && typeof legacy.next.what === "string"
			? legacy.next.what
			: legacy.next && "need" in legacy.next && typeof legacy.next.need === "string"
				? legacy.next.need
				: undefined;
	const howToUnblock: string | undefined =
		typeof legacy.howToUnblock === "string"
			? legacy.howToUnblock
			: (nextSummary ?? (legacy.waitsOn ? `Resolve: ${legacy.waitsOn}` : undefined));

	const { paused: rawPaused, ...restLegacy } = legacy;
	const displayId = legacy.displayId ?? legacy.id;
	const taskKey = legacy.taskKey ?? `${role}:${displayId}`;
	const parsedUpdatedAtMs = parseTimestampMs(
		(legacy as { updatedAtMs?: unknown }).updatedAtMs ?? (legacy as { updatedAt?: unknown }).updatedAt,
	);
	return {
		...restLegacy,
		id: legacy.id,
		displayId,
		taskKey,
		role,
		roleTitle,
		title: legacy.title,
		status: legacy.status,
		lifecycleStatus,
		statusTone,
		paused: Boolean(rawPaused),
		appOrSystem,
		appLabel,
		tags,
		normalizedTouches,
		...(howToUnblock ? { howToUnblock } : {}),
		...(latestTldr ? { latestTldr } : {}),
		dependsOnRefs: legacy.dependsOnRefs ?? [],
		createdAt: legacy.createdAt ?? 0,
		updatedAt: parsedUpdatedAtMs ?? legacy.updatedAt ?? 0,
		...(parsedUpdatedAtMs !== undefined ? { updatedAtMs: parsedUpdatedAtMs } : {}),
	};
}

/**
 * Converts a live `UiRolesOverview` payload into a `TasksRolesV8Dataset` when optional v8 fields are absent.
 */
export function deriveV8DatasetFromRolesOverview(overview: {
	roles: ReadonlyArray<Pick<UiRoleOverview, "id" | "title"> & Partial<UiRoleOverview>>;
}): TasksRolesV8Dataset {
	const departments: V8DepartmentSummary[] = [];
	const idleDepartments: Array<{ id: string; title: string; note: string }> = [];
	const tasks: UiRoleTask[] = [];

	for (const role of overview.roles) {
		const active = role.queue?.active ?? [];
		const queued = role.queue?.queued ?? [];
		const roleTasks = [...active, ...queued];
		if (roleTasks.length > 0) {
			departments.push({
				id: role.id,
				title: role.title,
				inUse: role.queue?.lanes?.inUse ?? active.length,
				atOnce: role.queue?.lanes?.atOnce ?? 2,
				queueRunning: role.queue?.running ?? true,
				homeChat: role.homeChat,
			});
			for (const t of roleTasks) {
				tasks.push(deriveV8TaskFromLegacyTask(t, role));
			}
		} else {
			idleDepartments.push({
				id: role.id,
				title: role.title,
				note: "0 active tasks · All clear",
			});
		}
	}

	const byTag = new Map<string, UiRoleTask[]>();
	for (const task of tasks) {
		const tg = task.tags?.[0] ?? "general";
		const list = byTag.get(tg) ?? [];
		list.push(task);
		byTag.set(tg, list);
	}

	const askGroups: UiTaskGroupRollup[] = [];
	for (const [tag, groupTasks] of byTag.entries()) {
		const rollup = computeGroupRollup(groupTasks, { key: `tag:${tag}`, kind: "tag" });
		const first = groupTasks[0];
		askGroups.push({
			...rollup,
			title: `#${tag}`,
			appOrSystem: first?.appOrSystem ?? "pi-web-ui",
			appLabel: first?.appLabel ?? "Pi Web UI",
			tags: [tag],
			howToUnblock: rollup.howToUnblock ?? "In progress across department queues.",
			handoff: rollup.roles.map((r) => {
				const rt = groupTasks.find((t) => t.role === r);
				return {
					role: r,
					roleTitle: rt?.roleTitle ?? r,
					status: rt?.lifecycleStatus ?? "working",
					summary: `#${rt?.displayId ?? rt?.id ?? 0}`,
				};
			}),
			tasks: groupTasks,
		});
	}

	const appCounts = new Map<string, number>();
	for (const t of tasks) {
		const app = t.appOrSystem ?? "pi-web-ui";
		appCounts.set(app, (appCounts.get(app) ?? 0) + 1);
	}
	const touchSystems = [
		{ id: "all", label: "All apps", count: tasks.length },
		...[...appCounts.entries()].map(([id, count]) => ({ id, label: id, count })),
	];
	const allTags: V8TagOption[] = [...byTag.entries()].map(([id, groupTasks]) => ({
		id,
		label: `#${id}`,
		touches: [...new Set(groupTasks.map((t) => t.appOrSystem ?? "pi-web-ui"))],
	}));

	return {
		askGroups,
		tasks,
		departments,
		idleDepartments,
		touchSystems,
		allTags,
	};
}
