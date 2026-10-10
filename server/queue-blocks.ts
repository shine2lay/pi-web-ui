/**
 * queue-blocked: the background check for blocked tasks and outside `after`s (pi-queue's queue_blocked
 * and after "temper #38").
 *
 * A queued task in a chat of its own that waits on other tasks (in any queue) or needs something first
 * is "blocked" in its queue. Nobody may have to remember to tell it the blocker is gone: about once a
 * minute this server looks at every queue it watches, open or not, straight from the transcripts on
 * disk, and decides as pi-queue's blockVerdict does:
 *  - a task it waits on is still open: nothing (the panel shows how that task stands, "needs you" too);
 *  - all of them are done, or one was removed without finishing: due now;
 *  - a need in plain words (or blocked again on the same thing after a poke): due at start + 10, 30
 *    and 60 min, then it asks its main chat (pi-queue's ask path, queue-main-chat).
 * Due -> "/queue blocks" in the queue's chat (opened if it isn't): pi-queue looks again itself, records
 * the poke ("poke" op: saved in the queue, so a restart loses nothing) and gives the task its lane back
 * first once a slot is free. A ready task that comes after tasks in other queues gets the same nudge
 * once one of those is over, so its queue records that ("after_over") and starts it.
 *
 * Which queues: the ones pi-queue named (watchQueue, when a task blocks or a plan names an outside
 * task), plus every open queue showing one; kept in the client state across restarts. A queue with
 * nothing blocked and no outside after left is dropped.
 *
 * queue-paused: a task the owner paused, or any task of a queue he paused, is never nudged (no poke, no
 * ask); its queue stays watched, so it carries on once the pause is lifted. A paused task another task
 * waits on shows as paused (`held`) and doesn't count as needs-you.
 *
 * queue-why: a task in another queue that a ready task here comes after (an outside `after`), newly paused
 * by the owner or newly needing the user: the queue looks once too ("/queue blocks"), so pi-queue can tell
 * that queue's chat its task can't start until then (its note, once; pi-queue decides). Once per pause and
 * per question (`heldSeen`, kept across restarts); not for a waiter that is paused itself, or in a paused
 * queue. Block refs don't count: pi-queue has no such note for a blocked task (its Blocked line shows it).
 *
 * resolveRefs: what pi-queue asks when a task names tasks ("#12", "temper #38", "<queue chat title> #4"):
 * a role id means that role's home chat's queue, anything else a queue chat's title. Unknown refs, the
 * task itself and loops (through blocks and afters, in any queue) are refused.
 */

import type { UiTaskQueue, UiTaskQueueRef } from "./protocol.js";
import { type TaskQueueEntryLike, type TaskQueueTaskAny, taskQueueAll, taskQueueHeld } from "./task-queue.js";

/** How often the check runs (tests: PI_WEB_QUEUE_BLOCKS_MS). */
export function queueBlocksEveryMs(env: NodeJS.ProcessEnv = process.env): number {
	const ms = Number(env.PI_WEB_QUEUE_BLOCKS_MS);
	return Number.isFinite(ms) && ms >= 200 ? ms : 60_000;
}

/** pi-queue's BLOCK_POKES_MS (10, 30, 60 min), with its test override (PI_QUEUE_TEST_FAST=1 + PI_QUEUE_TEST_BLOCK_POKES_MS). */
export const BLOCK_POKES_MS: readonly number[] = [10 * 60_000, 30 * 60_000, 60 * 60_000];
export function blockPokesMs(env: NodeJS.ProcessEnv = process.env): readonly number[] {
	if (env.PI_QUEUE_TEST_FAST !== "1") return BLOCK_POKES_MS;
	const ms = String(env.PI_QUEUE_TEST_BLOCK_POKES_MS ?? "")
		.split(",")
		.map((x) => Number(x.trim()));
	return ms.length === BLOCK_POKES_MS.length && ms.every((x) => Number.isFinite(x) && x >= 0) ? ms : BLOCK_POKES_MS;
}

/** A nudge already sent is sent again after this long (its queue's chat may not have been reachable). */
export const RENUDGE_MS = 5 * 60_000;
/** How far a loop check walks (tasks), so a huge web of afters can't stall a tool call. */
const LOOP_WALK_MAX = 400;
const REF_NAME_MAX = 120;

