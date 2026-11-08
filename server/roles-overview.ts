/**
 * roles-overview: the Roles page's data: one snapshot with every role's state, made from what the app
 * already keeps:
 *   - the roles (identity.json: home chat, the owner's work mode and approved goals, the Focus line);
 *   - each role's home chat and its started task chats on disk: TL;DR lines and pi-queue entries, read
 *     once and then only the bytes added since (an unchanged file costs one stat); of a home chat also its
 *     newest model change (provider and model id, never message text);
 *   - the chats' runtime state (working or not) and the questions waiting now;
 *   - the whole role-message store (open requests, 6 am report requests), not just its last 100 rows;
 *   - the 6 am report job's runs (role-reports runs.json) and its scheduler job.
 *
 * It only reads: it loads no chat, starts no worker, calls no model and writes nothing.
 * What leaves it is display text only: TL;DR lines, task titles and questions, request first lines and
 * the report a role wrote for the owner, and its home chat's model name. Never raw entries, thinking, tool calls or results, prompts,
 * rules or notebooks. Every transcript it opens must be a plain .jsonl file inside the session folders
 * (no "..", no symlinks).
 */

import type { Ask } from "./asks.js";
import type { HeldOwnerAsk } from "./owner-question-router.js";
import { linesAboutHeldAsks, routeOfAsk } from "./owner-question-surfaces.js";
import { focusPart, identityFilePath, samePath, type IdentityDef } from "./identities.js";
import type {
	UiBoard,
	UiRoleAsk,
	UiRoleBoardOrder,
	UiRoleChatRef,
	UiRoleConfigHistory,
	UiRoleOverview,
	UiRoleUsageCost,
	UiRoleUsageGeneration,
	UiRoleQueue,
	UiRoleOpenPair,
	UiRoleReport,
	UiRoleRequest,
	UiRoleSent,
	UiRolesOverview,
	UiMessageApprovals,
	UiOwnerContact,
	UiRoleTask,
	UiRoleTldrLine,
	UiTaskQueue,
	UiTaskQueueHold,
	UiTaskQueueTask,
	UiTldrLine,
} from "./protocol.js";
import { reportReplyText, type RoleMessageState, type RoleReportReply } from "./role-messages.js";
import { rulesGoals } from "./role-rules.js";
import { readRoleSpend } from "./roles-spend.js";
// W7: types only. The worker's numeric builder/engine must never enter this page path.
import type { createUsageMeterCache } from "./usage-accounting-meter-cache.js";
import { readRoleInstructions } from "./roles-instructions.js";
import { roleSettingsOf, type RoleSettings } from "./roles-config-history.js";
import { roleAnswerKindAllowed, sortAsks } from "./roles-asks.js";
import { linkOf, taskOf } from "./roles-task-next.js";
import type { QueueSnapshotForDeps } from "./shared/task-blocker-resolver.js";
import {
	computeTagGroups,
	computeTouchSystems,
	DeliveryStateCache,
	type DeployStateSnapshots,
} from "./shared/task-delivery-resolver.js";
import { briefOfAsk } from "./owner-card-brief.js";
import { taskQueueFromEntries, taskQueueHeld, taskQueueLaneUse } from "./task-queue.js";
import { WorkRecordsFile } from "./work-records.js";
import {
	doneFactsOfTasks,
	doneRecentOf,
	progressOf,
	setDoneFacts,
	withLeadOf,
	type DoneFact,
	type StuckRoute,
} from "./live-progress.js";
import { RolesEvidence, type EvidenceView, type RolesEvidencePaths } from "./roles-evidence.js";
import { JsonFile } from "./roles-json-file.js";
import { approvalsOf, type RolesApprovalsState } from "./roles-message-approvals.js";
import {
	cutReport,
	REPORT_TZ,
	reportJobOf,
	reportRunsOf,
	reportSections,
	ROLES_REPORT_MAX,
	type ReportRun,
} from "./roles-reports.js";
import { lineOf, newestWaiting, roleModelLabel, roleWorkMode, statusOf, writtenForAsk } from "./roles-row.js";
import { ChatPaths, TranscriptScans, type TranscriptScan } from "./roles-transcripts.js";
import { TLDR_MAX_LINES, tldrLinesFromEntries } from "./tldr-lines.js";

// Split out of this file into modules of their own (Backend #15; docs/roles-overview.md, "Server modules"). Their
// names are still exported from here, so the page's importers and tests import them as before.
export { JSON_FILE_MAX, JsonFile } from "./roles-json-file.js";
export { approvalsOf, type RolesApprovalsState } from "./roles-message-approvals.js";
export {
	REPORT_TZ,
	reportJobOf,
	reportRunsOf,
	reportSections,
	ROLES_REPORT_MAX,
	type ReportRun,
} from "./roles-reports.js";
export { ROLE_MODEL_MAX, roleModelLabel, roleWorkMode, statusOf } from "./roles-row.js";
export { ChatPaths, lineKind, TranscriptScans, type TranscriptScan } from "./roles-transcripts.js";
export { RolesWatch, type RolesWatchOptions } from "./roles-watch.js";

