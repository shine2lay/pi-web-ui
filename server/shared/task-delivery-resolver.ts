/**
 * Deterministic 12-state task lifecycle & delivery resolver, 9-tier group roll-up,
 * and App/System touch index for the Roles & Initiatives rework (CONTRACT.md Areas 3 & 4).
 *
 * Pure deterministic resolution with dependency-injected snapshots for unit/conformance
 * tests and mtime-cached state + async git ancestry memoization for live server calls
 * (0 synchronous subprocesses on the render path).
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
	DeployPendingReason,
	UiGroupRollupStatus,
	UiNormalizedTouch,
	UiStatusTone,
	UiTaskDeliveryState,
	UiTaskGroupRollup,
	UiTaskLifecycleStatus,
	UiTouchSystemSummary,
} from "../protocol.js";
import { normalizeTouches } from "./touch-normalizer.js";

/** Repositories that have a live runtime service deploy target. */
export const DEPLOYABLE_SERVICE_REPOS: ReadonlySet<string> = new Set([
	"pi-web-ui",
	"rollcall",
	"inkflow",
	"temper-ai",
	"show-and-tell",
]);

/** Canonical local repository paths for background git merge-base ancestry checks. */
const REPO_ROOT_BY_SLUG: Readonly<Record<string, string>> = {
	"pi-web-ui": "/home/shinelay/projects/pi-web-ui",
	rollcall: "/home/shinelay/rollcall",
	inkflow: "/home/shinelay/projects/inkflow",
	"temper-ai": "/home/shinelay/temper-ai",
	"show-and-tell": "/home/shinelay/projects/show-and-tell",
	"agent-tools": "/home/shinelay/projects/agent-tools",
};

/** All 13 UiTaskLifecycleStatus keys initialized to 0 in countsByStatus. */
export const ALL_LIFECYCLE_STATUSES: readonly UiTaskLifecycleStatus[] = [
	"paused",
	"stuck",
	"asking",
	"blocked",
	"waiting",
	"queued",
	"working",
	"landing",
	"landed",
	"deploying",
	"live",
	"done",
	"dropped",
];

/** Priority order for sorting UiTaskGroupRollup entries (lowest number = highest severity). */
export const GROUP_ROLLUP_PRIORITY: Readonly<Record<UiGroupRollupStatus, number>> = {
	needs_you: 1,
	needs_lead: 2,
	stalled: 3,
	deploying: 4,
	landing: 5,
	working: 6,
	landed_pending_deploy: 7,
	queued: 8,
	paused: 9,
	live: 10,
	done: 11,
	dropped: 12,
};

export interface WtLandRecordInput {
	id: string;
	repo?: string;
	branch?: string;
	taskRef?: string;
	status?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | string;
	headSha?: string;
	landedSha?: string | null;
	finishedAt?: number | string | null;
	detail?: string | null;
	error?: string | null;
}

export interface WtDeployRecordInput {
	repo?: string;
	targetBranch?: string;
	status?: "deploying" | "running" | "succeeded" | "failed" | "rolled_back" | string;
	commit?: string;
	targetCommit?: string;
	liveCommit?: string;
	healthOk?: boolean;
	healthCommit?: string;
	finishedAt?: number | string | null;
	error?: string | null;
}

export type AncestorChecker = (repo: string, landedCommit: string, targetOrLiveCommit: string) => boolean;

export interface DeployStateSnapshots {
	wtLandRecords?: ReadonlyMap<string, WtLandRecordInput> | ReadonlyArray<WtLandRecordInput>;
	wtDeployRecords?: ReadonlyMap<string, WtDeployRecordInput> | Readonly<Record<string, WtDeployRecordInput>>;
	piWebDeployRecord?: WtDeployRecordInput | null;
}

export interface ResolveTaskLifecycleOptions extends DeployStateSnapshots {
	/** Direct single wt-land record override (for unit/conformance fixtures). */
	wtLandRecord?: WtLandRecordInput | null;
	/** Direct single wt-deploy record override (for unit/conformance fixtures). */
	wtDeployRecord?: WtDeployRecordInput | null;
	/** Boolean or callback override for commit ancestry (for unit/conformance fixtures). */
	isLandedCommitAncestorOfLive?: boolean | AncestorChecker;
	/** Callback override for commit ancestry. */
	isCommitAncestor?: AncestorChecker;
	/** Alias for commit ancestry check in unit/conformance fixtures. */
	isAncestor?: boolean | AncestorChecker;
	/** Role id owning the task's queue. */
	role?: string;
	/** Whether the role's queue is currently running (default true). */
	queueRunning?: boolean;
	/** Whether the role's queue is explicitly paused by the owner. */
	queuePaused?: boolean;
	/** Whether the task's wait check is currently overdue. */
	waitOverdue?: boolean;
	/** Whether a queued task has an upstream deadlock in its `after` chain or stopped queue. */
	hasUpstreamDeadlock?: boolean;
	/** Fallback evidence from server/roles-evidence.ts when available. */
	evidence?: {
		repo?: string;
		commit?: string;
		checkedAt?: number;
		installedAt?: number;
		live?: boolean;
	};
}

export interface TaskDeliveryInput {
	id: number;
	role?: string;
	status: string;
	paused?: unknown;
	touches?: readonly string[];
	normalizedTouches?: readonly UiNormalizedTouch[];
	doneSummary?: string;
	summary?: string;
	delivery?: {
		repo?: string;
		landId?: string;
		landedCommit?: string;
	};
	wait?: {
		what?: string;
		check?: string;
		checkCmd?: string;
		since?: number;
		sinceAt?: number;
		overdue?: boolean;
	};
}

export interface RollupTaskInput {
	id?: number;
	role?: string;
	status?: string;
	lifecycleStatus?: UiTaskLifecycleStatus;
	statusTone?: UiStatusTone;
	howToUnblock?: string;
	rootBlockerRef?: string;
	tags?: readonly string[];
	touches?: readonly string[];
	normalizedTouches?: readonly UiNormalizedTouch[];
	updatedAt?: number;
	finishedAt?: number;
	startedAt?: number;
	createdAt?: number;
	blocked?: {
		howToUnblock?: string;
		resolvedOn?: ReadonlyArray<{ ref: string; satisfied: boolean; deadlockReason?: string }>;
	};
	wait?: {
		howToUnblock?: string;
	};
}

/** Normalizes a repository name or filesystem path to its canonical repo slug. */
export function normalizeRepoSlug(raw: string | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const base = trimmed.includes("/") ? path.basename(trimmed) : trimmed;
	const lower = base.toLowerCase();
	if (lower === "temper") return "temper-ai";
	if (lower === "showtell") return "show-and-tell";
	return lower;
}