/** A task ref as people write it (pi-queue's parseRef): "#12" or 12, "temper #38", "<title> #4". */
export function parseTaskRef(raw: unknown): { name: string; id: number } | undefined {
	if (typeof raw === "number") return Number.isInteger(raw) && raw > 0 ? { name: "", id: raw } : undefined;
	if (typeof raw !== "string") return undefined;
	const m = /^(.*?)\s*#?\s*(\d+)$/.exec(raw.replace(/\s+/g, " ").trim());
	if (!m) return undefined;
	const id = Number(m[2]);
	const name = m[1].trim();
	if (!Number.isInteger(id) || id < 1 || name.length > REF_NAME_MAX) return undefined;
	if (name && !/[\s#]\d+$/.test(raw.trim())) return undefined;
	return { name, id };
}

/** How a task stands in its queue; "gone" when the queue or the task can't be found. */
export type RefStatus = TaskQueueTaskAny["status"] | "gone";
export interface RefLook {
	status: RefStatus;
	title?: string;
	summary?: string;
	chat?: { file: string; title?: string };
	/** queue-paused: the owner paused it (or its whole queue): a task blocked on it waits quietly, and it
	 *  doesn't count as needs-you. */
	held?: boolean;
	/** queue-why: since when that pause (its own, else its queue's), when held. */
	heldAt?: number;
	/** queue-why: when it started needing the user, while it does (stuck). */
	stuckAt?: number;
}

/**
 * queue-why: which pause or question a task in another queue stands under, when only the owner or the user
 * can move it on (pi-queue's ownerOnly: paused by the owner, or needing the user). undefined otherwise.
 */
export function heldKey(r: { file: string; id: number }, l: RefLook | undefined): string | undefined {
	if (!l || l.status === "gone" || l.status === "done" || l.status === "removed") return undefined;
	if (l.held) return `${r.file}#${r.id}/paused/${l.heldAt ?? 0}`;
	if (l.status === "stuck") return `${r.file}#${r.id}/user/${l.stuckAt ?? 0}`;
	return undefined;
}
/** undefined: can't tell right now (unreadable). */
export type LookRef = (r: { file: string; id: number }) => RefLook | undefined;

export type BlockVerdict =
	{ kind: "wait"; needsYou: number } | { kind: "due"; at: number; why: "over" | "need" | "ask" };

/** pi-queue's blockVerdict: when the queue should look at a blocked task again. */
export function blockVerdict(
	b: { on?: { file: string; id: number }[]; need?: string; since: number; start: number; tries: number },
	look: LookRef,
	pokes: readonly number[] = BLOCK_POKES_MS,
): BlockVerdict {
	if (b.on?.length) {
		const looks = b.on.map((r) => look(r));
		const over = (l: RefLook | undefined) =>
			!!l && (l.status === "done" || l.status === "removed" || l.status === "gone");
		const gone = (l: RefLook | undefined) => !!l && (l.status === "removed" || l.status === "gone");
		if (looks.some(gone) || looks.every(over)) return { kind: "due", at: b.since, why: "over" };
		// queue-paused: a paused task waiting for an answer doesn't count as needs-you.
		return {
			kind: "wait",
			needsYou: looks.filter((l) => !l?.held && (l?.status === "stuck" || l?.status === "asking")).length,
		};
	}
	if (b.tries >= pokes.length) return { kind: "due", at: b.since, why: "ask" };
	return { kind: "due", at: Math.max(b.since, b.start + pokes[b.tries]), why: "need" };
}

/** What the check needs from the server. */
export interface QueueBlocksHost {
	now(): number;
	/** A chat's queue entries; null when its transcript is gone. Throws when it can't be read. */
	readQueue(file: string): Promise<TaskQueueEntryLike[] | null>;
	/** Its transcript's size and last change (cache key); undefined when it's gone. */
	stamp(file: string): { size: number; mtimeMs: number } | undefined;
	/** "/queue …" in the chat with that transcript, opened if it isn't (the queue host's runCommand). */
	runCommand(file: string, line: string): Promise<boolean>;
	/** Roles and their home chats (identity.json). */
	roles(): { id: string; homeChat?: string }[];
	/** Chats whose title may name a queue: [file, title]. */
	titledChats(): Promise<[string, string][]>;
	sameFile(a: string, b: string): boolean;
	loadWatch(): string[];
	saveWatch(files: string[]): void;
	/** queue-why: per watched queue, the paused / needing-the-user outside afters it has looked at (heldKey). */
	loadHeldSeen(): Record<string, string[]>;
	saveHeldSeen(seen: Record<string, string[]>): void;
	/** Something the panels show changed (how a blocker stands): windows get their queue again. */
	changed(): void;
	log(line: string): void;
}

interface Cached {
	size: number;
	mtimeMs: number;
	all: ReturnType<typeof taskQueueAll> | null;
}

export class QueueBlocks {
	private readonly cache = new Map<string, Cached>();
	private readonly watch: Set<string>;
	/** queue-why: per watched queue, the outside afters' pauses and questions it has looked at (heldKey). */
	private readonly heldSeen: Map<string, Set<string>>;
	/** Nudges sent: key -> when (file, task, what it was about). */
	private readonly nudged = new Map<string, number>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private ticking = false;
	/** Bumped when a looked-up task's state changes: the panels' cache key. */
	stamp = 0;
	private lastSig = "";

	constructor(private readonly host: QueueBlocksHost) {
		this.watch = new Set(host.loadWatch());
		this.heldSeen = new Map(Object.entries(host.loadHeldSeen()).map(([f, keys]) => [f, new Set(keys)]));
	}

	start(everyMs = queueBlocksEveryMs()): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), everyMs);
		this.timer.unref?.();
		// A first look soon after start: a blocker may have finished while the server was down.
		setTimeout(() => void this.tick(), Math.min(everyMs, 5000)).unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	watched(): string[] {
		return [...this.watch];
	}

	/** pi-queue's watchQueue: look at this queue from now on. */
	watchQueue(file: string): void {
		if (typeof file !== "string" || !file.startsWith("/") || this.watch.has(file)) return;
		this.watch.add(file);
		this.host.saveWatch([...this.watch]);
	}

	/** A queue as replayed from its transcript (cached while the file doesn't change). null: gone; undefined: unreadable. */
	private async read(file: string): Promise<Cached["all"] | undefined> {
		const st = this.host.stamp(file);
		if (!st) {
			this.cache.delete(file);
			return null;
		}
		const c = this.cache.get(file);
		if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.all;
		try {
			const entries = await this.host.readQueue(file);
			const all = entries ? taskQueueAll(entries) : null;
			this.cache.set(file, { ...st, all });
			return all;
		} catch {
			return undefined;
		}
	}

	/** A task in a queue from what was read (sync: only the cache). */
	private lookCached(r: { file: string; id: number }): RefLook | undefined {
		const c = this.cache.get(r.file);
		if (!c) return undefined;
		if (!c.all || c.all.from) return { status: "gone" };
		const t = c.all.tasks.find((x) => x.id === r.id);
		if (!t) return { status: "gone" };
		const hold = taskQueueHeld(t, c.all);
		return {
			status: t.status,
			title: t.plan.title,
			...(t.summary ? { summary: t.summary } : {}),
			...(t.chat ? { chat: t.chat } : {}),
			...(hold ? { held: true, heldAt: hold.at } : {}),
			...(t.status === "stuck" && t.stuckAt !== undefined ? { stuckAt: t.stuckAt } : {}),
		};
	}

	/** One round: look at every watched queue and nudge the ones with something due. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			await this.round();
		} catch (err) {
			this.host.log(`[queue-blocks] check failed: ${(err as Error)?.message ?? err}`);
		} finally {
			this.ticking = false;
		}
	}

	private async round(): Promise<void> {
		const now = this.host.now();
		const pokes = blockPokesMs();
		const drop: string[] = [];
		const sig: string[] = [];
		for (const file of [...this.watch]) {
			const q = await this.read(file);
			if (q === undefined) continue;
			if (q === null || q.from) {
				drop.push(file);
				continue;
			}
			const blocked = q.tasks.filter((t) => t.status === "blocked" && t.block);
			const outside = q.tasks.filter((t) => t.status === "ready" && t.outside?.some((o) => !o.over));
			if (!blocked.length && !outside.length) {
				drop.push(file);
				continue;
			}
			// Read every queue they wait on first, so lookCached knows them.
			for (const t of [...blocked, ...outside]) {
				for (const r of [...(t.block?.on ?? []), ...(t.outside ?? [])]) await this.read(r.file);
			}
			const look: LookRef = (r) => this.lookCached(r);
			const refSig = (r: { file: string; id: number }) => {
				const l = look(r);
				return `${r.file}#${r.id}:${l?.status ?? "?"}${l?.held ? ":held" : ""}`;
			};
			let due: string | undefined;
			for (const t of blocked) {
				const b = t.block!;
				for (const r of b.on ?? []) sig.push(refSig(r));
				// queue-paused: a paused task (or a task in a paused queue) is never poked or asked about; the
				// queue stays watched, so it carries on once the pause is lifted.
				if (b.poke || taskQueueHeld(t, q)) continue;
				const v = blockVerdict(b, look, pokes);
				if (v.kind === "due" && v.at <= now) due ??= `#${t.id}@${b.since}:${v.why}`;
			}
			for (const t of outside) {
				const over = (t.outside ?? []).filter((o) => {
					if (o.over) return false;
					const l = look(o);
					return !!l && (l.status === "done" || l.status === "removed" || l.status === "gone");
				});
				for (const o of t.outside ?? []) sig.push(refSig(o));
				if (over.length && !taskQueueHeld(t, q))
					due ??= `#${t.id}:after:${over.map((o) => `${o.file}#${o.id}`).join(",")}`;
			}
			// queue-why: tasks in other queues that ready tasks here come after, paused by the owner or needing the
			// user. One that's new makes this queue look once (pi-queue's note); a paused waiter doesn't count.
			const seen = this.heldSeen.get(file);
			const heldNow = new Set<string>();
			for (const t of outside) {
				if (taskQueueHeld(t, q)) continue;
				for (const o of t.outside ?? []) {
					if (o.over || this.host.sameFile(o.file, file)) continue;
					const l = look(o);
					// Can't tell right now (unreadable): what it was looked at for still stands.
					if (l === undefined) for (const k of seen ?? []) if (k.startsWith(`${o.file}#${o.id}/`)) heldNow.add(k);
					const k = heldKey(o, l);
					if (k) heldNow.add(k);
				}
			}
			const fresh = [...heldNow].filter((k) => !seen?.has(k)).sort();
			// Only what still stands is kept: a lifted pause or an answered question is forgotten.
			const keep = new Set([...(seen ?? [])].filter((k) => heldNow.has(k)));
			if (fresh.length) due = `${due ? `${due}; ` : ""}held:${fresh.join(",")}`;
			if (due) {
				const key = `${file}\u0001${due}`;
				const was = this.nudged.get(key);
				if (was === undefined || now - was >= RENUDGE_MS) {
					this.nudged.set(key, now);
					const ok = await this.host.runCommand(file, "/queue blocks");
					this.host.log(`[queue-blocks] ${ok ? "nudged" : "couldn't reach"} ${file} (${due})`);
					// Looked at once it got there; else again after RENUDGE_MS.
					if (ok) for (const k of fresh) keep.add(k);
				}
			}
			this.setHeldSeen(file, keep);
		}
		if (drop.length) {
			for (const f of drop) {
				this.watch.delete(f);
				this.setHeldSeen(f, new Set());
			}
			this.host.saveWatch([...this.watch]);
		}
		for (const [k, at] of this.nudged) if (now - at > 24 * 3600_000) this.nudged.delete(k);
		const s = sig.sort().join("\n");
		if (s !== this.lastSig) {
			this.lastSig = s;
			this.stamp++;
			this.host.changed();
		}
	}

	/** queue-why: keep these keys for this queue (none = it goes); saved only when they change. */
	private setHeldSeen(file: string, keys: Set<string>): void {
		const was = this.heldSeen.get(file);
		if ((was?.size ?? 0) === keys.size && [...keys].every((k) => was?.has(k))) return;
		if (keys.size) this.heldSeen.set(file, keys);
		else this.heldSeen.delete(file);
		this.host.saveHeldSeen(Object.fromEntries([...this.heldSeen].map(([f, ks]) => [f, [...ks].sort()])));
	}

	/**
	 * The panel's queue with what only the server knows: how each task in another queue stands (status,
	 * title, its chat) and when a need-only block is poked next. Changes `queue` in place; also starts
	 * watching a queue that shows a block or an outside after.
	 */
	enrich(file: string | undefined, queue: UiTaskQueue): void {
		const pokes = blockPokesMs();
		let shows = false;
		const fill = (r: UiTaskQueueRef) => {
			if (!r.name) return; // its own queue: task-queue.ts filled it in
			const l = this.lookCached(r);
			if (!l) return;
			r.status = l.status;
			if (l.title) r.title = l.title;
			if (l.chat) r.chat = l.chat;
			if (l.held) r.held = true;
		};
		for (const t of queue.tasks) {
			if (t.status === "blocked" && t.block) {
				shows = true;
				for (const r of t.block.on ?? []) fill(r);
				// queue-paused: a paused task gets no pokes, so there's no next one to show.
				if (!t.block.on?.length && !t.block.poke && !taskQueueHeld(t, queue)) {
					const v = blockVerdict(t.block, () => undefined, pokes);
					if (v.kind === "due") {
						t.block.nextPokeAt = v.at;
						if (v.why === "ask") t.block.nextIsAsk = true;
					}
				}
			}
			if (t.outside?.length) {
				if (t.status === "ready") shows = true;
				for (const r of t.outside) fill(r);
			}
		}
		if (shows && file && !queue.from) this.watchQueue(file);
	}

	/**
	 * pi-queue's queueRefs: resolve task refs for the queue whose chat is `file` and its task `self`
	 * (which also comes after `after` there). Refuses the lot with the reason when one can't be used.
	 */
	async resolveRefs(req: {
		file: string;
		self: number;
		refs: string[];
		after?: number[];
		why: "block" | "after";
	}): Promise<{ refs: (UiTaskQueueRef & { summary?: string })[] } | { problem: string }> {
		const own = req.file;
		const ownQ = await this.read(own);
		if (!ownQ || ownQ.from) return { problem: "this task's queue can't be read" };
		const roles = this.host.roles();
		let titled: [string, string][] | undefined;
		const out: (UiTaskQueueRef & { summary?: string })[] = [];
		for (const raw of req.refs) {
			const p = parseTaskRef(raw);
			if (!p) return { problem: `"${raw}" isn't a task; write "#12" or "temper #38"` };
			let file: string | undefined;
			let name = "";
			if (p.name) {
				const role = roles.find((r) => r.id.toLowerCase() === p.name.toLowerCase());
				if (role) {
					if (!role.homeChat) return { problem: `the role ${role.id} has no home chat, so it has no queue` };
					file = role.homeChat;
					name = role.id;
				} else {
					titled ??= await this.host.titledChats();
					const want = p.name.toLowerCase();
					const hits = titled.filter(([, t]) => t.trim().toLowerCase() === want);
					let files = [...new Set(hits.map(([f]) => f))];
					if (files.length > 1) {
						// Same title more than once: the one(s) holding a queue.
						const withQueue: string[] = [];
						for (const f of files) {
							const q = await this.read(f);
							if (q && !q.from && q.tasks.length) withQueue.push(f);
						}
						if (withQueue.length) files = withQueue;
					}
					if (files.length > 1)
						return { problem: `more than one chat is called "${p.name}"; use the role id, or rename one` };
					if (!files.length) {
						return {
							problem: `"${p.name}" isn't a role or a queue chat's title I know (roles: ${roles.map((r) => r.id).join(", ") || "none"})`,
						};
					}
					file = files[0];
					name = (hits.find(([f]) => f === files[0])?.[1] ?? p.name).trim();
				}
				if (this.host.sameFile(file, own)) {
					file = own;
					name = "";
				}
			} else {
				file = own;
			}
			const q = file === own ? ownQ : await this.read(file);
			if (!q) return { problem: `${p.name || "this queue"}'s chat can't be read` };
			if (q.from) return { problem: `"${p.name}" is a task's own chat, not a queue` };
			const t = q.tasks.find((x) => x.id === p.id);
			const label = `${name ? `${name} ` : ""}#${p.id}`;
			if (!t) return { problem: `${label} doesn't exist${name ? ` in ${name}'s queue` : ""}` };
			if (file === own && p.id === req.self) return { problem: `${label} is this task itself` };
			if (out.some((o) => o.file === file && o.id === p.id)) continue;
			out.push({
				file,
				name,
				id: p.id,
				status: t.status,
				title: t.plan.title,
				...(t.summary ? { summary: t.summary } : {}),
				...(t.chat ? { chat: t.chat } : {}),
			});
		}
		const loop = await this.loopThrough(own, req.self, out);
		if (loop) return { problem: `that makes a loop: ${loop} waits on this task (directly or through others)` };
		return { refs: out };
	}

	/** Whether any of `refs` waits on (own, self), through blocks, outside afters and afters, in any queue. */
	private async loopThrough(own: string, self: number, refs: UiTaskQueueRef[]): Promise<string | undefined> {
		const seen = new Set<string>();
		for (const start of refs) {
			const stack: { file: string; id: number }[] = [{ file: start.file, id: start.id }];
			while (stack.length && seen.size < LOOP_WALK_MAX) {
				const cur = stack.pop()!;
				if (cur.file === own && cur.id === self) return `${start.name ? `${start.name} ` : ""}#${start.id}`;
				const key = `${cur.file}#${cur.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const q = await this.read(cur.file);
				const t = q && !q.from ? q.tasks.find((x) => x.id === cur.id) : undefined;
				if (!t || t.status === "done" || t.status === "removed") continue;
				if (t.status === "blocked") for (const r of t.block?.on ?? []) stack.push({ file: r.file, id: r.id });
				if (t.status === "ready") {
					for (const o of t.outside ?? []) if (!o.over) stack.push({ file: o.file, id: o.id });
					for (const n of t.after ?? []) stack.push({ file: cur.file, id: n });
				}
			}
		}
		return undefined;
	}
}
