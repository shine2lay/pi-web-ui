import { deepFreeze } from "./deep-freeze.js";
import { piQueueReaders } from "./pi-queue-readers.js";
import { requesterOf } from "./queue-requester.js";
import { checkPatch, normProfile, normLaunch, patchProfile } from "./queue-profile.js";
import { normTags, resolveInheritedTags } from "./shared/task-tags.js";
import { insertByPriority, normPriority, repositionReadyTaskByPriority, taskPriority } from "./shared/task-priority.js";
import type { UiTaskQueueBlock, UiTaskQueueHold, UiTaskQueueRef, UiTaskQueueWait } from "./protocol.js";
import {
	applyHold,
	askLeadOf,
	cap,
	cardOf,
	chainOf,
	chatOf,
	current,
	DEFAULT_EVERY_MS,
	DEFAULT_GIVE_UP_MS,
	deliveryOf,
	detailOf,
	endHold,
	HOLD_WHY_MAX,
	isId,
	leadOf,
	leadRounds,
	leadsOf,
	needOf,
	nextParent,
	normAfter,
	normChoices,
	normTaskRefs,
	normTouches,
	NOTE_MAX,
	num,
	numOr,
	oneLine,
	OPEN,
	outsideOf,
	owesOf,
	parentGiven,
	PAUSE_REASONS,
	type PauseReason,
	planOf,
	remindersOf,
	setParent,
	type State,
	type Status,
	STATUSES,
	str,
	type Task,
	TASK_QUEUE_DEFAULT_LANES,
	TASK_QUEUE_DROP_WHY_MAX,
	TASK_QUEUE_ENTRY_TYPE,
	type TaskQueueEntryLike,
	TASK_QUEUE_MAX_LANES,
	timeOf,
} from "./task-queue-fields.js";