export function isDeployableServiceRepo(repo: string | undefined, hasDeployRecord: boolean = false): boolean {
	if (!repo) return false;
	return Boolean(hasDeployRecord);
}

const LAND_ID_TOKEN_RE = /\b(?:land-\d+-[0-9a-f]+|\d+-[0-9a-f]{6,})\b/gi;
const WT_LAND_STATUS_CMD_RE = /\bwt\s+land-status\s+(?:--json\s+)?([a-z0-9-]+)\b/gi;
const PI_WEB_DEPLOY_RESULT_RE = /\bpi-web-deploy\s+result\s+([0-9a-f]{7,40})\b/i;
const SUMMARY_COMMIT_RE = /\b(?:landed|commit|sha)\s+([0-9a-f]{7,40})\b/i;
const HEX_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Extracts candidate wt-land-queue job IDs from wait check, wait description, or done summary. */
export function extractLandIdsFromText(text: string | undefined): string[] {
	if (typeof text !== "string" || !text) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const match of text.matchAll(WT_LAND_STATUS_CMD_RE)) {
		const id = match[1]?.trim();
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	for (const match of text.matchAll(LAND_ID_TOKEN_RE)) {
		const id = match[0]?.trim();
		if (id && !seen.has(id)) {
			seen.add(id);
			out.push(id);
		}
	}
	return out;
}

/** Extracts `pi-web-deploy result <sha>` from a wait check string. */
export function extractCommitFromDeployWaitCheck(
	check: string | undefined,
): { repo: string; landedCommit: string } | undefined {
	if (typeof check !== "string" || !check) return undefined;
	const m = PI_WEB_DEPLOY_RESULT_RE.exec(check);
	if (!m) return undefined;
	return { repo: "pi-web-ui", landedCommit: m[1].toLowerCase() };
}

/** Extracts an explicit landed commit SHA from a task's done summary. */
export function extractCommitFromSummary(summary: string | undefined): string | undefined {
	if (typeof summary !== "string" || !summary) return undefined;
	const m = SUMMARY_COMMIT_RE.exec(summary);
	return m ? m[1].toLowerCase() : undefined;
}