/** TL;DR lines sent per role (its home chat and task chats together, newest first). */
export const ROLES_TLDR_MAX = 20;
/** Queued (not started) tasks listed per role. */
export const ROLES_QUEUED_MAX = 20;
/** queue-drop: how many of a role's dropped tasks the Roles page gets (newest first). */
export const ROLES_DROPPED_MAX = 5;
/** Started task chats read per role, for their TL;DR lines and open dialogs. roles-asks-read (Ops #268): 40, so
 *  a role with more than a queue's 8 lanes of started tasks still has every chat read; past it the role's
 *  allChatsRead is false and the page doesn't confirm its asks (docs/roles-asks-read.md has the timing). */
export const ROLES_TASK_CHATS_MAX = 40;

const ACTIVE: ReadonlySet<string> = new Set(["working", "asking", "stuck", "waiting", "blocked"]);

type ChatRuntime = "working" | "idle" | "closed";

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** What the reader needs from the app (AgentService). */
export interface RolesOverviewHost {
	identities(): IdentityDef[];
	/** Whether the chat with this transcript is working now (no chat is loaded for it). */
	chatState(file: string): ChatRuntime;
	/** The questions, dialogs and approvals waiting now. */
	asks(): Ask[];
	/** owner-question routing (Ops #685): the asks held for COO first (absent: none). */
	heldAsks?(): HeldOwnerAsk[];
	openRequestsTo(role: string): { open: number; newest?: UiRoleRequest };
	/** roles-sent: a role's open requests and questions to the receivers `keep` lets through (absent: none read). */
	openRequestsFrom?(role: string, keep: (to: string) => boolean): UiRoleSent;
	/** roles-sent: every sender → receiver pair with open requests or questions (absent: none read). */
	openPairs?(): UiRoleOpenPair[];
	latestReportTo(role: string):
		| {
				id: string;
				date: string;
				at: number;
				state: RoleMessageState | "held";
				target?: string;
				scanFrom?: number;
				reply?: RoleReportReply;
				error?: string;
		  }
		| undefined;
	rolePaused(): boolean;
	/** board (task #76): the roles' shared board for the page (absent: none in this app). */
	board?(): UiBoard;
	/** board: a role's open orders it hasn't marked done. */
	boardOrdersOf?(role: string): UiRoleBoardOrder[];
	/** The folders transcripts may be in. */
	sessionRoots(): string[];
	/** role-reports' runs.json and the scheduler's jobs.json. */
	reportRunsFile(): string;
	schedulerJobsFile(): string;
	/** roles-panel: the work registry's log (pi-work-management's events.jsonl); absent: none is read. */
	workFile?(): string;
	/** owner-contacts (Roles D3): the owner's messages to role home chats, newest first; absent: none. */
	ownerContacts?(): UiOwnerContact[];
	/** roles-model: the model name the open chat with this transcript shows in its header (its live state).
	 *  undefined: it isn't open; null: it is open without a model. Loads nothing. */
	chatModel?(file: string): string | null | undefined;
	/** roles-model: a model's name in the app's model list (as a chat's header shows it), when known. */
	modelName?(provider: string, modelId: string): string | undefined;
	/** roles-instructions: the every-chat rules file pi loads (AGENTS.md); absent: no instructions state. */
	agentsFile?(): string;
	/** roles-evidence (task #207): wt's records and pi-web-deploy's folders; absent: no evidence is read. */
	evidencePaths?(): RolesEvidencePaths;
	/** roles-config-history (Ops #209): a role's recorded settings changes; absent or undefined: none recorded. */
	configHistory?(role: string): UiRoleConfigHistory | undefined;
	/** ladder-alarm: the approval step's state and this server's start; absent or undefined: nothing shown. */
	messageApprovals?(): RolesApprovalsState | undefined;
	/** W6 injects its already-admitted main cache; importing/reading starts nothing. */
	usageMeterCache?(): Pick<ReturnType<typeof createUsageMeterCache>, "get"> | null;
	/** Pinned generation's first native admission receipt; absent stays unknown. */
	usageMeterFirstObservedAt?(generation: UiRoleUsageGeneration): number | null;
	now?(): number;
}

/** W7: cached scalar shaping only; no accounting, source reads or manual data in this path. */
export function roleUsageCost(
	host: Pick<RolesOverviewHost, "usageMeterCache" | "usageMeterFirstObservedAt">,
	role: string,
	at: number,
): UiRoleUsageCost {
	const absent: UiRoleUsageCost = {
		v: "role-usage-cost/1",
		reportingOnly: true,
		role,
		generation: null,
		evaluatedAt: null,
		weekStart: null,
		firstNativeObservedAt: null,
		state: "unavailable",
		storage: "unavailable",
		inventory: "unavailable",
		usage: null,
		sources: [],
		faults: [],
	};
	try {
		const snapshot = host.usageMeterCache?.()?.get(new Date(at).toISOString());
		if (!snapshot) return absent;
		const matched = snapshot.subjects.filter((s) => s.subject.kind === "role" && s.subject.role === role);
		const entry = matched.length === 1 ? matched[0] : null;
		let receipt: number | null | undefined;
		try {
			receipt = host.usageMeterFirstObservedAt?.({ ...snapshot.generation });
		} catch {
			receipt = null;
		}
		const firstNativeObservedAt =
			typeof receipt === "number" &&
			Number.isSafeInteger(receipt) &&
			receipt > 0 &&
			receipt <= Date.parse(snapshot.evaluatedAt)
				? receipt
				: null;
		return {
			...absent,
			generation: { ...snapshot.generation },
			evaluatedAt: snapshot.evaluatedAt,
			weekStart: snapshot.weekStart,
			firstNativeObservedAt,
			state: snapshot.state,
			storage: snapshot.storage,
			inventory: snapshot.inventory,
			usage: entry
				? (() => {
						const { subject: _subject, ...usage } = entry;
						return usage;
					})()
				: null,
			sources: snapshot.sources.map((s) => {
				if (s.kind === "temper") return structuredClone(s);
				const { complete_through, ...source } = s;
				return { ...source, coveredThrough: complete_through };
			}),
			faults: snapshot.faults.map((f) => ({ ...f })),
		};
	} catch {
		return absent;
	}
}