/** 应用一条变化（pi-queue applyOp 的镜像）：和队列现状对不上的变化忽略。 */
export function apply(s: State, raw: unknown): void {
	if (!raw || typeof raw !== "object") return;
	const op = raw as Record<string, unknown>;
	if (op.v !== 1) return;
	if (op.op === "autonomy") {
		if (s.from || !s.queueId || op.queueId !== s.queueId) return;
		if (op.setting !== "autoApprove" && op.setting !== "autoStart") return;
		s[op.setting] = op.value === true;
		if (op.setting === "autoStart" && s.autoStart && s.pausedReason === "user") s.pausedReason = undefined;
		return;
	}
	if (op.op === "profile" || op.op === "task_profile") {
		if (s.from || !s.queueId || op.queueId !== s.queueId) return;
		const { patch } = checkPatch(op);
		if (!Object.keys(patch).length) return;
		if (op.op === "profile") {
			s.profile = patchProfile(s.profile, patch);
			for (const t of s.tasks) if (t.status === "ready") t.problem = undefined;
		} else {
			const task = s.tasks.find((t) => t.id === op.id);
			if (!task || task.status !== "ready" || task.startedAt !== undefined) return;
			task.profile = patchProfile(task.profile, patch);
			task.problem = undefined;
		}
		return;
	}
	if (op.op === "run") {
		if (op.queueId !== undefined && op.queueId !== s.queueId) return;
		s.running = true;
		s.pausedReason = undefined;
		return;
	}
	if (op.op === "pause") {
		s.running = false;
		const reason = op.reason as PauseReason;
		s.pausedReason = PAUSE_REASONS.has(reason) ? reason : undefined;
		if (reason === "user") s.autoStart = false;
		return;
	}
	if (op.op === "clear") {
		for (const t of s.tasks) if (t.status === "done" || t.status === "dropped") t.status = "removed";
		return;
	}
	if (op.op === "lanes") {
		const n = typeof op.n === "number" && Number.isFinite(op.n) ? op.n : TASK_QUEUE_DEFAULT_LANES;
		s.lanes = Math.round(Math.min(TASK_QUEUE_MAX_LANES, Math.max(1, n)));
		return;
	}
	if (op.op === "hold" || op.op === "release") {
		applyHold(s, op);
		return;
	}
	if (!isId(op.id)) return;
	if (op.op === "add" || op.op === "assigned") {
		if (s.tasks.some((t) => t.id === op.id)) return;
		const task: Task = { id: op.id, plan: planOf(op.plan), status: "ready", addedAt: num(op.ts) };
		const priority = normPriority(op.priority);
		if (priority) task.priority = priority;
		if (op.op === "add") {
			const origin = requesterOf(op.origin);
			if (origin) task.origin = origin;
		}
		const tags =
			op.tags !== undefined
				? normTags(op.tags)
				: op.op === "add"
					? resolveInheritedTags(undefined, task.origin?.inputs)
					: undefined;
		if (tags?.length) task.tags = tags;
		if (op.op === "add" && (op.approval === "dialog" || op.approval === "auto")) task.approval = op.approval;
		setParent(
			task,
			nextParent(undefined, {
				...(typeof op.project === "string" ? { project: op.project } : {}),
				...(typeof op.initiative === "string" ? { initiative: op.initiative } : {}),
				standalone: op.standalone === true,
			}),
		);
		const touches = normTouches(op.touches);
		if (touches) task.touches = touches;
		const after = normAfter(op.after, op.id);
		if (after?.length) task.after = after;
		if (op.op === "add") task.profile = normProfile(op.profile);
		if (op.op === "add") {
			const outside = outsideOf(op.outside, undefined);
			if (outside) task.outside = outside;
		}
		if (op.op === "assigned") {
			task.launch = normLaunch(op.launch);
			s.profile = undefined;
			const from = chatOf(op.from);
			if (s.from || !from) return;
			s.from = from;
			s.autoApprove = false;
			s.autoStart = false;
			task.status = "working";
			task.startedAt = num(op.ts);
			s.running = true;
			s.pausedReason = undefined;
		}
		insertByPriority(s.tasks, task);
		return;
	}
	const task = s.tasks.find((t) => t.id === op.id);
	if (!task || !OPEN.has(task.status)) return;
	switch (op.op) {
		case "update": {
			task.plan = planOf(op.plan);
			task.approval = op.approval === "dialog" || op.approval === "auto" ? op.approval : undefined;
			setParent(task, nextParent(task.parent, parentGiven(op)));
			if (op.tags !== undefined) {
				const tags = normTags(op.tags);
				if (tags?.length) task.tags = tags;
				else delete task.tags;
			}
			const touches = normTouches(op.touches);
			if (touches) task.touches = touches;
			const after = normAfter(op.after, task.id);
			if (after?.length) task.after = after;
			else if (after) delete task.after;
			if (after) {
				const outside = outsideOf(op.outside, task.outside);
				if (outside) task.outside = outside;
				else delete task.outside;
			}
			if (op.priority !== undefined) {
				const prevPriority = taskPriority(task);
				const nextPriority = normPriority(op.priority);
				if (nextPriority) task.priority = nextPriority;
				else delete task.priority;
				if (taskPriority(task) !== prevPriority) {
					repositionReadyTaskByPriority(s.tasks, task);
				}
			}
			if (op.profile && task.status === "ready" && task.startedAt === undefined) {
				const { patch } = checkPatch(op.profile);
				if (Object.keys(patch).length) {
					task.profile = patchProfile(task.profile, patch);
					task.problem = undefined;
				}
			}
			return;
		}
		case "prepared": {
			if (!task.lane || !task.launch || task.launchPrepared) return;
			const launch = normLaunch(op.launch);
			if (launch) {
				task.launch = launch;
				task.launchPrepared = true;
			}
			return;
		}
		case "blocked":
			if (task.status === "ready" && typeof op.reason === "string" && op.reason) task.problem = op.reason.slice(0, 500);
			return;
		case "chat": {
			const chat = chatOf(op);
			if (!task.lane || task.chat || !chat) return;
			task.chat = chat;
			return;
		}
		case "back":
			if (!task.back) return;
			task.back = undefined;
			return;
		case "requeue":
			if ((!task.lane || task.chat) && !(!task.lane && task.touches !== undefined && task.status === "working")) return;
			task.status = "ready";
			task.lane = undefined;
			task.question = undefined;
			task.choices = undefined;
			task.detail = undefined;
			task.askOps = undefined;
			task.mainAnswered = undefined;
			task.wait = undefined;
			task.block = undefined;
			task.startedAt = undefined;
			task.back = undefined;
			task.launch = undefined;
			task.launchPrepared = undefined;
			return;
		case "start":
		case "resume": {
			if (op.op === "start" && task.status !== "ready") return;
			const lane = op.op === "start" ? op.lane === true : task.lane === true;
			if (!lane) {
				const cur = current(s);
				if ((op.op === "start" || task.status === "waiting") && cur && cur !== task) return;
			}
			if (lane) task.lane = true;
			if (op.op === "start") {
				task.problem = undefined;
				task.launch = normLaunch(op.launch);
			}
			task.status = "working";
			task.question = undefined;
			task.choices = undefined;
			task.detail = undefined;
			task.askOps = undefined;
			task.wait = undefined;
			task.block = undefined;
			task.mainAnswered = op.op === "resume" && typeof op.answered === "number" && op.answered > 0 ? true : undefined;
			task.back = undefined;
			task.startedAt ??= num(op.ts);
			return;
		}
		case "stuck": {
			const cur = current(s);
			if (!task.lane && cur && cur !== task) return;
			const question = str(op.question, NOTE_MAX);
			if (task.status !== "stuck" || task.question !== question || task.stuckAt === undefined)
				task.stuckAt = num(op.ts);
			task.status = "stuck";
			task.question = question;
			const choices = normChoices(op.choices);
			if (choices.length) task.choices = choices;
			else delete task.choices;
			const detail = detailOf(op.detail);
			if (detail) task.detail = detail;
			else delete task.detail;
			const card = cardOf(op);
			task.card = card.card;
			task.inShort = card.inShort;
			task.askOps = undefined;
			task.mainAnswered = undefined;
			task.wait = undefined;
			task.block = undefined;
			task.back = undefined;
			task.startedAt ??= num(op.ts);
			return;
		}
		case "ask": {
			const cur = current(s);
			if (!task.lane && cur && cur !== task) return;
			const n = typeof op.n === "number" && Number.isFinite(op.n) ? Math.round(op.n) : 0;
			if (task.status === "ready" || n < 1 || num(op.ts) <= 0) return;
			task.status = "asking";
			task.question = str(op.question, NOTE_MAX);
			task.detail = undefined;
			task.askOps = op.to === "ops" ? true : undefined;
			task.askLead = op.to === "ops" ? askLeadOf(op.lead) : undefined;
			const choices = normChoices(op.choices);
			if (choices.length) task.choices = choices;
			else delete task.choices;
			task.mainAnswered = undefined;
			task.wait = undefined;
			task.block = undefined;
			task.back = undefined;
			task.startedAt ??= num(op.ts);
			return;
		}
		case "wait": {
			if (task.status !== "working" && task.status !== "waiting") return;
			const since = num(op.ts);
			const wait: UiTaskQueueWait = {
				what: str(op.what, 200),
				check: str(op.check, 1000),
				everyMs: numOr(op.everyMs, DEFAULT_EVERY_MS),
				since,
				until: numOr(op.until, since + DEFAULT_GIVE_UP_MS),
			};
			task.status = "waiting";
			task.question = undefined;
			task.choices = undefined;
			task.detail = undefined;
			task.askOps = undefined;
			task.mainAnswered = undefined;
			task.wait = wait;
			task.back = undefined;
			task.startedAt ??= since;
			return;
		}
		case "block": {
			if (task.status !== "working" || !(task.lane || s.from)) return;
			const on = normTaskRefs(op.on);
			const need = needOf(op.need);
			const lead = leadOf(op.lead);
			if (!on && !need && !lead) return;
			const since = num(op.ts);
			const owes = lead ? owesOf(op.owes) : undefined;
			const checkpoint = lead ? timeOf(op.checkpoint) : undefined;
			const leadAt = lead && checkpoint !== undefined ? timeOf(op.leadAt) : undefined;
			const reminders = lead ? remindersOf(op.reminders) : undefined;
			const answeredAt = lead ? timeOf(op.answeredAt) : undefined;
			const block: UiTaskQueueBlock = {
				...(on ? { on } : {}),
				...(need ? { need } : {}),
				...(lead ? { lead } : {}),
				...(owes ? { owes } : {}),
				...(checkpoint !== undefined ? { checkpoint } : {}),
				...(reminders ? { reminders } : {}),
				...(leadAt !== undefined ? { leadAt } : {}),
				...(answeredAt !== undefined ? { answeredAt } : {}),
				since,
				start: Math.min(numOr(op.start, since), since),
				tries: Math.max(0, Math.round(numOr(op.tries, 0))),
			};
			task.status = "blocked";
			task.question = undefined;
			task.choices = undefined;
			task.detail = undefined;
			task.askOps = undefined;
			task.mainAnswered = undefined;
			task.wait = undefined;
			task.back = undefined;
			task.block = block;
			return;
		}
		case "route":
			if (task.status === "asking") {
				task.askOps = true;
				task.askLead = askLeadOf(op.lead);
			}
			return;
		case "poke":
			if (task.status !== "blocked" || !task.block || task.block.since !== op.since || task.block.poke) return;
			task.block.poke = {
				at: num(op.ts),
				...(op.ask === true ? { ask: true } : {}),
				...(op.ask === true && op.owner === true ? { owner: true } : {}),
			};
			return;
		case "remind": {
			const b = task.block;
			if (task.status !== "blocked" || !b?.lead || b.since !== op.since || b.poke) return;
			const sent = b.reminders ?? [];
			if (op.n !== sent.length + 1 || sent.length >= leadRounds(b)) return;
			b.reminders = [...sent, num(op.ts)];
			return;
		}
		case "chain": {
			const b = task.block;
			if (task.status !== "blocked" || !b?.lead || b.since !== op.since || b.poke || b.chain) return;
			const chain = chainOf(op.chain, b.lead);
			if (chain) b.chain = chain;
			return;
		}
		case "lead": {
			const b = task.block;
			const by = typeof op.by === "string" ? op.by : "";
			if (op.home === true) {
				if (task.status !== "blocked" || !b || b.since !== op.since || b.poke) return;
				if (!by || typeof op.answer !== "string" || !op.answer.trim()) return;
				b.poke = { at: num(op.ts), lead: by, home: true };
				return;
			}
			if (task.status !== "blocked" || !b?.lead || b.since !== op.since || b.poke || !leadsOf(b).includes(by)) return;
			if (typeof op.answer === "string" && op.answer.trim()) {
				b.poke = { at: num(op.ts), lead: by };
				return;
			}
			const cp = timeOf(op.checkpoint);
			if (cp === undefined) return;
			b.checkpoint = cp;
			b.leadAt = num(op.ts);
			return;
		}
		case "after_over": {
			const o = task.outside?.find((x) => x.file === op.file && x.id === op.n);
			if (!o || o.over) return;
			const why = typeof op.dropped === "string" ? oneLine(op.dropped, TASK_QUEUE_DROP_WHY_MAX) : "";
			o.over = {
				at: num(op.ts),
				...(op.removed === true || why ? { removed: true } : {}),
				...(why ? { dropped: why } : {}),
			};
			return;
		}
		case "wait_over":
			if (task.status !== "waiting" || !task.wait || task.wait.overAt) return;
			task.wait.overAt = num(op.ts);
			if (op.failed) task.wait.failed = cap(String(op.failed), NOTE_MAX);
			return;
		case "done": {
			task.status = "done";
			task.question = undefined;
			task.choices = undefined;
			task.detail = undefined;
			task.askOps = undefined;
			task.mainAnswered = undefined;
			task.wait = undefined;
			task.block = undefined;
			task.summary = str(op.summary, NOTE_MAX);
			task.doneAt = num(op.ts);
			const delivery = deliveryOf(op.delivery ?? op);
			if (delivery) task.delivery = delivery;
			else delete task.delivery;
			endHold(task);
			return;
		}
		case "drop":
			task.status = "dropped";
			task.question = undefined;
			task.choices = undefined;
			task.detail = undefined;
			task.askOps = undefined;
			task.mainAnswered = undefined;
			task.wait = undefined;
			task.block = undefined;
			task.dropped = { why: oneLine(op.why, TASK_QUEUE_DROP_WHY_MAX) || "no reason given", at: num(op.ts) };
			endHold(task);
			return;
		case "remove":
			task.status = "removed";
			task.block = undefined;
			endHold(task);
			return;
		case "move": {
			if (task.status !== "ready") return;
			const others = s.tasks.filter((t) => t !== task);
			const anchor = others.filter((t) => t.status === "ready")[Math.max(0, op.index as number)];
			others.splice(anchor ? others.indexOf(anchor) : others.length, 0, task);
			s.tasks = others;
			return;
		}
	}
}