function parseTimestampMs(raw: number | string | null | undefined): number | undefined {
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
	if (typeof raw === "string" && raw.trim()) {
		const parsed = Date.parse(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Asynchronous Git Ancestry Memoization Cache (0 sync subprocesses on render)
// ---------------------------------------------------------------------------

const ancestryCache = new Map<string, boolean>();
const pendingAncestryChecks = new Map<string, Promise<void>>();

function scheduleAsyncAncestorCheck(
	repo: string,
	landedCommit: string,
	liveCommit: string,
	repoRoots?: Readonly<Record<string, string>>,
): Promise<void> {
	const landed = landedCommit.trim().toLowerCase();
	const live = liveCommit.trim().toLowerCase();
	if (!landed || !live || live.startsWith(landed) || landed.startsWith(live)) {
		return Promise.resolve();
	}
	const key = `${repo}:${landed}:${live}`;
	if (ancestryCache.has(key)) return Promise.resolve();
	const existing = pendingAncestryChecks.get(key);
	if (existing) return existing;
	const repoRoot = repoRoots?.[repo] ?? REPO_ROOT_BY_SLUG[repo];
	if (!repoRoot) return Promise.resolve();
	const promise = new Promise<void>((resolve) => {
		execFile("git", ["-C", repoRoot, "merge-base", "--is-ancestor", landed, live], { timeout: 3_000 }, (err) => {
			pendingAncestryChecks.delete(key);
			// git merge-base --is-ancestor exits 0 when true, 1 when false, >1 on error/missing commit
			if (!err) {
				ancestryCache.set(key, true);
			} else if (typeof (err as { code?: unknown }).code === "number" && (err as { code?: number }).code === 1) {
				ancestryCache.set(key, false);
			}
			resolve();
		});
	});
	pendingAncestryChecks.set(key, promise);
	return promise;
}

/**
 * Checks whether `landedCommit` is equal to or an ancestor of `targetOrLiveCommit`.
 * - Fast path: prefix match (`a.startsWith(b) || b.startsWith(a)`) -> true with 0 subprocesses.
 * - Injected boolean or callback: used deterministically in unit/conformance tests.
 * - Live runtime: reads from `ancestryCache` and triggers background async population on cache miss.
 */
export function checkCommitAncestor(
	repo: string,
	landedCommit: string,
	targetOrLiveCommit: string,
	customChecker?: boolean | AncestorChecker,
	allowLiveAsync: boolean = false,
): boolean {
	const landed = landedCommit.trim().toLowerCase();
	const live = targetOrLiveCommit.trim().toLowerCase();
	if (!landed || !live) return false;
	if (typeof customChecker === "boolean") return customChecker;
	if (typeof customChecker === "function") return customChecker(repo, landed, live);
	if (live.startsWith(landed) || landed.startsWith(live)) return true;
	const key = `${repo}:${landed}:${live}`;
	const cached = ancestryCache.get(key);
	if (cached !== undefined) return cached;
	if (allowLiveAsync) {
		scheduleAsyncAncestorCheck(repo, landed, live);
	}
	return false;
}

/** Exposes cache seeding for tests. */
export function setCachedCommitAncestry(
	repo: string,
	landedCommit: string,
	liveCommit: string,
	isAncestor: boolean,
): void {
	ancestryCache.set(`${repo}:${landedCommit.toLowerCase()}:${liveCommit.toLowerCase()}`, isAncestor);
}

// ---------------------------------------------------------------------------
// Task-to-Land and Task-to-Deploy Binding
// ---------------------------------------------------------------------------

function findMatchingLandRecord(
	task: TaskDeliveryInput,
	role: string | undefined,
	options: ResolveTaskLifecycleOptions | undefined,
): WtLandRecordInput | undefined {
	if (options?.wtLandRecord) return options.wtLandRecord;
	const records = options?.wtLandRecords;
	if (!records) return undefined;

	const list: WtLandRecordInput[] = Array.isArray(records)
		? records
		: Array.from((records as ReadonlyMap<string, WtLandRecordInput>).values());
	if (list.length === 0) return undefined;

	const byId = new Map<string, WtLandRecordInput>();
	for (const rec of list) {
		if (rec && typeof rec.id === "string") {
			byId.set(rec.id, rec);
		}
	}

	// 1. Explicit task.delivery.landId
	const explicitLandId = task.delivery?.landId?.trim();
	if (explicitLandId && byId.has(explicitLandId)) {
		return byId.get(explicitLandId);
	}

	// 2. record.taskRef === "${role} #${task.id}"
	const effectiveRole = (role ?? task.role)?.trim().toLowerCase();
	if (effectiveRole && Number.isInteger(task.id)) {
		const expectedRef = `${effectiveRole} #${task.id}`;
		const matchedByRef = list.find(
			(r) => typeof r.taskRef === "string" && r.taskRef.trim().toLowerCase() === expectedRef,
		);
		if (matchedByRef) return matchedByRef;
	}

	// 3. Land id token in wait.check, wait.what, or doneSummary/summary
	const candidateTexts = [task.wait?.check, task.wait?.checkCmd, task.wait?.what, task.doneSummary, task.summary];
	for (const text of candidateTexts) {
		for (const candidateId of extractLandIdsFromText(text)) {
			const hit = byId.get(candidateId);
			if (hit) return hit;
		}
	}

	return undefined;
}

function findMatchingDeployRecord(
	repo: string | undefined,
	options: ResolveTaskLifecycleOptions | undefined,
): WtDeployRecordInput | undefined {
	if (!repo) return undefined;
	if (options?.wtDeployRecord !== undefined) {
		return options.wtDeployRecord ?? undefined;
	}
	if (repo === "pi-web-ui" && options?.piWebDeployRecord) {
		return options.piWebDeployRecord;
	}
	const records = options?.wtDeployRecords;
	if (!records) return undefined;
	if (records instanceof Map || typeof (records as ReadonlyMap<string, WtDeployRecordInput>).get === "function") {
		return (records as ReadonlyMap<string, WtDeployRecordInput>).get(repo);
	}
	return (records as Readonly<Record<string, WtDeployRecordInput>>)[repo];
}

function normalizeLandStatus(
	status: string | undefined,
): "queued" | "running" | "succeeded" | "failed" | "cancelled" | undefined {
	if (
		status === "queued" ||
		status === "running" ||
		status === "succeeded" ||
		status === "failed" ||
		status === "cancelled"
	) {
		return status;
	}
	return undefined;
}

function normalizeDeployStatus(
	status: string | undefined,
): "deploying" | "succeeded" | "failed" | "rolled_back" | undefined {
	if (status === "deploying" || status === "running") return "deploying";
	if (status === "succeeded" || status === "ok" || status === "live") return "succeeded";
	if (status === "failed" || status === "error") return "failed";
	if (status === "rolled_back" || status === "undone") return "rolled_back";
	return undefined;
}

/**
 * Resolves `UiTaskDeliveryState` for a task from:
 * 1. `task.delivery` (`repo`, `landId`, `landedCommit`)
 * 2. Matched `wt-land-queue` record
 * 3. Deterministic summary / wait-check + single normalized-touch `repo` fallback
 * 4. Joined `wt-deploy` / `pi-web-deploy` state
 */
export function resolveTaskDeliveryState(
	task: TaskDeliveryInput,
	options?: ResolveTaskLifecycleOptions,
): UiTaskDeliveryState | undefined {
	const normalizedTouches = task.normalizedTouches ?? normalizeTouches(task.touches);
	const touchedRepos = Array.from(
		new Set(normalizedTouches.map((t) => t.repo).filter((r): r is string => typeof r === "string" && r.length > 0)),
	);
	const singleTouchedRepo = touchedRepos.length === 1 ? touchedRepos[0] : undefined;

	const landRecord = findMatchingLandRecord(task, options?.role ?? task.role, options);

	const waitCheck = task.wait?.check ?? task.wait?.checkCmd;
	const waitDeployCommit = extractCommitFromDeployWaitCheck(waitCheck);
	const waitLandIds = extractLandIdsFromText(waitCheck ?? task.wait?.what);
	const summaryText = task.doneSummary ?? task.summary;
	const summaryCommit = extractCommitFromSummary(summaryText);

	let repo =
		normalizeRepoSlug(task.delivery?.repo) ??
		normalizeRepoSlug(landRecord?.repo) ??
		waitDeployCommit?.repo ??
		normalizeRepoSlug(options?.evidence?.repo);

	let landId = task.delivery?.landId?.trim() || landRecord?.id || waitLandIds[0];

	let landedCommit =
		(task.delivery?.landedCommit && HEX_SHA_RE.test(task.delivery.landedCommit)
			? task.delivery.landedCommit.toLowerCase()
			: undefined) ??
		(landRecord?.landedSha && HEX_SHA_RE.test(landRecord.landedSha)
			? landRecord.landedSha.toLowerCase()
			: landRecord?.status === "succeeded" && landRecord.headSha && HEX_SHA_RE.test(landRecord.headSha)
				? landRecord.headSha.toLowerCase()
				: undefined) ??
		waitDeployCommit?.landedCommit ??
		(options?.evidence?.commit && HEX_SHA_RE.test(options.evidence.commit)
			? options.evidence.commit.toLowerCase()
			: undefined);

	if (!landedCommit && summaryCommit && (repo || singleTouchedRepo)) {
		landedCommit = summaryCommit;
		repo ??= singleTouchedRepo;
	}

	if (!repo && (landId || landedCommit) && singleTouchedRepo) {
		repo = singleTouchedRepo;
	}

	if (!repo && !landId && !landedCommit && !options?.evidence?.live) {
		return undefined;
	}

	const resolvedRepo = repo ?? singleTouchedRepo ?? (options?.evidence?.live ? "pi-web-ui" : "workspace");
	const deployRecord = findMatchingDeployRecord(resolvedRepo, options);
	const deployableService = isDeployableServiceRepo(
		resolvedRepo,
		Boolean(deployRecord) || Boolean(options?.evidence?.live) || Boolean(waitDeployCommit),
	);
	const landStatus = normalizeLandStatus(landRecord?.status);
	const landedAt = parseTimestampMs(landRecord?.finishedAt) ?? options?.evidence?.checkedAt;

	let deployStatus = normalizeDeployStatus(deployRecord?.status);
	const liveCommitRaw = deployRecord?.healthCommit ?? deployRecord?.liveCommit ?? deployRecord?.commit;
	let liveCommit =
		typeof liveCommitRaw === "string" && HEX_SHA_RE.test(liveCommitRaw.trim())
			? liveCommitRaw.trim().toLowerCase()
			: undefined;
	let deployedAt = parseTimestampMs(deployRecord?.finishedAt) ?? options?.evidence?.installedAt;
	if (options?.evidence?.live === true) {
		deployStatus = deployStatus ?? "succeeded";
		liveCommit = liveCommit ?? landedCommit;
		deployedAt = deployedAt ?? options.evidence.installedAt;
	}
	const error =
		(typeof deployRecord?.error === "string" && deployRecord.error.trim()) ||
		(landStatus === "failed" && typeof landRecord?.detail === "string" && landRecord.detail.trim()) ||
		(landStatus === "failed" && typeof landRecord?.error === "string" && landRecord.error.trim()) ||
		undefined;

	return {
		repo: resolvedRepo,
		deployableService,
		...(landId ? { landId } : {}),
		...(landStatus ? { landStatus } : {}),
		...(landedCommit ? { landedCommit } : {}),
		...(landedAt !== undefined ? { landedAt } : {}),
		...(deployStatus ? { deployStatus } : {}),
		...(liveCommit ? { liveCommit } : {}),
		...(deployedAt !== undefined ? { deployedAt } : {}),
		...(error ? { error } : {}),
	};
}

/** Maps a resolved `UiTaskLifecycleStatus` to its semantic `UiStatusTone`. */
export function statusToneForLifecycle(
	lifecycleStatus: UiTaskLifecycleStatus,
	opts?: { waitOverdue?: boolean; hasUpstreamDeadlock?: boolean },
): UiStatusTone {
	switch (lifecycleStatus) {
		case "paused":
			return "paused";
		case "stuck":
			return "needs_you";
		case "asking":
			return "needs_lead";
		case "blocked":
			return "blocked";
		case "waiting":
			return opts?.waitOverdue ? "needs_lead" : "waiting";
		case "queued":
			return opts?.hasUpstreamDeadlock ? "blocked" : "queued";
		case "working":
		case "landing":
			return "working";
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

/**
 * Resolves a task's 12-state `lifecycleStatus`, semantic `statusTone`, and `delivery` state.
 */
export function resolveTaskLifecycleAndDelivery(
	task: TaskDeliveryInput,
	options?: ResolveTaskLifecycleOptions,
): {
	lifecycleStatus: UiTaskLifecycleStatus;
	statusTone: UiStatusTone;
	delivery?: UiTaskDeliveryState;
} {
	const delivery = resolveTaskDeliveryState(task, options);
	const rawStatus = task.status;
	const isTaskPaused = Boolean(task.paused) || Boolean(options?.queuePaused) || rawStatus === "paused";
	const waitOverdue = options?.waitOverdue ?? Boolean(task.wait?.overdue);
	const hasUpstreamDeadlock = Boolean(options?.hasUpstreamDeadlock);

	// 1. Dropped
	if (rawStatus === "dropped") {
		return {
			lifecycleStatus: "dropped",
			statusTone: "dropped",
			...(delivery ? { delivery } : {}),
		};
	}

	// 2. Explicitly paused (task or queue hold while not terminal)
	if (isTaskPaused && rawStatus !== "done") {
		return {
			lifecycleStatus: "paused",
			statusTone: "paused",
			...(delivery ? { delivery } : {}),
		};
	}

	// 3. Stuck (Owner tier)
	if (rawStatus === "stuck") {
		return {
			lifecycleStatus: "stuck",
			statusTone: "needs_you",
			...(delivery ? { delivery } : {}),
		};
	}

	// 4. Asking (Lead / COO tier)
	if (rawStatus === "asking") {
		return {
			lifecycleStatus: "asking",
			statusTone: "needs_lead",
			...(delivery ? { delivery } : {}),
		};
	}

	// 5. Blocked
	if (rawStatus === "blocked") {
		return {
			lifecycleStatus: "blocked",
			statusTone: "blocked",
			...(delivery ? { delivery } : {}),
		};
	}

	// 6. Waiting
	if (rawStatus === "waiting") {
		if (delivery?.landStatus === "queued" || delivery?.landStatus === "running") {
			return {
				lifecycleStatus: "landing",
				statusTone: "working",
				delivery,
			};
		}
		if (delivery?.deployStatus === "deploying") {
			return {
				lifecycleStatus: "deploying",
				statusTone: "deploying",
				delivery,
			};
		}
		return {
			lifecycleStatus: "waiting",
			statusTone: statusToneForLifecycle("waiting", { waitOverdue }),
			...(delivery ? { delivery } : {}),
		};
	}

	// 7. Working / in_progress
	if (rawStatus === "in_progress" || rawStatus === "working") {
		if (delivery?.landStatus === "queued" || delivery?.landStatus === "running") {
			return {
				lifecycleStatus: "landing",
				statusTone: "working",
				delivery,
			};
		}
		if (delivery?.deployStatus === "deploying") {
			return {
				lifecycleStatus: "deploying",
				statusTone: "deploying",
				delivery,
			};
		}
		return {
			lifecycleStatus: "working",
			statusTone: "working",
			...(delivery ? { delivery } : {}),
		};
	}

	// 8. Queued / ready
	if (rawStatus === "queued" || rawStatus === "ready") {
		return {
			lifecycleStatus: "queued",
			statusTone: statusToneForLifecycle("queued", { hasUpstreamDeadlock }),
			...(delivery ? { delivery } : {}),
		};
	}

	// 9. Done
	if (rawStatus === "done") {
		if (options?.evidence?.live === true) {
			return {
				lifecycleStatus: "live",
				statusTone: "live",
				...(delivery
					? {
							delivery: {
								...delivery,
								deployStatus: "succeeded",
								...(options.evidence.installedAt !== undefined && delivery.deployedAt === undefined
									? { deployedAt: options.evidence.installedAt }
									: {}),
							},
						}
					: {}),
			};
		}

		if (!delivery?.landedCommit || !delivery.deployableService) {
			return {
				lifecycleStatus: "done",
				statusTone: "live",
				...(delivery ? { delivery } : {}),
			};
		}

		const deployRecord = findMatchingDeployRecord(delivery.repo, options);
		const customChecker = options?.isLandedCommitAncestorOfLive ?? options?.isCommitAncestor ?? options?.isAncestor;
		const allowLiveAsync = customChecker === undefined;
		const targetDeployCommit = deployRecord?.targetCommit ?? deployRecord?.commit ?? delivery.liveCommit;

		if (
			delivery.deployStatus === "deploying" &&
			(!targetDeployCommit ||
				checkCommitAncestor(delivery.repo, delivery.landedCommit, targetDeployCommit, customChecker, allowLiveAsync))
		) {
			return {
				lifecycleStatus: "deploying",
				statusTone: "deploying",
				delivery,
			};
		}

		if (delivery.deployStatus === "succeeded") {
			if (deployRecord?.healthOk === false || !delivery.liveCommit) {
				const enriched: UiTaskDeliveryState = {
					...delivery,
					deployPendingReason: "health_unverified",
				};
				return {
					lifecycleStatus: "landed",
					statusTone: "landed",
					delivery: enriched,
				};
			}
			const isAncestor =
				checkCommitAncestor(delivery.repo, delivery.landedCommit, delivery.liveCommit, customChecker, allowLiveAsync) ||
				Boolean(options?.evidence?.live);
			if (isAncestor) {
				return {
					lifecycleStatus: "live",
					statusTone: "live",
					delivery,
				};
			}
			const enriched: UiTaskDeliveryState = {
				...delivery,
				deployPendingReason: "commit_behind",
			};
			return {
				lifecycleStatus: "landed",
				statusTone: "landed",
				delivery: enriched,
			};
		}

		let deployPendingReason: DeployPendingReason = "not_deployed_yet";
		if (delivery.deployStatus === "failed" || delivery.deployStatus === "rolled_back") {
			deployPendingReason = "last_deploy_failed";
		} else if (delivery.liveCommit) {
			deployPendingReason = "commit_behind";
		}

		const enriched: UiTaskDeliveryState = {
			...delivery,
			deployPendingReason,
		};
		return {
			lifecycleStatus: "landed",
			statusTone: "landed",
			delivery: enriched,
		};
	}

	return {
		lifecycleStatus: "queued",
		statusTone: "queued",
		...(delivery ? { delivery } : {}),
	};
}

// ---------------------------------------------------------------------------
// 9-Tier Multi-Task Group Roll-Up (computeGroupRollup)
// ---------------------------------------------------------------------------

function normalizeRollupArgs(
	arg1: string | ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus>,
	arg2?: "tag" | "project" | "initiative" | string,
	arg3?: ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus> | "tag" | "project" | "initiative",
): {
	key: string;
	kind: "tag" | "project" | "initiative";
	items: ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus>;
} {
	if (Array.isArray(arg1)) {
		const key = typeof arg2 === "string" ? arg2 : "group";
		const kind = arg3 === "tag" || arg3 === "project" || arg3 === "initiative" ? arg3 : "tag";
		return { key, kind, items: arg1 };
	}
	const key = typeof arg1 === "string" ? arg1 : "group";
	const kind = arg2 === "tag" || arg2 === "project" || arg2 === "initiative" ? arg2 : "tag";
	const items = Array.isArray(arg3) ? arg3 : [];
	return { key, kind, items };
}

export type ComputedTaskGroupRollup = UiTaskGroupRollup & {
	doneOrLiveTasks: number;
};

/**
 * Computes a deterministic 9-tier `UiTaskGroupRollup` across a set of tasks (by Tag, Project, or Initiative).
 * Supports both `computeGroupRollup(key, kind, tasks)` and `computeGroupRollup(tasks, key?, kind?)`.
 */
export function computeGroupRollup(
	key: string,
	kind: "tag" | "project" | "initiative",
	tasks: ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus>,
): ComputedTaskGroupRollup;
export function computeGroupRollup(
	tasks: ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus>,
	key?: string,
	kind?: "tag" | "project" | "initiative",
): ComputedTaskGroupRollup;
export function computeGroupRollup(
	arg1: string | ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus>,
	arg2?: "tag" | "project" | "initiative" | string,
	arg3?: ReadonlyArray<RollupTaskInput | UiTaskLifecycleStatus> | "tag" | "project" | "initiative",
): ComputedTaskGroupRollup {
	const { key, kind, items } = normalizeRollupArgs(arg1, arg2, arg3);

	const countsByStatus: Record<UiTaskLifecycleStatus, number> = {
		paused: 0,
		stuck: 0,
		asking: 0,
		blocked: 0,
		waiting: 0,
		queued: 0,
		working: 0,
		landing: 0,
		landed: 0,
		deploying: 0,
		live: 0,
		done: 0,
		dropped: 0,
	};

	const rolesSet = new Set<string>();
	const appsSet = new Set<string>();
	let updatedAt = 0;

	const structuredTasks: Array<RollupTaskInput & { lifecycleStatus: UiTaskLifecycleStatus }> = [];
	for (const item of items) {
		if (typeof item === "string") {
			countsByStatus[item] = (countsByStatus[item] ?? 0) + 1;
			structuredTasks.push({ lifecycleStatus: item });
			continue;
		}
		const st: UiTaskLifecycleStatus =
			item.lifecycleStatus ??
			(item.status === "in_progress"
				? "working"
				: item.status === "ready"
					? "queued"
					: item.status && item.status in countsByStatus
						? (item.status as UiTaskLifecycleStatus)
						: "queued");
		countsByStatus[st] = (countsByStatus[st] ?? 0) + 1;
		structuredTasks.push({ ...item, lifecycleStatus: st });

		if (typeof item.role === "string" && item.role.trim()) {
			rolesSet.add(item.role.trim());
		}
		const normTouches = item.normalizedTouches ?? (item.touches ? normalizeTouches(item.touches) : []);
		for (const t of normTouches) {
			if (t.appOrSystem) appsSet.add(t.appOrSystem);
		}
		const ts = Math.max(item.updatedAt ?? 0, item.finishedAt ?? 0, item.startedAt ?? 0, item.createdAt ?? 0);
		if (ts > updatedAt) updatedAt = ts;
	}

	const totalTasks = structuredTasks.length;
	const nonDroppedCount = totalTasks - countsByStatus.dropped;
	const activeCount = countsByStatus.deploying + countsByStatus.landing + countsByStatus.working;
	const blockedOrWaitingCount = countsByStatus.blocked + countsByStatus.waiting;
	const doneOrLiveTasks = countsByStatus.live + countsByStatus.done;

	let rollupStatus: UiGroupRollupStatus;
	let statusTone: UiStatusTone;

	if (countsByStatus.stuck > 0) {
		rollupStatus = "needs_you";
		statusTone = "needs_you";
	} else if (countsByStatus.asking > 0) {
		rollupStatus = "needs_lead";
		statusTone = "needs_lead";
	} else if (blockedOrWaitingCount > 0 && activeCount === 0) {
		rollupStatus = "stalled";
		statusTone = "blocked";
	} else if (countsByStatus.deploying > 0) {
		rollupStatus = "deploying";
		statusTone = "deploying";
	} else if (countsByStatus.landing > 0) {
		rollupStatus = "landing";
		statusTone = "working";
	} else if (countsByStatus.working > 0) {
		rollupStatus = "working";
		statusTone = "working";
	} else if (countsByStatus.landed > 0) {
		rollupStatus = "landed_pending_deploy";
		statusTone = "landed";
	} else if (countsByStatus.queued > 0) {
		rollupStatus = "queued";
		statusTone = "queued";
	} else if (countsByStatus.paused > 0) {
		rollupStatus = "paused";
		statusTone = "paused";
	} else if (nonDroppedCount > 0 && doneOrLiveTasks === nonDroppedCount) {
		if (countsByStatus.live > 0) {
			rollupStatus = "live";
			statusTone = "live";
		} else {
			rollupStatus = "done";
			statusTone = "live";
		}
	} else {
		rollupStatus = "dropped";
		statusTone = "dropped";
	}

	const hasBlockedPeers =
		(rollupStatus === "working" || rollupStatus === "landing" || rollupStatus === "deploying") &&
		blockedOrWaitingCount > 0;

	const needsUnblockHint =
		rollupStatus === "needs_you" ||
		rollupStatus === "needs_lead" ||
		rollupStatus === "stalled" ||
		rollupStatus === "paused" ||
		hasBlockedPeers;

	let howToUnblock: string | undefined;
	let rootBlockerRef: string | undefined;

	if (needsUnblockHint) {
		const priorityOrder: UiTaskLifecycleStatus[] = ["stuck", "asking", "blocked", "waiting", "paused", "queued"];
		for (const targetStatus of priorityOrder) {
			const candidate = structuredTasks.find(
				(t) =>
					t.lifecycleStatus === targetStatus &&
					Boolean(t.howToUnblock || t.blocked?.howToUnblock || t.wait?.howToUnblock),
			);
			if (candidate) {
				howToUnblock = candidate.howToUnblock ?? candidate.blocked?.howToUnblock ?? candidate.wait?.howToUnblock;
				rootBlockerRef =
					candidate.rootBlockerRef ??
					candidate.blocked?.resolvedOn?.find((d) => !d.satisfied)?.ref ??
					(candidate.role && candidate.id ? `${candidate.role} #${candidate.id}` : undefined);
				break;
			}
		}
		if (!howToUnblock) {
			if (rollupStatus === "needs_you") {
				howToUnblock = "How to unblock: Answer the pending owner question";
			} else if (rollupStatus === "needs_lead") {
				howToUnblock = "How to unblock: Have the department lead answer the pending question";
			} else if (rollupStatus === "stalled" || hasBlockedPeers) {
				howToUnblock = "How to unblock: Resolve the upstream task blocker or wait check";
			} else if (rollupStatus === "paused") {
				howToUnblock = "How to unblock: Resume the paused task or queue";
			}
		}
	}

	return {
		key,
		kind,
		rollupStatus,
		statusTone,
		...(howToUnblock ? { howToUnblock } : {}),
		...(rootBlockerRef ? { rootBlockerRef } : {}),
		totalTasks,
		doneOrLiveTasks,
		countsByStatus,
		hasBlockedPeers,
		roles: Array.from(rolesSet).sort(),
		appsOrSystems: Array.from(appsSet).sort(),
		updatedAt,
	};
}

/**
 * Computes `tagGroups: UiTaskGroupRollup[]` across all tasks, sorted by severity (`GROUP_ROLLUP_PRIORITY`)
 * then `updatedAt` descending.
 */
export function computeTagGroups(tasks: ReadonlyArray<RollupTaskInput>): UiTaskGroupRollup[] {
	const byTag = new Map<string, RollupTaskInput[]>();
	for (const task of tasks) {
		if (!Array.isArray(task.tags)) continue;
		for (const rawTag of task.tags) {
			if (typeof rawTag !== "string" || !rawTag.trim()) continue;
			const tag = rawTag.trim();
			let bucket = byTag.get(tag);
			if (!bucket) {
				bucket = [];
				byTag.set(tag, bucket);
			}
			bucket.push(task);
		}
	}

	const groups: UiTaskGroupRollup[] = [];
	for (const [tag, bucket] of byTag.entries()) {
		groups.push(computeGroupRollup(tag, "tag", bucket));
	}

	groups.sort((a, b) => {
		const pa = GROUP_ROLLUP_PRIORITY[a.rollupStatus] ?? 99;
		const pb = GROUP_ROLLUP_PRIORITY[b.rollupStatus] ?? 99;
		if (pa !== pb) return pa - pb;
		if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
		return a.key.localeCompare(b.key);
	});

	return groups;
}

/**
 * Computes `touchSystems: UiTouchSystemSummary[]` pre-aggregating `appOrSystem -> tags`
 * and active/total task counts.
 */
export function computeTouchSystems(tasks: ReadonlyArray<RollupTaskInput>): UiTouchSystemSummary[] {
	const byApp = new Map<
		string,
		{
			repo?: string;
			activeTaskCount: number;
			totalTaskCount: number;
			tags: Set<string>;
		}
	>();

	for (const task of tasks) {
		const normTouches = task.normalizedTouches ?? (task.touches ? normalizeTouches(task.touches) : []);
		if (normTouches.length === 0) continue;

		const seenAppsForTask = new Set<string>();
		const isActive =
			task.lifecycleStatus !== undefined
				? task.lifecycleStatus !== "live" && task.lifecycleStatus !== "done" && task.lifecycleStatus !== "dropped"
				: task.status !== "done" && task.status !== "dropped";

		for (const touch of normTouches) {
			const app = touch.appOrSystem;
			if (!app) continue;
			let entry = byApp.get(app);
			if (!entry) {
				entry = {
					...(touch.repo ? { repo: touch.repo } : {}),
					activeTaskCount: 0,
					totalTaskCount: 0,
					tags: new Set<string>(),
				};
				byApp.set(app, entry);
			} else if (!entry.repo && touch.repo) {
				entry.repo = touch.repo;
			}
			if (!seenAppsForTask.has(app)) {
				seenAppsForTask.add(app);
				entry.totalTaskCount += 1;
				if (isActive) entry.activeTaskCount += 1;
			}
			if (Array.isArray(task.tags)) {
				for (const tag of task.tags) {
					if (typeof tag === "string" && tag.trim()) {
						entry.tags.add(tag.trim());
					}
				}
			}
		}
	}

	const out: UiTouchSystemSummary[] = [];
	for (const [appOrSystem, entry] of byApp.entries()) {
		out.push({
			appOrSystem,
			...(entry.repo ? { repo: entry.repo } : {}),
			activeTaskCount: entry.activeTaskCount,
			totalTaskCount: entry.totalTaskCount,
			tags: Array.from(entry.tags).sort(),
		});
	}

	out.sort((a, b) => {
		if (b.activeTaskCount !== a.activeTaskCount) return b.activeTaskCount - a.activeTaskCount;
		if (b.totalTaskCount !== a.totalTaskCount) return b.totalTaskCount - a.totalTaskCount;
		return a.appOrSystem.localeCompare(b.appOrSystem);
	});

	return out;
}

// ---------------------------------------------------------------------------
// Live Host Snapshot Reader (mtime-cached, 0 subprocesses)
// ---------------------------------------------------------------------------

export interface LiveDeploySnapshotPaths {
	landQueueDir?: string;
	wtDeployStateDir?: string;
	wtDeployNestedDir?: string;
	piWebDataDir?: string;
	piWebDeployStateDir?: string;
	piWebDeployLiveDir?: string;
}

/**
 * Warms the git ancestry cache for all candidate `(repo, landedCommit, liveCommit)` pairs
 * across tasks before synchronous `taskOf` / `resolveTaskLifecycleAndDelivery` calls run.
 */
export async function warmDeliveryAncestryCache(
	tasks: ReadonlyArray<{ role?: string; task: TaskDeliveryInput } | TaskDeliveryInput>,
	snapshots?: DeployStateSnapshots & { repoRoots?: Readonly<Record<string, string>> },
): Promise<void> {
	const promises: Promise<void>[] = [];
	for (const entry of tasks) {
		const isWrapped =
			entry !== null &&
			typeof entry === "object" &&
			"task" in entry &&
			entry.task !== null &&
			typeof entry.task === "object";
		const task = isWrapped ? (entry as { role?: string; task: TaskDeliveryInput }).task : (entry as TaskDeliveryInput);
		const role = isWrapped ? ((entry as { role?: string; task: TaskDeliveryInput }).role ?? task.role) : task.role;
		if (
			task.status !== "done" &&
			task.status !== "waiting" &&
			task.status !== "working" &&
			task.status !== "in_progress"
		) {
			continue;
		}
		const normalizedTask: TaskDeliveryInput =
			task.doneSummary === undefined && task.summary !== undefined ? { ...task, doneSummary: task.summary } : task;
		const delivery = resolveTaskDeliveryState(normalizedTask, { ...snapshots, role });
		if (!delivery?.landedCommit || !delivery.deployableService) continue;
		const deployRecord = findMatchingDeployRecord(delivery.repo, snapshots);
		const targetDeployCommit = deployRecord?.targetCommit ?? deployRecord?.commit ?? delivery.liveCommit;
		if (targetDeployCommit) {
			promises.push(
				scheduleAsyncAncestorCheck(delivery.repo, delivery.landedCommit, targetDeployCommit, snapshots?.repoRoots),
			);
		}
		if (delivery.liveCommit && delivery.liveCommit !== targetDeployCommit) {
			promises.push(
				scheduleAsyncAncestorCheck(delivery.repo, delivery.landedCommit, delivery.liveCommit, snapshots?.repoRoots),
			);
		}
	}
	if (promises.length > 0) {
		await Promise.all(promises);
	}
}

let cachedSnapshots: { stamp: string; data: DeployStateSnapshots } | null = null;

function safeStatStamp(targetPath: string): string {
	try {
		const st = statSync(targetPath);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "missing";
	}
}

function readJsonSafe(filePath: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * Reads `wt-land-queue`, `wt-deploy`, and `pi-web-deploy` state files from disk with mtime caching.
 */
export function readLiveDeploySnapshots(paths?: LiveDeploySnapshotPaths): DeployStateSnapshots {
	const home = homedir();
	const landQueueDir =
		paths?.landQueueDir ?? process.env.WT_LAND_QUEUE_DIR ?? path.join(home, ".local", "state", "wt-land-queue");
	const wtDeployStateDir =
		paths?.wtDeployStateDir ?? process.env.WT_DEPLOY_STATE_DIR ?? path.join(home, ".local", "state", "wt-deploy");
	const wtDeployNestedDir = paths?.wtDeployNestedDir ?? path.join(home, ".local", "state", "wt", "deploy");
	const piWebDataDir = paths?.piWebDataDir ?? process.env.PI_WEB_DATA_DIR ?? path.join(home, ".pi-web-ui");
	const piWebDeployStateDir =
		paths?.piWebDeployStateDir ??
		process.env.PI_WEB_DEPLOY_STATE_DIR ??
		path.join(home, ".local", "state", "pi-web-deploy");
	const piWebDeployLiveDir =
		paths?.piWebDeployLiveDir ?? process.env.PI_WEB_DEPLOY_LIVE_DIR ?? "/home/shinelay/projects/pi-web-ui";
	const piWebDeployMarkerFile = path.join(piWebDeployLiveDir, "dist", ".pi-web-deploy.json");

	const stamp = [
		safeStatStamp(landQueueDir),
		safeStatStamp(wtDeployStateDir),
		safeStatStamp(wtDeployNestedDir),
		safeStatStamp(path.join(piWebDataDir, "deploy-status.json")),
		safeStatStamp(path.join(piWebDeployStateDir, "state.json")),
		safeStatStamp(piWebDeployMarkerFile),
	].join("|");

	if (cachedSnapshots && cachedSnapshots.stamp === stamp) {
		return cachedSnapshots.data;
	}

	const wtLandRecords = new Map<string, WtLandRecordInput>();
	try {
		for (const name of readdirSync(landQueueDir)) {
			if (!name.endsWith(".json")) continue;
			const raw = readJsonSafe(path.join(landQueueDir, name));
			if (!raw || typeof raw.id !== "string") continue;
			wtLandRecords.set(raw.id, {
				id: raw.id,
				...(typeof raw.repo === "string" ? { repo: raw.repo } : {}),
				...(typeof raw.branch === "string" ? { branch: raw.branch } : {}),
				...(typeof raw.taskRef === "string" ? { taskRef: raw.taskRef } : {}),
				...(typeof raw.status === "string" ? { status: raw.status } : {}),
				...(typeof raw.headSha === "string" ? { headSha: raw.headSha } : {}),
				...(typeof raw.landedSha === "string" ? { landedSha: raw.landedSha } : {}),
				...(typeof raw.finishedAt === "string" || typeof raw.finishedAt === "number"
					? { finishedAt: raw.finishedAt }
					: {}),
				...(typeof raw.detail === "string" ? { detail: raw.detail } : {}),
				...(typeof raw.error === "string" ? { error: raw.error } : {}),
			});
		}
	} catch {
		// directory may not exist yet
	}

	const wtDeployRecords = new Map<string, WtDeployRecordInput>();

	// 1. Flat ~/.local/state/wt-deploy/<repo>.json files
	try {
		for (const name of readdirSync(wtDeployStateDir)) {
			if (!name.endsWith(".json")) continue;
			const repoSlug = normalizeRepoSlug(name.slice(0, -5));
			const raw = readJsonSafe(path.join(wtDeployStateDir, name));
			if (!repoSlug || !raw) continue;
			wtDeployRecords.set(repoSlug, {
				repo: repoSlug,
				...(typeof raw.targetBranch === "string" ? { targetBranch: raw.targetBranch } : {}),
				...(typeof raw.status === "string" ? { status: raw.status } : {}),
				...(typeof raw.commit === "string" ? { commit: raw.commit } : {}),
				...(typeof raw.targetCommit === "string" ? { targetCommit: raw.targetCommit } : {}),
				...(typeof raw.liveCommit === "string" ? { liveCommit: raw.liveCommit } : {}),
				...(typeof raw.healthOk === "boolean" ? { healthOk: raw.healthOk } : {}),
				...(typeof raw.healthCommit === "string" ? { healthCommit: raw.healthCommit } : {}),
				...(typeof raw.finishedAt === "string" || typeof raw.finishedAt === "number"
					? { finishedAt: raw.finishedAt }
					: {}),
				...(typeof raw.error === "string" ? { error: raw.error } : {}),
			});
		}
	} catch {
		// directory may not exist
	}

	// 2. Nested ~/.local/state/wt/deploy/<repo>/state.json files
	try {
		for (const entry of readdirSync(wtDeployNestedDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const repoSlug = normalizeRepoSlug(entry.name);
			if (!repoSlug || wtDeployRecords.has(repoSlug)) continue;
			const raw = readJsonSafe(path.join(wtDeployNestedDir, entry.name, "state.json"));
			if (!raw) continue;
			const liveSha = typeof raw.live_sha === "string" ? raw.live_sha : undefined;
			const runningObj =
				raw.running && typeof raw.running === "object" ? (raw.running as Record<string, unknown>) : undefined;
			const runningSha =
				typeof raw.running === "string"
					? raw.running
					: typeof runningObj?.sha === "string"
						? runningObj.sha
						: undefined;
			const finishedAt =
				typeof raw.live_at === "string"
					? raw.live_at
					: typeof raw.last_end_at === "string"
						? raw.last_end_at
						: undefined;
			wtDeployRecords.set(repoSlug, {
				repo: repoSlug,
				status: runningSha ? "deploying" : liveSha ? "succeeded" : undefined,
				...(runningSha ? { commit: runningSha, targetCommit: runningSha } : {}),
				...(liveSha ? { liveCommit: liveSha, healthCommit: liveSha, healthOk: true } : {}),
				...(finishedAt ? { finishedAt } : {}),
			});
		}
	} catch {
		// directory may not exist
	}

	// 3. pi-web-deploy state (~/.pi-web-ui/deploy-status.json or ~/.local/state/pi-web-deploy/state.json)
	let piWebDeployRecord: WtDeployRecordInput | undefined = wtDeployRecords.get("pi-web-ui");
	const deployStatusFile = readJsonSafe(path.join(piWebDataDir, "deploy-status.json"));
	if (deployStatusFile) {
		piWebDeployRecord = {
			repo: "pi-web-ui",
			...(typeof deployStatusFile.status === "string" ? { status: deployStatusFile.status } : {}),
			...(typeof deployStatusFile.commit === "string" ? { commit: deployStatusFile.commit } : {}),
			...(typeof deployStatusFile.targetCommit === "string" ? { targetCommit: deployStatusFile.targetCommit } : {}),
			...(typeof deployStatusFile.liveCommit === "string" ? { liveCommit: deployStatusFile.liveCommit } : {}),
			...(typeof deployStatusFile.healthCommit === "string" ? { healthCommit: deployStatusFile.healthCommit } : {}),
			...(typeof deployStatusFile.healthOk === "boolean" ? { healthOk: deployStatusFile.healthOk } : {}),
			...(typeof deployStatusFile.finishedAt === "string" || typeof deployStatusFile.finishedAt === "number"
				? { finishedAt: deployStatusFile.finishedAt }
				: {}),
			...(typeof deployStatusFile.error === "string" ? { error: deployStatusFile.error } : {}),
		};
		wtDeployRecords.set("pi-web-ui", piWebDeployRecord);
	} else if (!piWebDeployRecord) {
		const piWebState = readJsonSafe(path.join(piWebDeployStateDir, "state.json"));
		if (piWebState) {
			const liveSha = typeof piWebState.live_sha === "string" ? piWebState.live_sha : undefined;
			const runningObj =
				piWebState.running && typeof piWebState.running === "object"
					? (piWebState.running as Record<string, unknown>)
					: undefined;
			const runningSha =
				typeof runningObj?.target_sha === "string"
					? runningObj.target_sha
					: typeof runningObj?.sha === "string"
						? runningObj.sha
						: undefined;
			piWebDeployRecord = {
				repo: "pi-web-ui",
				status: runningSha ? "deploying" : liveSha ? "succeeded" : undefined,
				...(runningSha ? { commit: runningSha, targetCommit: runningSha } : {}),
				...(liveSha
					? {
							commit: liveSha,
							liveCommit: liveSha,
							healthCommit: liveSha,
							healthOk: true,
						}
					: {}),
				...(typeof piWebState.deployed_at === "string" ? { finishedAt: piWebState.deployed_at } : {}),
			};
			wtDeployRecords.set("pi-web-ui", piWebDeployRecord);
		} else {
			const piWebMarker = readJsonSafe(piWebDeployMarkerFile);
			const commit =
				typeof piWebMarker?.commit === "string" && HEX_SHA_RE.test(piWebMarker.commit.trim())
					? piWebMarker.commit.trim().toLowerCase()
					: undefined;
			if (piWebMarker && commit) {
				piWebDeployRecord = {
					repo: "pi-web-ui",
					status: "succeeded",
					commit,
					liveCommit: commit,
					healthCommit: commit,
					healthOk: true,
					...(typeof piWebMarker.deployedAt === "string" || typeof piWebMarker.deployedAt === "number"
						? { finishedAt: piWebMarker.deployedAt }
						: {}),
				};
				wtDeployRecords.set("pi-web-ui", piWebDeployRecord);
			}
		}
	}

	const data: DeployStateSnapshots = {
		wtLandRecords,
		wtDeployRecords,
		piWebDeployRecord: piWebDeployRecord ?? null,
	};
	cachedSnapshots = { stamp, data };
	return data;
}

/**
 * Host-bound cache wrapper used by `RolesOverviewReader` to load `DeployStateSnapshots`.
 */
export class DeliveryStateCache {
	constructor(
		private readonly getPaths?: () =>
			| {
					wtState?: string;
					deployLive?: string;
					deployStage?: string;
					wtStateDir?: string;
					landQueueDir?: string;
					deployStatusFile?: string;
			  }
			| undefined,
	) {}

	async loadSnapshots(): Promise<DeployStateSnapshots> {
		const hostPaths = this.getPaths?.();
		const stateRoot = hostPaths?.wtState ? path.dirname(hostPaths.wtState) : undefined;
		const wtState = hostPaths?.wtState ?? hostPaths?.wtStateDir;
		return readLiveDeploySnapshots(
			hostPaths
				? {
						...(hostPaths.landQueueDir
							? { landQueueDir: hostPaths.landQueueDir }
							: stateRoot
								? { landQueueDir: path.join(stateRoot, "wt-land-queue") }
								: {}),
						...(stateRoot ? { wtDeployStateDir: path.join(stateRoot, "wt-deploy") } : {}),
						...(wtState ? { wtDeployNestedDir: path.join(wtState, "deploy") } : {}),
						...(hostPaths.deployStatusFile ? { piWebDataDir: path.dirname(hostPaths.deployStatusFile) } : {}),
						...(stateRoot ? { piWebDeployStateDir: path.join(stateRoot, "pi-web-deploy") } : {}),
						...(hostPaths.deployLive ? { piWebDeployLiveDir: hostPaths.deployLive } : {}),
					}
				: undefined,
		);
	}
}