interface RoleTaskInfo {
	task: UiTaskQueueTask;
	file?: string;
	lines: UiTldrLine[];
	mtimeMs?: number;
}

interface PreReadHome {
	home: string | null;
	scan?: TranscriptScan;
	queue?: UiTaskQueue;
	problem?: boolean;
}

/** Makes the Roles page's snapshot (cached reads; see the file comment). */
export class RolesOverviewReader {
	readonly scans = new TranscriptScans();
	private readonly paths: ChatPaths;
	private readonly runs: JsonFile<ReportRun[]>;
	private readonly job: JsonFile<{ nextRunAt?: number } | null>;
	/** roles-panel: the work registry's initiatives and projects. */
	private readonly work: WorkRecordsFile | null;
	/** Report texts by request id and check time (a report doesn't change once checked). */
	private readonly reportTexts = new Map<string, { text: string; at?: number; file: string }>();
	/** roles-evidence: wt's and pi-web-deploy's records, for the working tasks' Completion evidence. */
	private readonly evidence: RolesEvidence | null;
	/** Track B2: cached wt-land-queue, wt-deploy, and pi-web-deploy state + git ancestry cache. */
	private readonly deliveryCache: DeliveryStateCache | null;

	constructor(private readonly host: RolesOverviewHost) {
		this.paths = new ChatPaths(
			() => host.sessionRoots(),
			() => this.now(),
		);
		this.runs = new JsonFile(() => host.reportRunsFile(), reportRunsOf, []);
		this.job = new JsonFile(() => host.schedulerJobsFile(), reportJobOf, null);
		const workFile = host.workFile?.bind(host);
		this.work = workFile ? new WorkRecordsFile(workFile) : null;
		const evidencePaths = host.evidencePaths?.bind(host);
		this.evidence = evidencePaths ? new RolesEvidence(evidencePaths) : null;
		this.deliveryCache = evidencePaths ? new DeliveryStateCache(evidencePaths) : null;
	}

	private now(): number {
		return this.host.now?.() ?? Date.now();
	}

