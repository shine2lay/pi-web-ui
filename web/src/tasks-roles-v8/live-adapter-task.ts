import type { UiRoleAsk as ProtocolUiRoleAsk } from "../../../server/protocol.js";
import { normPriority } from "../components/TaskPriorityBadge.js";
import {
	cleanTagSlug,
	deriveLifecycleFromProtocolTask,
	formatAppDisplayLabel,
	formatRelativeAge,
	inferAppFromText,
	isRawShellCheckUnblock,
	mapProtocolBlocked,
	mapProtocolDelivery,
	mapProtocolQueued,
	mapProtocolWait,
	shortRoleTitle,
	stripLeadingUnblockPrefix,
	type AdaptableTaskInput,
	type LiveChatTarget,
} from "./live-adapter-helpers.js";
import {
	normalizeTouches,
	parseTimestampMs,
	statusToneForLifecycle,
	type UiNormalizedTouch,
	type UiRoleTask,
	type UiTaskLifecycleStatus,
} from "./types.js";

export interface LiveAdapterTaskContext {
	readonly now: number;
	readonly asksByTaskId: Map<number, ProtocolUiRoleAsk>;
	readonly asksByRoleAndTaskKey: ReadonlyMap<string, ProtocolUiRoleAsk>;
	readonly chatByTaskId: Map<number, LiveChatTarget>;
	readonly tasksById: Map<number, UiRoleTask>;
	readonly tasksByKey: Map<string, UiRoleTask>;
	readonly projectMetaById: Map<
		string,
		{ title: string; lead?: string; goal?: string; initiative?: string; appOrSystem?: string }
	>;
	nextCollisionId: number;
}

export function adaptSingleTask(
	ctx: LiveAdapterTaskContext,
	rawTask: AdaptableTaskInput,
	roleId: string,
	roleTitleRaw: string,
	queueRunning = true,
	homeChat?: { file: string; title?: string },
	contextProjectId?: string,
	contextInitiativeId?: string,
): UiRoleTask | null {
	const { now, asksByTaskId, asksByRoleAndTaskKey, chatByTaskId, tasksById, tasksByKey } = ctx;
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
		while (tasksById.has(ctx.nextCollisionId)) {
			ctx.nextCollisionId++;
		}
		internalId = ctx.nextCollisionId++;
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

	const rawAskingLead = (rawTask as { askingLead?: { leadRole?: string; question?: string; age?: string } }).askingLead;
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
						rawAskingLead?.question ?? existingTask?.askingLead?.question ?? questionText ?? latestTldr?.text ?? title,
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
	const priority = normPriority(rawTask.priority) ?? existingTask?.priority;

	const explicitUpdatedAtMs =
		parseTimestampMs(rawTask.updatedAtMs) ?? parseTimestampMs(rawTask.updatedAt) ?? existingTask?.updatedAtMs;
	const resolvedCreatedAt =
		parseTimestampMs(rawTask.createdAt) ??
		existingTask?.createdAt ??
		parseTimestampMs(rawTask.startedAt) ??
		parseTimestampMs(rawTask.latest?.ts) ??
		now;
	const resolvedUpdatedAt =
		explicitUpdatedAtMs ??
		parseTimestampMs(rawTask.finishedAt) ??
		parseTimestampMs(rawTask.endedAt) ??
		existingTask?.updatedAt ??
		parseTimestampMs(rawTask.latest?.ts) ??
		now;

	const adapted: UiRoleTask = {
		id: internalId,
		displayId,
		taskKey,
		role: roleId,
		roleTitle,
		title,
		...(priority ? { priority } : {}),
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
		createdAt: resolvedCreatedAt,
		updatedAt: resolvedUpdatedAt,
		...(explicitUpdatedAtMs !== undefined ? { updatedAtMs: explicitUpdatedAtMs } : {}),
	};

	tasksByKey.set(taskKey, adapted);
	tasksById.set(internalId, adapted);
	return adapted;
}
