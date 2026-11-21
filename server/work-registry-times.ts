/**
 * work-registry-times (Ops #1056, Q-STALL-1; docs/stall-watch-contract.md, `StallExtra` "holds what the page lacks"): the times the stall rules
 * need that the work page doesn't carry, worked out from the registry's own events (pi-work-management's
 * events.jsonl). The watches get them from the one registry reader (work-registry-reader.ts), which hands each
 * line it reads to StallTimesBuilder.event in the same pass as the replay; stallTimesFrom does the same over a
 * text (the backtest, the tests).
 */

/** One item's times the page doesn't carry (ms). */
export interface StallTimes {
	/** Its last status or lead change. */
	statusAt?: number;
	/** The newest registry event about it or its tasks (a project's also count for its initiative). */
	eventAt?: number;
	/** An open task under it last closed or moved away; an initiative's also when an active project of it did. */
	leftAt?: number;
	/** Its last wait was ended early by a resume. */
	resumedAt?: number;
}

export const itemKey = (kind: "project" | "initiative", id: string) => `${kind}:${id}`;

const OPEN_STATES: ReadonlySet<string> = new Set(["ready", "working", "asking", "stuck", "waiting", "blocked"]);
/** Open: ready, working, asking, stuck, waiting or blocked; a link with no status recorded yet counts as open. */
export const isOpenState = (state: string | undefined): boolean => state === undefined || OPEN_STATES.has(state);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** The times, one parsed event at a time, in file order. Only events at or before upTo count (the backtest). */
export class StallTimesBuilder {
	readonly times = new Map<string, StallTimes>();
	/** Each project's initiative and status as the log says now. */
	private readonly projects = new Map<string, { initiative: string | null; status: string }>();
	/** Each link (queue, task, added): where it is and whether it is open. */
	private readonly links = new Map<string, { parent: string | undefined; open: boolean }>();

	constructor(private readonly upTo = Number.POSITIVE_INFINITY) {}

	private bump(key: string, field: keyof StallTimes, at: number): void {
		let t = this.times.get(key);
		if (!t) this.times.set(key, (t = {}));
		if (!((t[field] ?? -1) >= at)) t[field] = at;
	}

	/** Something happened about an item: a project's count for its initiative too. */
	private touch(key: string | undefined, at: number): void {
		if (!key) return;
		this.bump(key, "eventAt", at);
		if (key.startsWith("project:")) {
			const ini = this.projects.get(key.slice("project:".length))?.initiative;
			if (ini) this.bump(itemKey("initiative", ini), "eventAt", at);
		}
	}

	/** One parsed line of the log; anything that isn't a change it knows is left out. */
	event(e: unknown): void {
		if (!isObject(e) || e.v !== 1 || typeof e.op !== "string" || !isTime(e.ts) || e.ts > this.upTo) return;
		const at = e.ts;
		const [kind, act] = e.op.split(".");
		if (kind === "initiative" || kind === "project") {
			if (typeof e.id === "string") this.record(kind, act, e.id, e, at);
			return;
		}
		if (e.op !== "task.link" && e.op !== "task.state") return;
		const link = `${String(e.queue)}\u0000${String(e.task)}\u0000${String(e.added)}`;
		const was = this.links.get(link);
		if (e.op === "task.link") {
			const parent = parentKey(e.parent);
			const open = was ? was.open : true;
			if (was?.parent && was.parent !== parent) {
				this.touch(was.parent, at);
				if (was.open) this.bump(was.parent, "leftAt", at);
			}
			this.links.set(link, { parent, open });
			this.touch(parent, at);
			return;
		}
		if (!was) return;
		const open = isOpenState(typeof e.status === "string" ? e.status : undefined);
		this.touch(was.parent, at);
		if (was.parent && was.open && !open) this.bump(was.parent, "leftAt", at);
		this.links.set(link, { ...was, open });
	}

	private record(kind: "initiative" | "project", act: string, id: string, e: Record<string, unknown>, at: number) {
		const key = itemKey(kind, id);
		if (kind === "project" && act === "create") {
			this.projects.set(id, { initiative: typeof e.initiative === "string" ? e.initiative : null, status: "active" });
		}
		this.touch(key, at);
		if (act === "change" && isObject(e.changes)) {
			const ch = e.changes;
			if (ch.status !== undefined || ch.lead !== undefined) this.bump(key, "statusAt", at);
			const was = kind === "project" ? this.projects.get(id) : undefined;
			if (was) {
				const initiative =
					ch.initiative === undefined ? was.initiative : typeof ch.initiative === "string" ? ch.initiative : null;
				const status = typeof ch.status === "string" ? ch.status : was.status;
				// An active project closing or moving away leaves its initiative.
				if (was.initiative && was.status === "active" && (status !== "active" || initiative !== was.initiative)) {
					this.bump(itemKey("initiative", was.initiative), "leftAt", at);
				}
				this.projects.set(id, { initiative, status });
			}
		}
		if (act === "resume") this.bump(key, "resumedAt", at);
	}
}

function parentKey(p: unknown): string | undefined {
	if (!isObject(p)) return undefined;
	if (typeof p.project === "string") return itemKey("project", p.project);
	if (typeof p.initiative === "string") return itemKey("initiative", p.initiative);
	return undefined;
}

/** The times over a log's text (the backtest, the tests). A half-written last line and lines that aren't JSON
 *  are left out. */
export function stallTimesFrom(log: string, upTo = Number.POSITIVE_INFINITY): Map<string, StallTimes> {
	const b = new StallTimesBuilder(upTo);
	const lines = log.split("\n");
	lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			b.event(JSON.parse(line));
		} catch {
			continue;
		}
	}
	return b.times;
}