	async read(): Promise<UiRolesOverview> {
		const at = this.now();
		const defs = [...this.host.identities()].sort((a, b) => a.id.localeCompare(b.id));
		const live = this.host.asks();
		const asks = live.filter((a) => a.kind !== "stuck");
		// roles-answer: a stuck task's ask, so the page can answer it there (its id rides on the task's item).
		const stuck = live.filter((a) => a.kind === "stuck");
		// owner-question routing (Ops #685): asks held for COO first (none while the switch is off).
		let held: HeldOwnerAsk[] = [];
		try {
			held = this.host.heldAsks?.() ?? [];
		} catch {
			held = [];
		}
		const runs = await this.runs.get();
		const job = await this.job.get();
		const keep = new Set<string>();
		const roles: UiRoleOverview[] = [];
		let evidence: EvidenceView | undefined;
		try {
			evidence = this.evidence ? await this.evidence.load() : undefined;
		} catch {
			evidence = undefined;
		}
		let deploySnapshots: DeployStateSnapshots | undefined;
		try {
			deploySnapshots = this.deliveryCache ? await this.deliveryCache.loadSnapshots() : undefined;
		} catch {
			deploySnapshots = undefined;
		}
		// Pre-read each role's home chat once so `queuesByRole` is available for cross-role blocker resolution.
		const preHomes = new Map<string, PreReadHome>();
		const queuesByRole = new Map<string, QueueSnapshotForDeps>();
		for (const def of defs) {
			const home = def.homeChat ? await this.paths.check(def.homeChat) : null;
			if (!home) {
				preHomes.set(def.id, { home: null });
				continue;
			}
			try {
				const s = await this.scans.read(home);
				keep.add(home);
				const q = taskQueueFromEntries(s.queue, true, Number.MAX_SAFE_INTEGER, undefined, s.sessionId);
				preHomes.set(def.id, { home, scan: s, queue: q });
				queuesByRole.set(def.id, {
					running: q.running,
					queueRunning: q.running,
					hold: q.hold,
					paused: q.hold,
					lanesAtOnce: q.lanesAtOnce,
					tasks: q.tasks,
				});
			} catch {
				preHomes.set(def.id, { home, problem: true });
			}
		}
		// roles-sent: only roles on the page count, as senders and as receivers.
		const onPage = new Set(defs.map((d) => d.id));
		const listed = (id: string) => onPage.has(id);
		// live-progress: each home queue's done tasks, for the Initiatives page's join (never sent to a page), and
		// the roles with a home chat (withLead names only one of them).
		const doneFacts = new Map<string, Map<number, DoneFact>>();
		const withHome = new Set(defs.filter((d) => !!d.homeChat).map((d) => d.id));
		const allRoleTasks: UiRoleTask[] = [];
		for (const def of defs) {
			const row = await this.role(
				def,
				at,
				asks,
				runs,
				job,
				keep,
				stuck,
				evidence,
				{ roles: withHome, done: doneFacts },
				held,
				preHomes.get(def.id),
				queuesByRole,
				deploySnapshots,
				allRoleTasks,
			);
			let sent: UiRoleSent | undefined;
			try {
				sent = this.host.openRequestsFrom?.(def.id, listed);
			} catch {
				sent = undefined;
			}
			// roles-config-history: what changed in its settings (the recorder's record; this only reads it).
			let configHistory: UiRoleConfigHistory | undefined;
			try {
				configHistory = this.host.configHistory?.(def.id);
			} catch {
				configHistory = undefined;
			}
			roles.push({
				...row,
				usageCost: roleUsageCost(this.host, def.id, at),
				...(sent ? { sent } : {}),
				...(configHistory ? { configHistory } : {}),
			});
		}
		let openPairs: UiRoleOpenPair[] | undefined;
		try {
			openPairs = this.host.openPairs?.().filter((p) => p.from !== p.to && listed(p.from) && listed(p.to));
		} catch {
			openPairs = undefined;
		}
		this.scans.retain(keep);
		const work = this.work ? await this.work.get() : undefined;
		const all = roles.flatMap((r) => r.asks);
		let board: UiBoard | undefined;
		try {
			board = this.host.board?.();
		} catch {
			board = undefined;
		}
		let contacts: UiOwnerContact[] | undefined;
		try {
			contacts = this.host.ownerContacts?.();
		} catch {
			contacts = undefined;
		}
		let approvals: UiMessageApprovals | undefined;
		try {
			approvals = approvalsOf(this.host.messageApprovals?.());
		} catch {
			approvals = undefined;
		}
		const tagGroups = computeTagGroups(allRoleTasks);
		const touchSystems = computeTouchSystems(allRoleTasks);
		const overview: UiRolesOverview = {
			at,
			roles,
			asks: sortAsks(all),
			paused: this.host.rolePaused(),
			reportTz: REPORT_TZ,
			...(board ? { board } : {}),
			...(work ? { work } : {}),
			...(contacts ? { contacts } : {}),
			...(openPairs ? { openPairs } : {}),
			...(approvals ? { approvals } : {}),
			tagGroups,
			touchSystems,
		};
		setDoneFacts(overview, doneFacts);
		return overview;
	}

