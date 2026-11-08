import type {
	UiRoleAsk as ProtocolUiRoleAsk,
	UiRoleOverview as ProtocolUiRoleOverview,
	UiRolesOverview as ProtocolUiRolesOverview,
	UiRoleTask as ProtocolUiRoleTask,
	UiWorkPage as ProtocolUiWorkPage,
	UiWorkPageRecord as ProtocolUiWorkPageRecord,
	UiWorkPageTask as ProtocolUiWorkPageTask,
} from "../../../server/protocol.js";
import type { InitiativesExactInput } from "../initiatives-exact-model.js";
import type { WorkPageFeed } from "../initiatives-page/model.js";
import type { RolesState } from "../roles-state.js";
import {
	computeGroupRollup,
	normalizeTouches,
	statusToneForLifecycle,
	type TasksRolesV8Dataset,
	type UiNormalizedTouch,
	type UiRoleTask,
	type UiRoleTaskBlocked,
	type UiRoleTaskQueuedDetail,
	type UiRoleTaskRawStatus,
	type UiRoleTaskWait,
	type UiTaskDeliveryState,
	type UiTaskGroupRollup,
	type UiTaskLifecycleStatus,
	type V8DepartmentSummary,
	type V8TagOption,
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
type AdaptableTaskInput = Omit<Partial<ProtocolUiRoleTask>, "status" | "delivery" | "blocked" | "wait" | "paused"> & {
	id: number;
	status: UiRoleTaskRawStatus;
	text?: string;
	summary?: string;
	endedAt?: number;
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

function cleanTagSlug(raw: string): string {
	return raw
		.trim()
		.replace(/^#+/, "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function inferAppFromText(text: string): string | undefined {
	const lower = text.toLowerCase();
	if (lower.includes("rollcall")) return "rollcall";
	if (lower.includes("pi-web-ui") || lower.includes("roles") || lower.includes("initiatives")) return "pi-web-ui";
	if (lower.includes("inkflow")) return "inkflow";
	if (lower.includes("show&tell") || lower.includes("show-and-tell") || lower.includes("showtell")) return "showtell";
	if (lower.includes("temper")) return "temper";
	return undefined;
}

function deriveLifecycleFromProtocolTask(task: AdaptableTaskInput, queueRunning = true): UiTaskLifecycleStatus {
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

function mapProtocolDelivery(
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

function stripLeadingUnblockPrefix(text: string): string {
	return text.replace(/^(?:how to unblock:\s*)+/i, "").trim();
}

function isRawShellCheckUnblock(text: string | undefined): boolean {
	if (!text) return false;
	return text.includes("bash -c") || text.includes("Wait on '") || text.includes("for f in /");
}

function mapProtocolBlocked(task: AdaptableTaskInput, now: number): UiRoleTaskBlocked | undefined {
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

function mapProtocolWait(task: AdaptableTaskInput, now: number): UiRoleTaskWait | undefined {
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

function mapProtocolQueued(task: AdaptableTaskInput, roleId: string): UiRoleTaskQueuedDetail | undefined {
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

function parseTaskNumberFromFocus(focus: string | undefined, key: string | undefined): number | null {
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

export function buildLiveTasksRolesV8Dataset(input: LiveTasksRolesAdapterInput): LiveTasksRolesAdaptedResult {
	const overview = input.overview ?? input.rolesState?.overview ?? null;
	const workPage = input.workPage ?? input.workState?.page ?? null;
	const now = input.now ?? overview?.at ?? workPage?.at ?? Date.now();

	const asksByTaskId = new Map<number, ProtocolUiRoleAsk>();
	const asksByRoleAndTaskKey = new Map<string, ProtocolUiRoleAsk>();
	const unattachedAsks: ProtocolUiRoleAsk[] = [];

	const registerAsk = (ask: ProtocolUiRoleAsk) => {
		const numId =
			parseTaskNumberFromFocus(ask.focus, ask.key) ??
			(typeof (ask as { id?: string }).id === "string" && /^\d+$/.test((ask as { id?: string }).id!)
				? Number((ask as { id?: string }).id)
				: null);
		const askRole = ask.role || (ask as { roleId?: string }).roleId || "workspace";
		if (numId !== null) {
			asksByTaskId.set(numId, ask);
			asksByRoleAndTaskKey.set(`${askRole}:#${numId}`, ask);
		} else {
			unattachedAsks.push(ask);
		}
	};

	for (const role of overview?.roles ?? []) {
		for (const ask of role.asks ?? []) {
			registerAsk(ask);
		}
	}
	const extraOverviewAsks = (overview as { asks?: ProtocolUiRoleAsk[] } | null)?.asks ?? [];
	for (const ask of extraOverviewAsks) {
		registerAsk(ask);
	}

	const projectMetaById = new Map<
		string,
		{ title: string; lead?: string; goal?: string; initiative?: string; appOrSystem?: string }
	>();
	const tagGroupMetaByTag = new Map<
		string,
		{
			title: string;
			whySummary?: string;
			howToUnblock?: string;
			roles: string[];
			touches: string[];
			handoff?: UiTaskGroupRollup["handoff"];
		}
	>();

	const registerRecord = (rec: ProtocolUiWorkPageRecord) => {
		const slug = cleanTagSlug(rec.id);
		if (!slug) return;
		projectMetaById.set(slug, {
			title: rec.name || rec.id,
			...(rec.lead ? { lead: rec.lead } : {}),
			...(rec.outcome ? { goal: rec.outcome } : {}),
			...(rec.initiative ? { initiative: rec.initiative } : {}),
		});
	};

	for (const init of workPage?.initiatives ?? []) registerRecord(init);
	for (const proj of workPage?.projects ?? []) registerRecord(proj);

	for (const tg of [...(overview?.tagGroups ?? []), ...(workPage?.tagGroups ?? [])]) {
		const rawKey = tg.key.replace(/^(?:tag|project|initiative):/, "");
		const slug = cleanTagSlug(rawKey);
		if (!slug) continue;
		const tgRich = tg as Partial<UiTaskGroupRollup>;
		tagGroupMetaByTag.set(slug, {
			title: tgRich.title ?? projectMetaById.get(slug)?.title ?? `#${slug}`,
			...(tgRich.whySummary ? { whySummary: tgRich.whySummary } : {}),
			...(tg.howToUnblock ? { howToUnblock: tg.howToUnblock } : {}),
			roles: tg.roles ?? [],
			touches: tg.appsOrSystems ?? [],
			...(tgRich.handoff ? { handoff: tgRich.handoff } : {}),
		});
	}

	const chatByTaskId = new Map<number, LiveChatTarget>();
	const chatByRoleId = new Map<string, string>();
	const tasksById = new Map<number, UiRoleTask>();
	const tasksByKey = new Map<string, UiRoleTask>();
	let nextCollisionId = 100_001;

	const departments: V8DepartmentSummary[] = [];
	const idleCandidates: Array<{
		id: string;
		title: string;
		note: string;
		inUse: number;
		atOnce: number;
		queueRunning: boolean;
		homeChat?: { file: string; title?: string };
		score: number;
	}> = [];

	const addAdaptedTask = (
		rawTask: AdaptableTaskInput,
		roleId: string,
		roleTitleRaw: string,
		queueRunning = true,
		homeChat?: { file: string; title?: string },
		contextProjectId?: string,
		contextInitiativeId?: string,
	): UiRoleTask | null => {
		const displayId = rawTask.id;
		const taskKey = `${roleId}:${displayId}`;
		const askLookupKey = `${roleId}:#${displayId}`;
		const existingTask = tasksByKey.get(taskKey);

		let internalId: number;
		if (existingTask) {
			internalId = existingTask.id;
		} else if (!tasksById.has(displayId)) {
			internalId = displayId;
		} else {
			while (tasksById.has(nextCollisionId)) {
				nextCollisionId++;
			}
			internalId = nextCollisionId++;
		}

		const roleTitle = shortRoleTitle(roleId, roleTitleRaw || existingTask?.roleTitle);
		const rawTitle = rawTask.title || rawTask.text;
		const title = rawTitle || existingTask?.title || `Task #${displayId}`;

		const derivedLifecycle = deriveLifecycleFromProtocolTask(rawTask, queueRunning);
		const lifecycleStatus: UiTaskLifecycleStatus = rawTask.lifecycleStatus
			? rawTask.lifecycleStatus
			: existingTask
				? existingTask.lifecycleStatus === "working" && derivedLifecycle !== "working" && derivedLifecycle !== "queued"
					? derivedLifecycle
					: existingTask.lifecycleStatus
				: derivedLifecycle;
		const statusTone = rawTask.statusTone ?? statusToneForLifecycle(lifecycleStatus);

		const explicitAppOrSystem = (rawTask as { appOrSystem?: string }).appOrSystem?.trim();
		const explicitAppLabel = (rawTask as { appLabel?: string }).appLabel?.trim();

		const rawTouches =
			rawTask.touches && rawTask.touches.length > 0 ? rawTask.touches : (existingTask?.touches ?? undefined);
		const normalizedTouches: UiNormalizedTouch[] =
			rawTask.normalizedTouches && rawTask.normalizedTouches.length > 0
				? rawTask.normalizedTouches
				: explicitAppOrSystem
					? normalizeTouches([explicitAppOrSystem, ...(rawTouches ?? [])])
					: rawTouches && rawTouches.length > 0
						? normalizeTouches(rawTouches)
						: (existingTask?.normalizedTouches ?? []);

		const appOrSystem =
			explicitAppOrSystem ??
			normalizedTouches[0]?.appOrSystem ??
			rawTask.delivery?.repo ??
			rawTask.evidence?.repo ??
			existingTask?.appOrSystem ??
			inferAppFromText(`${title} ${(rawTouches ?? []).join(" ")}`) ??
			"pi-web-ui";
		const appLabel = explicitAppLabel ?? existingTask?.appLabel ?? formatAppDisplayLabel(appOrSystem);

		const parentProject =
			rawTask.project ??
			(rawTask.parent && "project" in rawTask.parent ? rawTask.parent.project : contextProjectId) ??
			existingTask?.project;
		const parentInitiative =
			rawTask.initiative ??
			(rawTask.parent && "initiative" in rawTask.parent ? rawTask.parent.initiative : contextInitiativeId) ??
			existingTask?.initiative;

		const defaultFallbackTag = cleanTagSlug(appOrSystem) || "general";
		const tagSet = new Set<string>();
		for (const tg of rawTask.tags ?? []) {
			const cleaned = cleanTagSlug(tg);
			if (cleaned) tagSet.add(cleaned);
		}
		if (parentProject) {
			const cleaned = cleanTagSlug(parentProject);
			if (cleaned) tagSet.add(cleaned);
		}
		if (parentInitiative) {
			const cleaned = cleanTagSlug(parentInitiative);
			if (cleaned) tagSet.add(cleaned);
		}
		for (const existingTag of existingTask?.tags ?? []) {
			if (existingTag && existingTag !== "general" && existingTag !== defaultFallbackTag) {
				tagSet.add(existingTag);
			}
		}
		if (tagSet.size === 0) {
			for (const existingTag of existingTask?.tags ?? []) {
				if (existingTag) tagSet.add(existingTag);
			}
		}
		if (tagSet.size === 0) {
			tagSet.add(defaultFallbackTag);
		}
		const tags = Array.from(tagSet);

		const fallbackAskById = asksByTaskId.get(displayId);
		const matchingAsk =
			asksByRoleAndTaskKey.get(askLookupKey) ??
			(fallbackAskById && (!fallbackAskById.role || fallbackAskById.role === roleId) ? fallbackAskById : undefined);
		if (matchingAsk) {
			asksByTaskId.set(internalId, matchingAsk);
		}

		const chatFile = rawTask.chat?.file ?? existingTask?.chat?.file ?? matchingAsk?.chat?.file ?? homeChat?.file;
		if (chatFile) {
			chatByTaskId.set(internalId, {
				file: chatFile,
				focus: { kind: "task", id: String(displayId) },
				...(rawTask.latest?.ts ? { jumpAt: rawTask.latest.ts } : {}),
			});
		}

		const latestTldr =
			rawTask.latestTldr ??
			(rawTask.progress?.text
				? {
						text: rawTask.progress.text,
						...(rawTask.progress.at ? { at: rawTask.progress.at } : {}),
						age: formatRelativeAge(rawTask.progress.at, now),
					}
				: rawTask.latest?.text
					? {
							text: rawTask.latest.text,
							at: rawTask.latest.ts,
							age: formatRelativeAge(rawTask.latest.ts, now),
						}
					: existingTask?.latestTldr);

		const newBlocked = mapProtocolBlocked(rawTask, now);
		const blocked = newBlocked ?? existingTask?.blocked;
		const newWait = mapProtocolWait(rawTask, now);
		const wait = newWait ?? existingTask?.wait;
		const newQueuedDetail = mapProtocolQueued(rawTask, roleId);
		const queuedDetail = newQueuedDetail ?? existingTask?.queuedDetail;
		const newDelivery = mapProtocolDelivery(rawTask, appOrSystem, now);
		const delivery =
			newDelivery && existingTask?.delivery
				? { ...existingTask.delivery, ...newDelivery }
				: (newDelivery ?? existingTask?.delivery);

		const rawDeps =
			rawTask.dependsOnRefs && rawTask.dependsOnRefs.length > 0
				? [...rawTask.dependsOnRefs]
				: blocked?.on && blocked.on.length > 0
					? [...blocked.on]
					: rawTask.after && rawTask.after.length > 0
						? rawTask.after.map((id) => (typeof id === "number" ? `${roleId} #${id}` : String(id)))
						: [];
		const dependsOnRefs = rawDeps.length > 0 ? rawDeps : (existingTask?.dependsOnRefs ?? []);

		const askFallbackChoices = (matchingAsk as { choices?: readonly string[] } | undefined)?.choices;
		const questionText =
			rawTask.stuck?.question ??
			rawTask.question ??
			existingTask?.stuck?.question ??
			matchingAsk?.text ??
			(rawTask.next && rawTask.next.kind === "answer" ? rawTask.next.what : undefined);
		const choices =
			rawTask.stuck?.choices && rawTask.stuck.choices.length > 0
				? [...rawTask.stuck.choices]
				: rawTask.choices && rawTask.choices.length > 0
					? [...rawTask.choices]
					: existingTask?.stuck?.choices && existingTask.stuck.choices.length > 0
						? [...existingTask.stuck.choices]
						: askFallbackChoices && askFallbackChoices.length > 0
							? [...askFallbackChoices]
							: questionText
								? ["Answer question"]
								: [];

		const rawStuckAge = (rawTask.stuck as { age?: string } | undefined)?.age ?? existingTask?.stuck?.age;
		const stuck =
			lifecycleStatus === "stuck" && (questionText || matchingAsk || rawTask.stuck || existingTask?.stuck)
				? {
						question: questionText ?? matchingAsk?.text ?? title,
						age:
							rawStuckAge ?? formatRelativeAge(rawTask.stuck?.sinceAt ?? matchingAsk?.since ?? rawTask.latest?.ts, now),
						...(choices.length > 0 ? { choices } : {}),
						...(rawTask.stuck?.needsOwner
							? { needsOwner: rawTask.stuck.needsOwner }
							: existingTask?.stuck?.needsOwner
								? { needsOwner: existingTask.stuck.needsOwner }
								: {}),
						...(rawTask.stuck?.sinceAt
							? { sinceAt: rawTask.stuck.sinceAt }
							: existingTask?.stuck?.sinceAt
								? { sinceAt: existingTask.stuck.sinceAt }
								: {}),
						tier: rawTask.stuck?.tier ?? existingTask?.stuck?.tier ?? ("owner" as const),
					}
				: undefined;

		const rawAskingLead = (rawTask as { askingLead?: { leadRole?: string; question?: string; age?: string } })
			.askingLead;
		const askingLead =
			lifecycleStatus === "asking"
				? {
						leadRole:
							rawAskingLead?.leadRole ??
							existingTask?.askingLead?.leadRole ??
							(rawTask.withLead
								? `${shortRoleTitle(rawTask.withLead, rawTask.withLead)} Lead`
								: rawTask.askLead
									? `${shortRoleTitle(rawTask.askLead, rawTask.askLead)} Lead`
									: `${roleTitle} Lead`),
						question:
							rawAskingLead?.question ??
							existingTask?.askingLead?.question ??
							questionText ??
							latestTldr?.text ??
							title,
						age:
							rawAskingLead?.age ??
							existingTask?.askingLead?.age ??
							formatRelativeAge(rawTask.progress?.at ?? rawTask.latest?.ts, now),
					}
				: undefined;

		if (lifecycleStatus === "stuck" && !asksByTaskId.has(internalId) && chatFile) {
			asksByTaskId.set(internalId, {
				key: `${roleId}:task:${displayId}`,
				role: roleId,
				kind: "task",
				text: stuck?.question ?? title,
				since: rawTask.latest?.ts ?? now,
				focus: `task:${displayId}`,
				chat: {
					file: chatFile,
					where: displayId,
				},
			});
		}

		const rawTaskUnblockClean =
			rawTask.howToUnblock && !isRawShellCheckUnblock(rawTask.howToUnblock)
				? stripLeadingUnblockPrefix(rawTask.howToUnblock)
				: undefined;
		const rawHowToUnblock =
			rawTaskUnblockClean ??
			existingTask?.howToUnblock ??
			blocked?.howToUnblock ??
			wait?.howToUnblock ??
			(stuck
				? `Answer ${roleTitle} #${displayId} in Details ▸ (${choices[0] ?? "decision required"})`
				: askingLead
					? `${askingLead.leadRole}: reply on #${displayId}`
					: queuedDetail
						? queuedDetail.summary
						: rawTask.waitsOn
							? `Resolve: ${rawTask.waitsOn}`
							: undefined);
		const howToUnblock = rawHowToUnblock ? stripLeadingUnblockPrefix(rawHowToUnblock) : undefined;

		const doneSummary = rawTask.doneSummary ?? rawTask.summary ?? existingTask?.doneSummary;

		const pausedReason =
			rawTask.pausedReason ??
			(typeof rawTask.paused === "object" && rawTask.paused !== null ? rawTask.paused.why : undefined) ??
			existingTask?.pausedReason;
		const pipelineStage = rawTask.pipelineStage ?? existingTask?.pipelineStage;
		const chatTitle = rawTask.chat?.title ?? existingTask?.chat?.title;

		const adapted: UiRoleTask = {
			id: internalId,
			displayId,
			taskKey,
			role: roleId,
			roleTitle,
			title,
			status: rawTask.status ?? existingTask?.status ?? "working",
			lifecycleStatus,
			statusTone,
			paused: Boolean(rawTask.paused) || Boolean(existingTask?.paused),
			...(pausedReason ? { pausedReason } : {}),
			...(pipelineStage !== undefined ? { pipelineStage } : {}),
			...(parentProject ? { project: parentProject } : {}),
			...(parentInitiative ? { initiative: parentInitiative } : {}),
			appOrSystem,
			appLabel,
			tags,
			...(rawTouches ? { touches: rawTouches } : {}),
			normalizedTouches,
			dependsOnRefs,
			...(howToUnblock ? { howToUnblock } : {}),
			...(latestTldr ? { latestTldr } : {}),
			...(stuck ? { stuck } : {}),
			...(askingLead ? { askingLead } : {}),
			...(blocked ? { blocked } : {}),
			...(wait ? { wait } : {}),
			...(queuedDetail ? { queuedDetail } : {}),
			...(delivery ? { delivery } : {}),
			...(doneSummary ? { doneSummary } : {}),
			...(chatFile
				? {
						chat: {
							file: chatFile,
							...(chatTitle ? { title: chatTitle } : {}),
						},
					}
				: {}),
			createdAt: rawTask.createdAt ?? existingTask?.createdAt ?? rawTask.startedAt ?? rawTask.latest?.ts ?? now,
			updatedAt:
				rawTask.updatedAt ??
				rawTask.finishedAt ??
				rawTask.endedAt ??
				existingTask?.updatedAt ??
				rawTask.latest?.ts ??
				now,
		};

		tasksByKey.set(taskKey, adapted);
		tasksById.set(internalId, adapted);
		return adapted;
	};

	// 1. Collect tasks and roles from UiRolesOverview when present
	for (const role of (overview?.roles ?? []) as ProtocolUiRoleOverview[]) {
		const homeChatObj = typeof role.homeChat === "string" ? { file: role.homeChat } : role.homeChat;
		if (homeChatObj?.file) {
			chatByRoleId.set(role.id, homeChatObj.file);
		}
		const roleTitle = shortRoleTitle(role.id, role.title);
		const q = role.queue;
		const queueStateRaw = (q as { state?: string } | undefined)?.state;
		const queueRunning = queueStateRaw !== undefined ? queueStateRaw === "running" : Boolean(q?.running ?? true);
		const inUse = Number(q?.lanes?.inUse ?? (typeof q?.running === "number" ? q.running : 0));
		const atOnce = Number(q?.lanes?.atOnce ?? (q?.lanes as { max?: number } | undefined)?.max ?? 2);

		const activeTasks = q?.active ?? [];
		const queuedTasks = q?.queued ?? [];
		const recentDoneSource =
			role.doneRecent ??
			(q as { recentDone?: Array<{ id: number; title: string; summary?: string; at?: number }> } | undefined)
				?.recentDone ??
			[];
		const recentDoneTasks = recentDoneSource.slice(0, 3);

		for (const t of [...activeTasks, ...queuedTasks]) {
			addAdaptedTask(t, role.id, roleTitle, queueRunning, homeChatObj);
		}
		for (const d of recentDoneTasks) {
			const doneLifecycle = (d as { lifecycleStatus?: UiTaskLifecycleStatus }).lifecycleStatus;
			if (!tasksByKey.has(`${role.id}:${d.id}`) && (!doneLifecycle || doneLifecycle === "done")) {
				continue;
			}
			addAdaptedTask(
				{
					id: d.id,
					title: d.title,
					status: "done",
					...(doneLifecycle ? { lifecycleStatus: doneLifecycle } : {}),
					...(d.summary ? { doneSummary: d.summary } : {}),
					...(d.at ? { finishedAt: d.at, updatedAt: d.at } : {}),
				},
				role.id,
				roleTitle,
				queueRunning,
				homeChatObj,
			);
		}

		const hasDirectAsk = unattachedAsks.some((a) => (a.role || (a as { roleId?: string }).roleId) === role.id);
		const problemsList = role.problems ?? [];
		const isRoleActive =
			activeTasks.length > 0 ||
			queuedTasks.length > 0 ||
			role.status === "busy" ||
			role.status === "needs-you" ||
			(role.status as string) === "working" ||
			(role.status as string) === "blocked" ||
			(role.status as string) === "error" ||
			hasDirectAsk ||
			problemsList.length > 0;

		const doneCount =
			q?.counts?.done ?? (q as { doneCount?: number } | undefined)?.doneCount ?? recentDoneSource.length;
		const firstProblem = problemsList[0];
		const problemText =
			typeof firstProblem === "string" ? firstProblem : (firstProblem as { detail?: string } | undefined)?.detail;
		const latestNote =
			role.tldr?.[0]?.text ??
			problemText ??
			(doneCount > 0 ? `0 active tasks · ${doneCount} done` : "0 active tasks · All clear");

		if (isRoleActive) {
			departments.push({
				id: role.id,
				title: roleTitle,
				inUse,
				atOnce,
				queueRunning,
				...(homeChatObj ? { homeChat: homeChatObj } : {}),
				note: latestNote,
			});
		} else {
			idleCandidates.push({
				id: role.id,
				title: roleTitle,
				note: latestNote,
				inUse,
				atOnce,
				queueRunning,
				...(homeChatObj ? { homeChat: homeChatObj } : {}),
				score: (role.tldr?.[0]?.ts ?? 0) + doneCount * 1000,
			});
		}
	}

	// 2. Attach or synthesize tasks for any direct role asks
	let syntheticAskId = 9001;
	for (const ask of unattachedAsks) {
		const askRole = ask.role || (ask as { roleId?: string }).roleId || "workspace";
		const existingRoleStuck = [...tasksById.values()].find((t) => t.role === askRole && t.lifecycleStatus === "stuck");
		if (existingRoleStuck && !asksByTaskId.has(existingRoleStuck.id)) {
			asksByTaskId.set(existingRoleStuck.id, ask);
			continue;
		}
		while (tasksById.has(syntheticAskId)) syntheticAskId++;
		const synthId = syntheticAskId++;
		const roleTitle = shortRoleTitle(askRole, (ask as { roleTitle?: string }).roleTitle);
		const appOrSystem = inferAppFromText(ask.text) ?? "pi-web-ui";
		const appLabel = formatAppDisplayLabel(appOrSystem);
		const rawChoices = (ask as { choices?: readonly string[] }).choices;
		const choices = rawChoices && rawChoices.length > 0 ? [...rawChoices] : ["Answer question"];
		const askSince = ask.since ?? (ask as { at?: number }).at ?? now;
		const synthTask: UiRoleTask = {
			id: synthId,
			displayId: synthId,
			taskKey: `${askRole}:${synthId}`,
			role: askRole,
			roleTitle,
			title: ask.text,
			status: "stuck",
			lifecycleStatus: "stuck",
			statusTone: "needs_you",
			paused: false,
			appOrSystem,
			appLabel,
			tags: [cleanTagSlug(appOrSystem) || "general"],
			dependsOnRefs: [],
			howToUnblock: `Answer ${roleTitle} question in Details ▸`,
			stuck: {
				question: ask.text,
				age: formatRelativeAge(askSince, now),
				choices,
			},
			chat: {
				file: ask.chat.file,
				...(ask.chat.title ? { title: ask.chat.title } : {}),
			},
			createdAt: askSince,
			updatedAt: askSince,
		};
		tasksByKey.set(`${askRole}:${synthId}`, synthTask);
		tasksById.set(synthId, synthTask);
		asksByTaskId.set(synthId, ask);
		chatByTaskId.set(synthId, {
			file: ask.chat.file,
			focus: { kind: ask.kind === "tldr" ? "tldr" : "question", id: ask.askId ?? ask.focus ?? String(synthId) },
			jumpAt: askSince,
		});
	}

	// 3a. Adapt any rich tasks embedded in tagGroups
	for (const tg of [...(overview?.tagGroups ?? []), ...(workPage?.tagGroups ?? [])]) {
		const tgRich = tg as Partial<UiTaskGroupRollup>;
		for (const t of tgRich.tasks ?? []) {
			addAdaptedTask(
				t as unknown as AdaptableTaskInput,
				t.role || "workspace",
				t.roleTitle || shortRoleTitle(t.role || "workspace"),
				!t.paused,
			);
		}
	}

	// 3. Merge tasks from UiWorkPage.tasks (and any test-fixture workPage shapes)
	for (const wpTask of (workPage?.tasks ?? []) as ProtocolUiWorkPageTask[]) {
		if (wpTask.state === "removed" || wpTask.state === "dropped") {
			continue;
		}
		const roleId = wpTask.queueName || cleanTagSlug(wpTask.queue) || "workspace";
		const wpTaskKey = `${roleId}:${wpTask.task}`;
		if (
			wpTask.state === "done" &&
			!tasksByKey.has(wpTaskKey) &&
			(!wpTask.lifecycleStatus || wpTask.lifecycleStatus === "done")
		) {
			continue;
		}
		const rawState = wpTask.state || "working";
		const pProj = wpTask.parent && "project" in wpTask.parent ? wpTask.parent.project : undefined;
		const pInit = wpTask.parent && "initiative" in wpTask.parent ? wpTask.parent.initiative : undefined;
		addAdaptedTask(
			{
				id: wpTask.task,
				title: wpTask.title,
				status: rawState,
				...(wpTask.lifecycleStatus ? { lifecycleStatus: wpTask.lifecycleStatus } : {}),
				...(wpTask.statusTone ? { statusTone: wpTask.statusTone } : {}),
				...(wpTask.howToUnblock ? { howToUnblock: wpTask.howToUnblock } : {}),
				...(wpTask.dependsOnRefs ? { dependsOnRefs: wpTask.dependsOnRefs } : {}),
				...(wpTask.tags ? { tags: wpTask.tags } : {}),
				...(wpTask.touches ? { touches: wpTask.touches } : {}),
				...(wpTask.normalizedTouches ? { normalizedTouches: wpTask.normalizedTouches } : {}),
				...(wpTask.delivery ? { delivery: wpTask.delivery } : {}),
				...(wpTask.wait ? { wait: wpTask.wait } : {}),
				...(wpTask.blockedDetail ? { blocked: wpTask.blockedDetail } : {}),
				...(wpTask.queuedDetail ? { queuedDetail: wpTask.queuedDetail } : {}),
				...(wpTask.paused ? { paused: wpTask.paused } : {}),
				...(wpTask.withLead ? { withLead: wpTask.withLead } : {}),
				...(wpTask.progress ? { progress: wpTask.progress } : {}),
				...(wpTask.doneSummary ? { doneSummary: wpTask.doneSummary } : {}),
				...(wpTask.needsYou ? { question: wpTask.needsYou.text } : {}),
				...(wpTask.chat ? { chat: { file: wpTask.chat } } : {}),
				createdAt: wpTask.added,
				...(wpTask.stateAt ? { updatedAt: wpTask.stateAt } : {}),
			},
			roleId,
			shortRoleTitle(roleId),
			!wpTask.queueStopped,
			undefined,
			pProj,
			pInit,
		);
	}

	// 3b. Adapt InitiativesExactInput metadata; only adapt standalone tasks when no live overview/workPage tasks exist
	if (input.exactInput) {
		const exact = input.exactInput;
		const shouldAdaptExactTasks = tasksByKey.size === 0 && !overview && !workPage;
		let synthExactId = 8001;
		for (const init of exact.initiatives ?? []) {
			const slug = cleanTagSlug(init.id);
			if (slug) {
				projectMetaById.set(slug, {
					title: init.name || init.id,
					...(init.lead ? { lead: init.lead } : {}),
					...(init.goal ? { goal: init.goal } : {}),
				});
			}
			// Support both standard InitiativesExactInitiative.roles and test-fixture .projects/.tasks
			const initAny = init as unknown as {
				projects?: Array<{
					id: string;
					name?: string;
					lead?: string;
					goal?: string;
					tasks?: Array<{
						id: number;
						role?: string;
						roleId?: string;
						title: string;
						status?: string;
						waitsOn?: string;
						question?: string;
						choices?: readonly string[];
						withLead?: string;
					}>;
				}>;
				tasks?: Array<{
					id: number;
					role?: string;
					roleId?: string;
					title: string;
					status?: string;
					waitsOn?: string;
					question?: string;
					choices?: readonly string[];
					withLead?: string;
				}>;
			};
			for (const proj of initAny.projects ?? []) {
				const pSlug = cleanTagSlug(proj.id);
				if (pSlug) {
					projectMetaById.set(pSlug, {
						title: proj.name || proj.id,
						...(proj.lead ? { lead: proj.lead } : {}),
						...(proj.goal ? { goal: proj.goal } : {}),
						initiative: init.id,
					});
				}
				if (!shouldAdaptExactTasks) continue;
				for (const t of proj.tasks ?? []) {
					const roleId = t.roleId || cleanTagSlug(t.role ?? "workspace") || "workspace";
					addAdaptedTask(
						{
							id: t.id,
							title: t.title,
							status: (t.status as UiRoleTaskRawStatus) ?? "working",
							...(t.waitsOn ? { waitsOn: t.waitsOn } : {}),
							...(t.question ? { question: t.question } : {}),
							...(t.choices ? { choices: [...t.choices] } : {}),
							...(t.withLead ? { withLead: t.withLead } : {}),
						},
						roleId,
						shortRoleTitle(roleId, t.role),
						true,
						undefined,
						proj.id,
						init.id,
					);
				}
			}
			if (!shouldAdaptExactTasks) continue;
			for (const t of initAny.tasks ?? []) {
				const roleId = t.roleId || cleanTagSlug(t.role ?? "workspace") || "workspace";
				addAdaptedTask(
					{
						id: t.id,
						title: t.title,
						status: (t.status as UiRoleTaskRawStatus) ?? "working",
						...(t.waitsOn ? { waitsOn: t.waitsOn } : {}),
						...(t.question ? { question: t.question } : {}),
						...(t.choices ? { choices: [...t.choices] } : {}),
						...(t.withLead ? { withLead: t.withLead } : {}),
					},
					roleId,
					shortRoleTitle(roleId, t.role),
					true,
					undefined,
					undefined,
					init.id,
				);
			}
			for (const roleRow of init.roles ?? []) {
				const roleId = cleanTagSlug(roleRow.name ?? "workspace") || "workspace";
				const parsedNum = roleRow.task ? Number(roleRow.task.replace(/^#/, "")) : NaN;
				const taskId = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : synthExactId++;
				const statusMap: Record<string, UiRoleTaskRawStatus> = {
					working: "working",
					waiting: "waiting",
					blocked: "blocked",
					onhold: "waiting",
					queued: "ready",
					paused: "ready",
					done: "done",
				};
				const rawStatus = (roleRow.kind && statusMap[roleRow.kind]) || "working";
				if (roleRow.taskTitle || roleRow.part) {
					addAdaptedTask(
						{
							id: taskId,
							title: roleRow.taskTitle || roleRow.part || init.name || init.id,
							status: rawStatus,
							...(roleRow.wait ? { waitsOn: roleRow.wait } : {}),
						},
						roleId,
						shortRoleTitle(roleId, roleRow.name),
						roleRow.kind !== "paused",
						undefined,
						undefined,
						init.id,
					);
				}
			}
		}
	}

	// Ensure at least 6 department cards in the Bento grid when >= 6 roles exist
	idleCandidates.sort((a, b) => b.score - a.score);
	while (departments.length < 6 && idleCandidates.length > 0) {
		const next = idleCandidates.shift()!;
		departments.push({
			id: next.id,
			title: next.title,
			inUse: next.inUse,
			atOnce: next.atOnce,
			queueRunning: next.queueRunning,
			...(next.homeChat ? { homeChat: next.homeChat } : {}),
			note: next.note,
		});
	}

	const idleDepartments = idleCandidates.map((c) => ({
		id: c.id,
		title: c.title,
		note: c.note,
	}));

	// 4. Build askGroups (tag/project/initiative groups) from adapted tasks
	const allTasks = [...tasksById.values()];
	const tasksByPrimaryTag = new Map<string, UiRoleTask[]>();
	for (const slug of tagGroupMetaByTag.keys()) {
		if (!tasksByPrimaryTag.has(slug)) {
			tasksByPrimaryTag.set(slug, []);
		}
	}
	for (const task of allTasks) {
		const primaryTag = task.tags?.[0] ?? "general";
		const list = tasksByPrimaryTag.get(primaryTag) ?? [];
		list.push(task);
		tasksByPrimaryTag.set(primaryTag, list);
	}

	const askGroups: UiTaskGroupRollup[] = [];
	for (const [tag, groupTasks] of tasksByPrimaryTag.entries()) {
		if (groupTasks.length === 0) continue;
		const rollup = computeGroupRollup(groupTasks, { key: `tag:${tag}`, kind: "tag" });
		const meta = projectMetaById.get(tag);
		const tgMeta = tagGroupMetaByTag.get(tag);
		const first = groupTasks[0];
		const appOrSystem = first?.appOrSystem ?? "pi-web-ui";
		const appLabel = first?.appLabel ?? formatAppDisplayLabel(appOrSystem);

		const allGroupTags = Array.from(new Set(groupTasks.flatMap((t) => t.tags ?? [tag])));
		const handoff =
			tgMeta?.handoff ??
			rollup.roles.map((r) => {
				const roleTasks = groupTasks.filter((t) => t.role === r);
				const topTask = roleTasks[0];
				const roleTitle = topTask?.roleTitle ?? shortRoleTitle(r);
				return {
					role: r,
					roleTitle,
					status: topTask?.lifecycleStatus ?? "working",
					summary: topTask ? `#${topTask.displayId ?? topTask.id}` : roleTitle,
				};
			});

		askGroups.push({
			...rollup,
			title: meta?.title ?? tgMeta?.title ?? `#${tag}`,
			whySummary:
				tgMeta?.whySummary ??
				meta?.goal ??
				`Grouped by #${tag} across ${rollup.roles.map((r) => shortRoleTitle(r)).join(" → ")}.`,
			appOrSystem,
			appLabel,
			tags: allGroupTags,
			howToUnblock:
				tgMeta?.howToUnblock ??
				rollup.howToUnblock ??
				(meta?.goal ? `Goal: ${meta.goal}` : "All active stages running on schedule."),
			handoff,
			tasks: groupTasks,
		});
	}

	// 5. Build touchSystems and allTags options
	const appCounts = new Map<string, number>();
	for (const t of allTasks) {
		const app = t.appOrSystem ?? "pi-web-ui";
		appCounts.set(app, (appCounts.get(app) ?? 0) + 1);
	}
	const touchSystems = [
		{ id: "all", label: "All apps", count: allTasks.length },
		...[...appCounts.entries()].map(([id, count]) => ({
			id,
			label: formatAppDisplayLabel(id),
			count,
		})),
	];

	const tagTouchesMap = new Map<string, Set<string>>();
	for (const slug of tagGroupMetaByTag.keys()) {
		tagTouchesMap.set(slug, new Set<string>());
	}
	for (const t of allTasks) {
		const app = t.appOrSystem ?? "pi-web-ui";
		for (const tg of t.tags ?? []) {
			const set = tagTouchesMap.get(tg) ?? new Set<string>();
			set.add(app);
			tagTouchesMap.set(tg, set);
		}
	}
	const allTags: V8TagOption[] = [...tagTouchesMap.entries()]
		.filter(([, touchesSet]) => touchesSet.size > 0)
		.map(([id, touchesSet]) => ({
			id,
			label: `#${id}`,
			touches: [...touchesSet],
		}));

	const exactPageState =
		input.exactInput?.page?.state ?? (input.exactInput as { state?: string } | null | undefined)?.state;
	let mode: "normal" | "loading" | "empty" | "error" = "normal";
	if (!overview && !workPage && !input.exactInput) {
		if (input.rolesState?.status === "error" || input.workState?.status === "error") {
			mode = "error";
		} else if (input.rolesState?.status === "loading" || input.workState?.status === "loading") {
			mode = "loading";
		}
	} else if (exactPageState === "error") {
		mode = "error";
	} else if (exactPageState === "loading" && allTasks.length === 0) {
		mode = "loading";
	} else if (allTasks.length === 0 && departments.length === 0 && idleDepartments.length === 0) {
		mode = "empty";
	}

	return {
		dataset: {
			askGroups,
			tasks: allTasks,
			departments,
			idleDepartments,
			touchSystems,
			allTags,
		},
		mode,
		asksByTaskId,
		chatByTaskId,
		chatByRoleId,
		tasksById,
	};
}
