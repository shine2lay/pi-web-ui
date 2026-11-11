import { deepFreeze } from "./deep-freeze.js";
import { piQueueReaders } from "./pi-queue-readers.js";
import { requesterOf } from "./queue-requester.js";
import { normProfile, normLaunch } from "./queue-profile.js";
import { normTags } from "./shared/task-tags.js";
import { normPriority } from "./shared/task-priority.js";
import type { UiTaskQueueBlock, UiTaskQueueHold, UiTaskQueueRef } from "./protocol.js";
import { apply } from "./task-queue-apply.js";
import {
	askLeadOf,
	cap,
	cardOf,
	chainOf,
	chatOf,
	DEFAULT_EVERY_MS,
	DEFAULT_GIVE_UP_MS,
	deliveryOf,
	detailOf,
	HOLD_WHY_MAX,
	isId,
	leadOf,
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
	owesOf,
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

/** pi-queue's state holds something the page can't show (a status this file doesn't know): apply() replays instead. */
class CanonicalShape extends Error {}

const rec = (x: unknown): Record<string, unknown> | undefined =>
	x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;
const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** canonical-readers: pi-queue's owner pause ({at, why, by}) as applyHold keeps it ({at, why}). */
function holdOf(raw: unknown): UiTaskQueueHold | undefined {
	const h = rec(raw);
	const why = typeof h?.why === "string" ? h.why.trim().slice(0, HOLD_WHY_MAX) : "";
	return h && why ? { at: num(h.at), why } : undefined;
}

/** canonical-readers: pi-queue's TaskBlock as the "block", "poke", "remind", "chain" and "lead" changes keep it. */
function blockOf(b: Record<string, unknown>): UiTaskQueueBlock {
	const on = normTaskRefs(b.on);
	const need = needOf(b.need);
	const lead = leadOf(b.lead);
	const owes = lead ? owesOf(b.owes) : undefined;
	const checkpoint = lead ? timeOf(b.checkpoint) : undefined;
	const reminders = lead ? remindersOf(b.reminders) : undefined;
	const chain = lead ? chainOf(b.chain, lead) : undefined;
	const leadAt = lead ? timeOf(b.leadAt) : undefined;
	const answeredAt = lead ? timeOf(b.answeredAt) : undefined;
	const poke = rec(b.poke);
	const since = num(b.since);
	return {
		...(on ? { on } : {}),
		...(need ? { need } : {}),
		...(lead ? { lead } : {}),
		...(owes ? { owes } : {}),
		...(checkpoint !== undefined ? { checkpoint } : {}),
		...(reminders ? { reminders } : {}),
		...(leadAt !== undefined ? { leadAt } : {}),
		...(answeredAt !== undefined ? { answeredAt } : {}),
		since,
		start: numOr(b.start, since),
		tries: Math.max(0, Math.round(numOr(b.tries, 0))),
		...(chain ? { chain } : {}),
		...(poke
			? {
					poke: {
						at: num(poke.at),
						...(poke.ask === true ? { ask: true } : {}),
						...(poke.ask === true && poke.owner === true ? { owner: true } : {}),
						...(typeof poke.lead === "string" && poke.lead ? { lead: poke.lead } : {}),
						...(poke.home === true ? { home: true } : {}),
					},
				}
			: {}),
	};
}

/** canonical-readers: pi-queue's outside list (its OutsideAfter). */
function outsideOfQueue(raw: unknown): UiTaskQueueRef[] | undefined {
	const refs = normTaskRefs(raw);
	if (!refs || !Array.isArray(raw)) return undefined;
	return refs.map((r) => {
		const saved = raw.map(rec).find((x) => x?.file === r.file && x?.id === r.id);
		const over = rec(saved?.over);
		if (!over) return r;
		const why = typeof over.dropped === "string" ? oneLine(over.dropped, TASK_QUEUE_DROP_WHY_MAX) : "";
		return {
			...r,
			over: {
				at: num(over.at),
				...(over.removed === true || why ? { removed: true } : {}),
				...(why ? { dropped: why } : {}),
			},
		};
	});
}

/** canonical-readers: one of pi-queue's tasks (its QueueTask) as apply() keeps it. */
function taskOf(raw: unknown): Task {
	const c = rec(raw);
	if (!c || !isId(c.id) || !STATUSES.has(c.status as Status)) throw new CanonicalShape();
	const status = c.status as Status;
	const t: Task = { id: c.id, plan: planOf(c.plan), status, addedAt: num(c.addedAt) };
	const priority = normPriority(c.priority);
	if (priority) t.priority = priority;
	const origin = requesterOf(c.origin);
	if (origin) t.origin = origin;
	if (c.approval === "dialog" || c.approval === "auto") t.approval = c.approval;
	setParent(
		t,
		nextParent(undefined, {
			...(typeof c.project === "string" ? { project: c.project } : {}),
			...(typeof c.initiative === "string" ? { initiative: c.initiative } : {}),
			standalone: c.standalone === true,
		}),
	);
	const touches = normTouches(c.touches);
	if (touches) t.touches = touches;
	const tags = normTags(c.tags);
	if (tags?.length) t.tags = tags;
	const after = normAfter(c.after, c.id);
	if (after?.length) t.after = after;
	const profile = normProfile(c.profile);
	if (profile) t.profile = profile;
	const launch = normLaunch(c.launch);
	if (launch) t.launch = launch;
	if (c.launchPrepared === true) t.launchPrepared = true;
	if (typeof c.problem === "string" && c.problem) t.problem = c.problem.slice(0, 500);
	if (c.lane === true) t.lane = true;
	const chat = chatOf(c.chat);
	if (chat) t.chat = chat;
	if (status === "stuck" || status === "asking") {
		t.question = str(c.question, NOTE_MAX);
		const choices = normChoices(c.choices);
		if (choices.length) t.choices = choices;
	}
	if (status === "stuck") {
		const detail = detailOf(c.detail);
		if (detail) t.detail = detail;
		Object.assign(t, cardOf(c));
	}
	if (finite(c.stuckAt)) t.stuckAt = c.stuckAt;
	const ask = rec(c.ask);
	if (status === "asking" && ask?.to === "ops") {
		t.askOps = true;
		const lead = askLeadOf(ask.lead);
		if (lead) t.askLead = lead;
	}
	if (status === "working" && typeof c.answered === "number" && c.answered > 0) t.mainAnswered = true;
	const wait = rec(c.wait);
	if (status === "waiting" && wait) {
		const since = num(wait.since);
		t.wait = {
			what: str(wait.what, 200),
			check: str(wait.check, 1000),
			everyMs: numOr(wait.everyMs, DEFAULT_EVERY_MS),
			since,
			until: numOr(wait.until, since + DEFAULT_GIVE_UP_MS),
			...(finite(wait.overAt) ? { overAt: wait.overAt } : {}),
			...(wait.failed !== undefined && wait.failed !== "" ? { failed: cap(String(wait.failed), NOTE_MAX) } : {}),
		};
	}
	const block = rec(c.block);
	if (status === "blocked" && block) t.block = blockOf(block);
	const outside = outsideOfQueue(c.outside);
	if (outside) t.outside = outside;
	if (typeof c.summary === "string") t.summary = cap(c.summary, NOTE_MAX);
	else if (status === "done") t.summary = "";
	if (status === "done") {
		const delivery = deliveryOf(c.delivery);
		if (delivery) t.delivery = delivery;
	}
	const dropped = rec(c.dropped);
	if (dropped)
		t.dropped = { why: oneLine(dropped.why, TASK_QUEUE_DROP_WHY_MAX) || "no reason given", at: num(dropped.at) };
	const hold = holdOf(c.hold);
	if (hold) t.hold = hold;
	if (finite(c.heldFrom)) t.heldFrom = c.heldFrom;
	const back = rec(c.back);
	if (back) t.back = { from: num(back.from), to: num(back.to) };
	if (finite(c.startedAt)) t.startedAt = c.startedAt;
	if (finite(c.doneAt)) t.doneAt = c.doneAt;
	return t;
}

/** canonical-readers: pi-queue's QueueState as this file's State. */
function stateOf(raw: unknown, queueId: string | undefined): State {
	const q = rec(raw);
	if (!q || !Array.isArray(q.tasks)) throw new CanonicalShape();
	const s: State = {
		tasks: q.tasks.map(taskOf),
		running: q.running === true,
		lanes: finite(q.lanes)
			? Math.round(Math.min(TASK_QUEUE_MAX_LANES, Math.max(1, q.lanes)))
			: TASK_QUEUE_DEFAULT_LANES,
		autoApprove: q.autoApprove === true,
		autoStart: q.autoStart === true,
		queueId,
	};
	const profile = normProfile(q.profile);
	if (profile) s.profile = profile;
	if (PAUSE_REASONS.has(q.pausedReason as PauseReason)) s.pausedReason = q.pausedReason as PauseReason;
	const hold = holdOf(q.hold);
	if (hold) s.hold = hold;
	const from = chatOf(q.from);
	if (from) s.from = from;
	return s;
}

interface ReplaySlot {
	reader: unknown;
	prefix: TaskQueueEntryLike[];
	raw?: State;
	out: State;
}

const replayByLast = new WeakMap<object, Map<string, ReplaySlot>>();
const lastReadOf = new Map<string, { count: number; lastId: string | undefined }>();
const LAST_READS_KEPT = 4096;
const REPLAY_COUNTS_KEY = Symbol.for("pi-web-ui.task-queue.replay-counts.v1");

function replayCountsRecord(): Record<string, number> {
	const g = globalThis as Record<symbol, unknown>;
	let c = g[REPLAY_COUNTS_KEY] as Record<string, number> | undefined;
	if (!c) {
		c = {};
		g[REPLAY_COUNTS_KEY] = c;
	}
	return c;
}

function countReplay(source: string, outcome: string): void {
	const c = replayCountsRecord();
	const k = `${source} ${outcome}`;
	c[k] = (c[k] ?? 0) + 1;
}

/** H-QUEUE-REPLAY-3: a copy of replayState's counts so far. */
export function taskQueueReplayCounts(): Record<string, number> {
	return { ...replayCountsRecord() };
}

/** H-QUEUE-REPLAY-3: start replayState's counts again (tests). */
export function resetTaskQueueReplayCounts(): void {
	const c = replayCountsRecord();
	for (const k of Object.keys(c)) delete c[k];
}

function replaySource(entries: readonly TaskQueueEntryLike[]): "file" | "scan" | "branch" {
	if (entries[0]?.type === "session") return "file";
	return isQueueEntry(entries[0]) ? "scan" : "branch";
}

function replayKey(queueId: string | undefined): string {
	return queueId === undefined ? "\0" : `s:${queueId}`;
}

function cloneReplayState(s: State): State {
	const c = structuredClone(s);
	const fromId = (s.from as { id?: number } | undefined)?.id;
	if (c.from && typeof fromId === "number" && fromId > 0) {
		Object.defineProperty(c.from, "id", { value: fromId, enumerable: false, configurable: true });
	}
	return c;
}

function isPureAppend(
	prefix: readonly TaskQueueEntryLike[],
	entries: readonly TaskQueueEntryLike[],
	start = 0,
): boolean {
	if (entries.length - start < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (entries[start + i] !== prefix[i]) return false;
	}
	return true;
}

function bodyStart(entries: readonly TaskQueueEntryLike[]): number {
	return entries[0]?.type === "session" ? 1 : 0;
}

function entryIdOf(e: TaskQueueEntryLike | undefined): string | undefined {
	return typeof e?.id === "string" ? e.id : undefined;
}

type PassedOver = "other-entries" | "reader";

function findReplaySlot(
	entries: readonly TaskQueueEntryLike[],
	start: number,
	key: string,
	reader: unknown,
): { slot?: ReplaySlot; passed?: PassedOver } {
	let passed: PassedOver | undefined;
	for (let i = entries.length - 1; i >= start; i--) {
		const e = entries[i];
		if (!e || typeof e !== "object") continue;
		const slot = replayByLast.get(e)?.get(key);
		if (!slot || slot.prefix.length !== i - start + 1) continue;
		if (!isPureAppend(slot.prefix, entries, start)) passed ??= "other-entries";
		else if (slot.reader !== reader) passed ??= "reader";
		else return { slot, passed };
	}
	return { passed };
}

function keepReplaySlot(key: string, slot: ReplaySlot, formerLast?: TaskQueueEntryLike): void {
	const last = slot.prefix[slot.prefix.length - 1];
	if (formerLast && formerLast !== last && typeof formerLast === "object") {
		const m = replayByLast.get(formerLast);
		if (m?.get(key) === slot) {
			m.delete(key);
			if (m.size === 0) replayByLast.delete(formerLast);
		}
	}
	if (!last || typeof last !== "object") return;
	let m = replayByLast.get(last);
	if (!m) {
		m = new Map();
		replayByLast.set(last, m);
	}
	m.set(key, slot);
}

function missReason(
	read: string | undefined,
	entries: readonly TaskQueueEntryLike[],
	start: number,
	passed: PassedOver | undefined,
): string {
	const count = entries.length - start;
	if (count === 0) return "empty";
	if (passed) return passed;
	const last = read === undefined ? undefined : lastReadOf.get(read);
	if (!last) return "no-slot";
	if (count < last.count) return "fewer";
	if (last.lastId !== undefined && entryIdOf(entries[start + last.count - 1]) === last.lastId) return "re-read";
	return "other-entries";
}

function noteRead(read: string | undefined, entries: readonly TaskQueueEntryLike[], start: number): void {
	if (read === undefined || entries.length === start) return;
	lastReadOf.delete(read);
	lastReadOf.set(read, { count: entries.length - start, lastId: entryIdOf(entries[entries.length - 1]) });
	if (lastReadOf.size > LAST_READS_KEPT) {
		const oldest = lastReadOf.keys().next();
		if (!oldest.done) lastReadOf.delete(oldest.value);
	}
}

function emptyReplayState(queueId: string | undefined): State {
	return {
		tasks: [],
		running: false,
		lanes: TASK_QUEUE_DEFAULT_LANES,
		autoApprove: false,
		autoStart: false,
		queueId,
	};
}

function isQueueEntry(e: TaskQueueEntryLike | undefined): boolean {
	return !!e && e.type === "custom" && e.customType === TASK_QUEUE_ENTRY_TYPE;
}

function applyEntry(s: State, e: TaskQueueEntryLike): void {
	if (isQueueEntry(e)) apply(s, e.data);
}

export function replayState(entries: readonly TaskQueueEntryLike[], queueId: string | undefined): State {
	const readers = piQueueReaders();
	const readerFn = readers?.replay;
	const start = bodyStart(entries);
	const key = replayKey(queueId);
	const source = replaySource(entries);
	const read = queueId === undefined ? undefined : `${source} ${key}`;

	const found = findReplaySlot(entries, start, key, readerFn);
	const slot = found.slot;
	if (slot) {
		const kept = slot.prefix.length;
		const formerLast = slot.prefix[kept - 1];
		const outcome = entries.length - start > kept ? "appended" : "unchanged";
		let hasQueueEntry = false;
		for (let i = start + kept; i < entries.length; i++) {
			if (isQueueEntry(entries[i])) hasQueueEntry = true;
		}
		if (!hasQueueEntry) {
			for (let i = start + kept; i < entries.length; i++) slot.prefix.push(entries[i]);
			keepReplaySlot(key, slot, formerLast);
			countReplay(source, outcome);
			noteRead(read, entries, start);
			return slot.out;
		}
		if (readers) {
			try {
				const out = deepFreeze(stateOf(readers.replay(entries, queueId), queueId));
				for (let i = start + kept; i < entries.length; i++) slot.prefix.push(entries[i]);
				slot.out = out;
				keepReplaySlot(key, slot, formerLast);
				countReplay(source, outcome);
				noteRead(read, entries, start);
				return out;
			} catch {
				// Fall back to full apply() below.
			}
		} else if (slot.raw) {
			for (let i = start + kept; i < entries.length; i++) {
				applyEntry(slot.raw, entries[i]);
				slot.prefix.push(entries[i]);
			}
			slot.out = deepFreeze(cloneReplayState(slot.raw));
			keepReplaySlot(key, slot, formerLast);
			countReplay(source, outcome);
			noteRead(read, entries, start);
			return slot.out;
		}
	}

	const missed = slot ? "threw" : missReason(read, entries, start, found.passed);
	noteRead(read, entries, start);
	if (readers) {
		try {
			const out = deepFreeze(stateOf(readers.replay(entries, queueId), queueId));
			keepReplaySlot(key, { reader: readerFn, prefix: entries.slice(start), out });
			countReplay(source, missed);
			return out;
		} catch {
			// apply() below.
		}
	}
	countReplay(source, readers ? "threw" : missed);
	const raw = emptyReplayState(queueId);
	for (let i = 0; i < entries.length; i++) applyEntry(raw, entries[i]);
	const out = deepFreeze(cloneReplayState(raw));
	keepReplaySlot(key, { reader: undefined, prefix: entries.slice(start), raw, out });
	return out;
}