	private async role(
		def: IdentityDef,
		now: number,
		liveAsks: Ask[],
		runs: ReportRun[],
		job: { nextRunAt?: number } | null,
		keep: Set<string>,
		stuckAsks: Ask[] = [],
		evidence?: EvidenceView,
		// live-progress: the roles with a home chat (withLead names only one of them) and where its done tasks go.
		live: { roles: ReadonlySet<string>; done?: Map<string, Map<number, DoneFact>> } = { roles: new Set() },
		// owner-question routing (Ops #685): asks held for COO first, with when each reaches the owner at the latest.
		heldAsks: HeldOwnerAsk[] = [],
		preHome?: PreReadHome,
		queuesByRole?: ReadonlyMap<string, QueueSnapshotForDeps>,
		deploySnapshots?: DeployStateSnapshots,
		allRoleTasks?: UiRoleTask[],
	): Promise<UiRoleOverview> {
		const problems: string[] = [];
		const mode = roleWorkMode(def.id, def.role.config, now);
		const home = preHome !== undefined ? preHome.home : def.homeChat ? await this.paths.check(def.homeChat) : null;
		if (def.homeChat && !home) problems.push("home chat");
		let homeLines: UiTldrLine[] = [];
		let tasks: UiTaskQueueTask[] = [];
		let running = false;
		let pausedReason: string | undefined;
		// queue-paused: the owner's pause on the whole queue.
		let queueHold: UiTaskQueueHold | undefined;
		// roles-lanes: lanes at once and in use, as the Queue panel counts them (only when the queue was read).
		let laneUse: UiRoleQueue["lanes"];
		let stuckAt = new Map<number, number>();
		let stuckRoute = new Map<number, StuckRoute | undefined>();
		// live-progress: its home queue was read (then doneRecent is known, [] when nothing is done).
		let queueRead = false;
		let lastActivity: number | undefined;
		// roles-model: the home chat's newest recorded model change (used when the chat isn't open).
		let recordedModel: TranscriptScan["model"];
		if (home) {
			if (preHome?.problem) {
				problems.push("home chat");
			} else if (preHome?.scan && preHome.queue) {
				const s = preHome.scan;
				const q = preHome.queue;
				lastActivity = Math.round(s.mtimeMs);
				recordedModel = s.model;
				homeLines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
				tasks = q.tasks;
				running = q.running;
				pausedReason = q.pausedReason;
				queueHold = q.hold;
				laneUse = taskQueueLaneUse(q);
				stuckAt = s.stuckAt;
				stuckRoute = s.stuckRoute;
				queueRead = true;
			} else {
				try {
					const s = await this.scans.read(home);
					keep.add(home);
					lastActivity = Math.round(s.mtimeMs);
					recordedModel = s.model;
					homeLines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
					const q = taskQueueFromEntries(s.queue, true, Number.MAX_SAFE_INTEGER, undefined, s.sessionId);
					tasks = q.tasks;
					running = q.running;
					pausedReason = q.pausedReason;
					queueHold = q.hold;
					laneUse = taskQueueLaneUse(q);
					stuckAt = s.stuckAt;
					stuckRoute = s.stuckRoute;
					queueRead = true;
				} catch {
					problems.push("home chat");
				}
			}
		}

		// Started tasks' own chats: their latest lines (and whether they are working).
		const infos: RoleTaskInfo[] = [];
		let chats = 0;
		// roles-asks-read: every started task chat was read (an open dialog in one that wasn't isn't listed).
		let allChatsRead = true;
		for (const task of tasks) {
			if (task.status === "done" || task.status === "dropped") continue;
			const info: RoleTaskInfo = { task, lines: [] };
			infos.push(info);
			if (!task.chat?.file || !ACTIVE.has(task.status)) continue;
			if (chats >= ROLES_TASK_CHATS_MAX) {
				allChatsRead = false;
				continue;
			}
			chats++;
			const file = await this.paths.check(task.chat.file);
			if (!file) {
				problems.push(`task #${task.id} chat`);
				allChatsRead = false;
				continue;
			}
			info.file = file;
			try {
				const s = await this.scans.read(file);
				keep.add(file);
				info.lines = tldrLinesFromEntries(s.tldr, TLDR_MAX_LINES);
				info.mtimeMs = s.mtimeMs;
				lastActivity = Math.max(lastActivity ?? 0, Math.round(s.mtimeMs));
			} catch {
				problems.push(`task #${task.id} chat`);
				allChatsRead = false;
			}
		}
		const taskOfChat = (file: string | undefined) =>
			file ? tasks.find((t) => t.chat?.file && samePath(t.chat.file, file)) : undefined;
		// queue-paused: the owner's pause a task is under (its own or its queue's); a paused task never
		// counts as needing him.
		const heldOf = (t: UiTaskQueueTask | undefined) => (t ? taskQueueHeld(t, { hold: queueHold }) : undefined);
		// live-progress (the owner rule, docs/live-progress.md): who has an open task's question while it hasn't
		// reached the owner. A stuck task with one is not the owner's ask.
		const withLead = (t: UiTaskQueueTask) => withLeadOf(t, stuckRoute.get(t.id), def.id, live.roles);

		const homeRef: UiRoleChatRef = { file: home ?? def.homeChat ?? "", where: "home" };
		const taskRef = (t: UiTaskQueueTask): UiRoleChatRef => ({
			file: t.chat?.file ?? homeRef.file,
			...(t.chat?.title ? { title: t.chat.title } : {}),
			where: t.id,
		});

		// owner-question routing (Ops #685): the queued tasks' cards held for COO first.
		const heldStuck = heldAsks.filter((h) => h.ask.kind === "stuck");
		const sameStuck = (a: Ask, taskId: number, target: string | undefined | null) =>
			a.task?.id === taskId && !!target && !!a.sessionFile && samePath(a.sessionFile, target);
		/** A line saying the owner is needed about a stuck task whose card is with COO first: not his yet. */
		const aboutCardWithCoo = (l: UiTldrLine, t: UiTaskQueueTask | undefined) =>
			!!t &&
			l.needsYou &&
			!l.answered &&
			t.status === "stuck" &&
			heldStuck.some((h) => sameStuck(h.ask, t.id, t.lane ? t.chat?.file : home));

		// A chat's own needs-you line about its ask held for COO first isn't his yet either (folded into that ask below).
		const heldOther = heldAsks.filter((h) => h.ask.kind !== "stuck").map((h) => h.ask);

		// TL;DR: the home chat's lines (a line copied up from a task chat keeps that chat) and the task
		// chats' own lines; a copy whose original is here too is left out.
		const tldr: UiRoleTldrLine[] = [];
		const own = new Set<string>();
		for (const info of infos) {
			const quiet = !!heldOf(info.task);
			const withCooLines = linesAboutHeldAsks(info.lines, info.file, heldOther);
			for (const l of info.lines) {
				own.add(`${info.file}\n${l.text}`);
				if (aboutCardWithCoo(l, info.task) || withCooLines.has(l.id)) continue;
				tldr.push(lineOf(l, taskRef(info.task), quiet));
			}
		}
		const homeWithCooLines = linesAboutHeldAsks(homeLines, home, heldOther);
		for (const l of homeLines) {
			const t = taskOfChat(l.chat?.file);
			if (t?.chat?.file && own.has(`${t.chat.file}\n${l.text}`)) continue;
			if (aboutCardWithCoo(l, t) || homeWithCooLines.has(l.id)) continue;
			// A copy stays a home chat line (its id is there) that says which task it is about.
			const ref: UiRoleChatRef = t ? { file: homeRef.file, where: t.id } : homeRef;
			tldr.push(lineOf(l, ref, !!heldOf(t)));
		}
		tldr.sort((a, b) => b.ts - a.ts);

		// What waits on the owner.
		const asks: UiRoleAsk[] = [];
		// owner-question routing (Ops #685): what is with COO first (roles_overview lists it; never counted).
		const withCoo: UiRoleAsk[] = [];
		const keyOf = (rest: string) => `${def.id}:${rest}`;
		for (const l of homeLines) {
			if (!l.needsYou || l.answered) continue;
			// A task's line: its task decides (stuck -> the task's ask; asking its main chat -> none).
			if (taskOfChat(l.chat?.file)) continue;
			asks.push({
				key: keyOf(`tldr:${l.id}`),
				role: def.id,
				kind: "tldr",
				text: l.text,
				...(l.ts > 0 ? { since: l.ts } : {}),
				chat: homeRef,
				focus: `tldr:${l.id}`,
			});
		}
		for (const info of infos) {
			const t = info.task;
			if (t.status !== "stuck" || heldOf(t) || withLead(t)) continue;
			const since = stuckAt.get(t.id);
			const line = newestWaiting([
				...info.lines,
				...homeLines.filter((l) => t.chat?.file && samePath(l.chat?.file, t.chat.file)),
			]);
			// roles-answer: its ask is the one about this task number in the chat its answer goes into (the
			// queue's chat, or a lane task's own chat).
			const target = t.lane ? t.chat?.file : home;
			const matches = stuckAsks.filter(
				(a) => a.task?.id === t.id && !!target && !!a.sessionFile && samePath(a.sessionFile, target),
			);
			const live = matches.length === 1 ? matches[0] : undefined;
			// owner-question routing (Ops #685): a card held for COO first isn't under Needs you or in the counts.
			const heldCard = live ? undefined : onlyOne(heldStuck.filter((h) => sameStuck(h.ask, t.id, target)));
			if (heldCard) {
				withCoo.push({
					key: keyOf(`task:${t.id}`),
					role: def.id,
					kind: "task",
					text: t.question || line?.text || t.plan.title,
					since: heldCard.ask.createdAt,
					chat: { file: homeRef.file, where: t.id },
					focus: `task:${t.id}`,
					...routeOfAsk(heldCard.ask),
					until: heldCard.until,
				});
				continue;
			}
			asks.push({
				key: keyOf(`task:${t.id}`),
				role: def.id,
				kind: "task",
				text: t.question || line?.text || t.plan.title,
				...(since ? { since } : line && line.ts > 0 ? { since: line.ts } : {}),
				// Answered in the queue's chat (its Queue tab), not the task's own chat.
				chat: { file: homeRef.file, where: t.id },
				focus: `task:${t.id}`,
				...(live ? { askId: live.id } : {}),
				// owner-card-brief (Ops #682): the card's plain brief, shown before its question.
				...briefOfAsk(live),
				// owner-question routing (Ops #685): which way it came.
				...routeOfAsk(live),
			});
		}
		const askItem = (a: Ask): UiRoleAsk | undefined => {
			const file = a.sessionFile;
			if (!file) return undefined;
			let ref: UiRoleChatRef | undefined;
			let lines: UiTldrLine[] = [];
			if (home && samePath(file, home)) {
				ref = homeRef;
				lines = homeLines.filter((l) => !l.chat);
			} else {
				const info = infos.find((i) => i.file && samePath(i.file, file));
				// queue-paused: a question in a paused task's chat doesn't count as needing the owner.
				if (info && !heldOf(info.task)) {
					ref = { ...taskRef(info.task), file: info.file ?? file };
					lines = info.lines;
				}
			}
			if (!ref) return undefined;
			// The needs-you line its chat wrote for this question (just before it) is the same ask.
			const line = newestWaiting(lines.filter((l) => writtenForAsk(l, a.createdAt)));
			if (line) {
				const dup = asks.findIndex((x) => x.key === keyOf(`tldr:${line.id}`));
				if (dup >= 0) asks.splice(dup, 1);
			}
			const since = line && line.ts > 0 ? Math.min(line.ts, a.createdAt) : a.createdAt;
			return {
				key: keyOf(`question:${a.id}`),
				role: def.id,
				kind: "question",
				text: line?.text || a.title,
				...(since > 0 ? { since } : {}),
				chat: ref,
				focus: `question:${a.id}`,
				// Keep unrecognised dialogs visible through Open chat, without a page-answer target.
				...(roleAnswerKindAllowed(a) ? { askId: a.id } : {}),
				// owner-question routing (Ops #685): which way it came.
				...routeOfAsk(a),
			};
		};
		for (const a of liveAsks) {
			const item = askItem(a);
			if (item) asks.push(item);
		}
		// owner-question routing (Ops #685): held for COO first; its needs-you line went with it (above).
		for (const h of heldAsks) {
			if (h.ask.kind === "stuck") continue;
			const item = askItem(h.ask);
			if (item) withCoo.push({ ...item, until: h.until });
		}

		// The queue in short.
		const resolvedDoneById = new Map<number, UiRoleTask>();
		const baseTaskOpts = {
			queuesByRole,
			queueRunning: running,
			queueHold,
			lanesAtOnce: laneUse?.atOnce,
			queueTasks: tasks,
			deploySnapshots,
			now,
		};
		let queue: UiRoleQueue | undefined;
		if (tasks.length || pausedReason || running || queueHold) {
			const active: UiRoleTask[] = [];
			const queued: UiRoleTask[] = [];
			let ready = 0;
			let done = 0;
			// roles-links (Ops #222): every open task by where it belongs, the listed ones and the rest alike.
			const links: NonNullable<UiRoleQueue["links"]> = { project: 0, initiative: 0, standalone: 0, unrecorded: 0 };
			// queue-drop: the tasks its lead dropped, with why (newest first).
			const dropped = tasks
				.filter((t) => t.status === "dropped")
				.sort((a, b) => (b.dropped?.at ?? 0) - (a.dropped?.at ?? 0));
			const droppedRows = dropped.map((t) => taskOf(t, def.id, undefined, baseTaskOpts));
			if (allRoleTasks) allRoleTasks.push(...droppedRows);
			for (const t of tasks) {
				if (t.status === "done") {
					done++;
					const doneRow = taskOf(t, def.id, undefined, baseTaskOpts);
					resolvedDoneById.set(t.id, doneRow);
					allRoleTasks?.push(doneRow);
					continue;
				}
				if (t.status === "dropped") continue;
				links[linkOf(t.parent)]++;
				const held = heldOf(t);
				if (t.status === "ready") {
					ready++;
					const readyRow = taskOf(t, def.id, held, baseTaskOpts);
					allRoleTasks?.push(readyRow);
					if (queued.length < ROLES_QUEUED_MAX) queued.push(readyRow);
					continue;
				}
				const info = infos.find((i) => i.task === t);
				const busy = info?.file ? this.host.chatState(info.file) === "working" : false;
				const latest = info?.lines.length ? info.lines[info.lines.length - 1] : undefined;
				const progress = info?.lines.length ? progressOf(info.lines) : undefined;
				const lead = withLead(t);
				// roles-evidence: its own chat's records only (a task with no chat yet has none). Past the
				// ROLES_TASK_CHATS_MAX chats read for TL;DR lines, its queue record still names its chat: only the
				// name is compared, no chat is read.
				let ev: UiRoleTask["evidence"];
				try {
					const file = info?.file ?? t.chat?.file;
					ev = evidence ? await evidence.of({ file, status: t.status, doneAt: t.doneAt }) : undefined;
				} catch {
					ev = undefined;
				}
				const row = taskOf(t, def.id, held, {
					...baseTaskOpts,
					evidence: ev,
					withLead: lead,
				});
				// live-progress: a stuck question a lead still holds is that lead's to answer, not the owner's.
				if (lead && t.status === "stuck" && !held) row.next = { kind: "answer", who: lead };
				const activeRow: UiRoleTask = {
					...row,
					...(busy ? { busy: true } : {}),
					...(latest ? { latest: lineOf(latest, taskRef(t), !!held) } : {}),
					...(progress ? { progress } : {}),
					...(lead ? { withLead: lead } : {}),
					...(ev ? { evidence: ev } : {}),
				};
				active.push(activeRow);
				allRoleTasks?.push(activeRow);
			}
			queue = {
				running,
				...(pausedReason ? { pausedReason } : {}),
				...(queueHold ? { hold: queueHold } : {}),
				active,
				queued,
				...(droppedRows.length ? { dropped: droppedRows.slice(0, ROLES_DROPPED_MAX) } : {}),
				// dropped only when it has some, so a queue with none reads exactly as before.
				counts: { active: active.length, queued: ready, done, ...(dropped.length ? { dropped: dropped.length } : {}) },
				...(laneUse ? { lanes: laneUse } : {}),
				links,
			};
		}
		if (home && queueRead) {
			live.done?.set(home, doneFactsOfTasks(tasks, resolvedDoneById));
		}

		// Its 6 am report.
		let report: UiRoleReport;
		try {
			report = await this.reportOf(def.id, runs, job);
		} catch {
			report = { state: "unavailable", error: "couldn't be read" };
			problems.push("report");
		}

		const requests = this.host.openRequestsTo(def.id);
		let boardOrders: UiRoleBoardOrder[] = [];
		try {
			boardOrders = this.host.boardOrdersOf?.(def.id) ?? [];
		} catch {
			problems.push("board");
		}
		const homeBusy = home ? this.host.chatState(home) === "working" : false;
		const model = home ? this.modelOf(home, recordedModel) : undefined;
		const sortedAsks = sortAsks(asks);
		const status = statusOf({
			asks: sortedAsks.length,
			// queue-paused: a paused task's record keeps saying working; only its chat at work counts then.
			busy: homeBusy || (queue?.active.some((t) => t.busy || (t.status === "working" && !t.paused)) ?? false),
			paused:
				(!!queue &&
					!queue.running &&
					(queue.pausedReason === "user" || queue.pausedReason === "stopped") &&
					tasks.some((t) => t.status === "ready" || t.status === "waiting" || t.status === "blocked")) ||
				// queue-paused: the owner paused the queue or one of its open tasks.
				tasks.some((t) => !!heldOf(t)),
			something: !!home && (homeLines.length > 0 || tasks.length > 0),
		});
		return {
			id: def.id,
			title: def.title,
			...(home ? { homeChat: { file: home } } : {}),
			...(model ? { model } : {}),
			...mode,
			status,
			...(lastActivity ? { lastActivity } : {}),
			...(homeBusy ? { homeBusy: true } : {}),
			asks: sortedAsks,
			...(withCoo.length ? { withCoo: sortAsks(withCoo) } : {}),
			allChatsRead,
			tldr: tldr.slice(0, ROLES_TLDR_MAX),
			...(queue ? { queue } : {}),
			...(queueRead ? { doneRecent: doneRecentOf(tasks) } : {}),
			requests: { open: requests.open, ...(requests.newest ? { newest: requests.newest } : {}) },
			report,
			spend: await readRoleSpend(def.dir, now),
			...(this.host.agentsFile
				? { instructions: await readRoleInstructions(def.dir, home, this.host.agentsFile()) }
				: {}),
			...(boardOrders.length ? { boardOrders } : {}),
			...(problems.length ? { problems } : {}),
		};
	}

