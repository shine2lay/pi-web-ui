import type {
	UiRoleAsk as ProtocolUiRoleAsk,
	UiWorkPageTask as ProtocolUiWorkPageTask,
} from "../../../server/protocol.js";
import type { TaskPriority } from "../components/TaskPriorityBadge.js";
import type { InitiativesExactInput } from "../initiatives-exact-model.js";
import {
	cleanTagSlug,
	formatAppDisplayLabel,
	formatRelativeAge,
	inferAppFromText,
	shortRoleTitle,
	type AdaptableTaskInput,
} from "./live-adapter-helpers.js";
import { adaptSingleTask, type LiveAdapterTaskContext } from "./live-adapter-task.js";
import { parseTimestampMs, type UiRoleTask, type UiRoleTaskRawStatus, type UiTaskGroupRollup } from "./types.js";

export function adaptUnattachedAsks(ctx: LiveAdapterTaskContext, unattachedAsks: readonly ProtocolUiRoleAsk[]): void {
	const { now, asksByTaskId, chatByTaskId, tasksById, tasksByKey } = ctx;
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
}

export function adaptTagGroupTasks(
	ctx: LiveAdapterTaskContext,
	tagGroups: readonly Partial<UiTaskGroupRollup>[],
): void {
	for (const tgRich of tagGroups) {
		for (const t of tgRich.tasks ?? []) {
			const tUpdatedAtMs = parseTimestampMs(
				(t as { updatedAtMs?: unknown; updatedAt?: unknown }).updatedAtMs ?? (t as { updatedAt?: unknown }).updatedAt,
			);
			adaptSingleTask(
				ctx,
				{
					...(t as unknown as AdaptableTaskInput),
					...(tUpdatedAtMs !== undefined ? { updatedAt: tUpdatedAtMs, updatedAtMs: tUpdatedAtMs } : {}),
				},
				t.role || "workspace",
				t.roleTitle || shortRoleTitle(t.role || "workspace"),
				!t.paused,
			);
		}
	}
}

export function adaptWorkPageTasks(
	ctx: LiveAdapterTaskContext,
	workTasks: readonly (ProtocolUiWorkPageTask & { priority?: TaskPriority })[],
): void {
	for (const wpTask of workTasks) {
		if (wpTask.state === "removed" || wpTask.state === "dropped") {
			continue;
		}
		const roleId = wpTask.queueName || cleanTagSlug(wpTask.queue) || "workspace";
		const wpTaskKey = `${roleId}:${wpTask.task}`;
		if (
			wpTask.state === "done" &&
			!ctx.tasksByKey.has(wpTaskKey) &&
			(!wpTask.lifecycleStatus || wpTask.lifecycleStatus === "done")
		) {
			continue;
		}
		const rawState = wpTask.state || "working";
		const pProj = wpTask.parent && "project" in wpTask.parent ? wpTask.parent.project : undefined;
		const pInit = wpTask.parent && "initiative" in wpTask.parent ? wpTask.parent.initiative : undefined;
		const wpUpdatedAtMs = parseTimestampMs(
			(wpTask as { updatedAtMs?: unknown; updatedAt?: unknown }).updatedAtMs ??
				(wpTask as { updatedAt?: unknown }).updatedAt ??
				wpTask.stateAt,
		);
		adaptSingleTask(
			ctx,
			{
				id: wpTask.task,
				title: wpTask.title,
				status: rawState,
				...(wpTask.priority ? { priority: wpTask.priority } : {}),
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
				...(wpUpdatedAtMs !== undefined ? { updatedAt: wpUpdatedAtMs, updatedAtMs: wpUpdatedAtMs } : {}),
			},
			roleId,
			shortRoleTitle(roleId),
			!wpTask.queueStopped,
			undefined,
			pProj,
			pInit,
		);
	}
}

export function adaptInitiativesExactInput(
	ctx: LiveAdapterTaskContext,
	exact: InitiativesExactInput,
	shouldAdaptExactTasks: boolean,
): void {
	let synthExactId = 8001;
	for (const init of exact.initiatives ?? []) {
		const slug = cleanTagSlug(init.id);
		if (slug) {
			ctx.projectMetaById.set(slug, {
				title: init.name || init.id,
				...(init.lead ? { lead: init.lead } : {}),
				...(init.goal ? { goal: init.goal } : {}),
			});
		}
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
				ctx.projectMetaById.set(pSlug, {
					title: proj.name || proj.id,
					...(proj.lead ? { lead: proj.lead } : {}),
					...(proj.goal ? { goal: proj.goal } : {}),
					initiative: init.id,
				});
			}
			if (!shouldAdaptExactTasks) continue;
			for (const t of proj.tasks ?? []) {
				const roleId = t.roleId || cleanTagSlug(t.role ?? "workspace") || "workspace";
				const tUpdatedAtMs = parseTimestampMs(
					(t as { updatedAtMs?: unknown; updatedAt?: unknown }).updatedAtMs ?? (t as { updatedAt?: unknown }).updatedAt,
				);
				adaptSingleTask(
					ctx,
					{
						id: t.id,
						title: t.title,
						status: (t.status as UiRoleTaskRawStatus) ?? "working",
						...(t.waitsOn ? { waitsOn: t.waitsOn } : {}),
						...(t.question ? { question: t.question } : {}),
						...(t.choices ? { choices: [...t.choices] } : {}),
						...(t.withLead ? { withLead: t.withLead } : {}),
						...(tUpdatedAtMs !== undefined ? { updatedAt: tUpdatedAtMs, updatedAtMs: tUpdatedAtMs } : {}),
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
			const tUpdatedAtMs = parseTimestampMs(
				(t as { updatedAtMs?: unknown; updatedAt?: unknown }).updatedAtMs ?? (t as { updatedAt?: unknown }).updatedAt,
			);
			adaptSingleTask(
				ctx,
				{
					id: t.id,
					title: t.title,
					status: (t.status as UiRoleTaskRawStatus) ?? "working",
					...(t.waitsOn ? { waitsOn: t.waitsOn } : {}),
					...(t.question ? { question: t.question } : {}),
					...(t.choices ? { choices: [...t.choices] } : {}),
					...(t.withLead ? { withLead: t.withLead } : {}),
					...(tUpdatedAtMs !== undefined ? { updatedAt: tUpdatedAtMs, updatedAtMs: tUpdatedAtMs } : {}),
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
				adaptSingleTask(
					ctx,
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