	/** roles-model: the home chat's model as its header shows it: the open chat's live model, else the newest
	 *  model change in its file named from the app's model list. Unknown: undefined ("Not recorded"). */
	private modelOf(home: string, recorded: TranscriptScan["model"]): string | undefined {
		try {
			const live = this.host.chatModel?.(home);
			if (live !== undefined) return roleModelLabel(live);
			return recorded ? roleModelLabel(this.host.modelName?.(recorded.provider, recorded.modelId)) : undefined;
		} catch {
			return undefined;
		}
	}

	/** roles-config-history (Ops #209): every role's settings as the page shows them, for the recorder
	 *  (roles-config-history.ts). Reads like read() (cached) and writes nothing; a part it can't read now is left
	 *  out, so the recorder keeps that part's last value. */
	async configSettings(): Promise<Map<string, RoleSettings>> {
		const out = new Map<string, RoleSettings>();
		const now = this.now();
		for (const def of this.host.identities()) {
			let queue: UiTaskQueue | undefined;
			let model: string | undefined;
			const home = def.homeChat ? await this.paths.check(def.homeChat) : null;
			if (home) {
				try {
					const s = await this.scans.read(home);
					queue = taskQueueFromEntries(s.queue, true, Number.MAX_SAFE_INTEGER, undefined, s.sessionId);
					model = this.modelOf(home, s.model);
				} catch {
					queue = undefined;
				}
			}
			out.set(
				def.id,
				roleSettingsOf({
					title: def.title,
					focus: focusPart(identityFilePath(def, "about")).focus,
					workMode: roleWorkMode(def.id, def.role.config, now).workMode,
					goals: def.role.config.goals ?? rulesGoals(def.id),
					homeChat: def.homeChat,
					queue,
					model,
				}),
			);
		}
		return out;
	}

	/** A role's latest 6 am report, or why there is none. */
	private async reportOf(role: string, runs: ReportRun[], job: { nextRunAt?: number } | null): Promise<UiRoleReport> {
		const rec = this.host.latestReportTo(role);
		const run = [...runs]
			.reverse()
			.find((r) => r.active.includes(role) || r.inactive.includes(role) || role in r.sent || r.skipped.includes(role));
		if (!run) {
			if (rec) return this.fromRecord(rec);
			if (job && !runs.length) return { state: "first", ...(job.nextRunAt ? { next: job.nextRunAt } : {}) };
			return { state: "not-in-job" };
		}
		if (rec && rec.date > run.date) return this.fromRecord(rec);
		if (run.inactive.includes(role)) return { state: "not-active", date: run.date, askedAt: run.at };
		if (run.skipped.includes(role) && !run.active.includes(role)) return { state: "not-in-job" };
		const sent = run.sent[role];
		if (sent?.error && !sent.id) return { state: "failed", date: run.date, askedAt: run.at, error: short(sent.error) };
		if (rec && rec.date === run.date) return this.fromRecord(rec);
		return { state: "pending", date: run.date, askedAt: run.at };
	}

	private async fromRecord(rec: NonNullable<ReturnType<RolesOverviewHost["latestReportTo"]>>): Promise<UiRoleReport> {
		const base = { date: rec.date, askedAt: rec.at };
		if (rec.state === "failed") return { state: "failed", ...base, ...(rec.error ? { error: short(rec.error) } : {}) };
		if (!rec.reply) return { state: "pending", ...base };
		if (!rec.reply.answered) return { state: "no-answer", ...base };
		const key = `${rec.id}:${rec.reply.at}`;
		let got = this.reportTexts.get(key);
		if (!got) {
			const file = rec.target ? await this.paths.check(rec.target) : null;
			if (!file) return { state: "unavailable", ...base, error: "the chat it was written in can't be read" };
			const r = await reportReplyText(file, rec.scanFrom ?? 0, rec.id);
			got = { text: r.text, file, ...(r.at !== undefined ? { at: r.at } : {}) };
			if (this.reportTexts.size > 200) this.reportTexts.clear();
			this.reportTexts.set(key, got);
		}
		if (!got.text) return { state: "unavailable", ...base, error: "the answer isn't in its chat any more" };
		return {
			state: "report",
			...base,
			...cutReport(reportSections(got.text), got.text, ROLES_REPORT_MAX),
			chat: { file: got.file },
			...(got.at !== undefined ? { messageAt: got.at } : {}),
		};
	}
}

/** The one item, or undefined when there are none or several. */
function onlyOne<T>(items: T[]): T | undefined {
	return items.length === 1 ? items[0] : undefined;
}

function short(s: string): string {
	const line = s.split("\n")[0].trim();
	return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
