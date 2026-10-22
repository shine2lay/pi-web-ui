// Ops #379 (H-LADDER-PRUNE-2): the approval ladder's store filled up and never emptied. An outbox entry whose hand-off E
// never confirmed (the clock was read before the transport ran, a lost acknowledgement, a settle that never committed)
// stayed "unknown" or "dispatching" for good, and prune() and rotation only free settled entries. Fixed cases (rule 16):
// such entries settle from the native store's own evidence and leave 5 h later; waiting and young ones stay; an open
// request and a live grant stay; history comes first; nothing is handed off twice; a clock that moves while a send is
// handed off no longer leaves it unconfirmed. Shared world: role-message-guard-host-harness.ts.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	GuardOutboxEntry,
	GuardStoreState,
	GuardTransportResult,
} from "../../server/role-message-guard-contract.js";
import type { GuardHistoryLine } from "../../server/role-message-guard-host.js";
import type { RoleMessageHost } from "../../server/role-messages.js";
import {
	A,
	ask,
	B,
	C,
	cooDecides,
	data,
	G,
	homes,
	now,
	send,
	setNow,
	useGuardWorld,
	world,
	type World,
} from "./role-message-guard-host-harness.js";

useGuardWorld();

const H = 3_600_000;
const M = 60_000;
const OPEN = ["context_needed", "awaiting_approver", "awaiting_owner", "rate_limited", "held"];

type Inner = {
	dispatch(entry: GuardOutboxEntry): Promise<GuardTransportResult>;
	store: { transact(...a: unknown[]): Promise<unknown> };
	state_(): Promise<GuardStoreState | null>;
};
const inner = (w: World) => w.host as unknown as Inner;
const stateOf = async (w: World) => (await inner(w).state_()) as GuardStoreState;
const entryOf = async (w: World, id: string) => (await stateOf(w)).outbox.find((o) => o.message.id === id);
const idOf = (r: unknown) => (r as { record: { id: string } }).record.id;
const historyPath = () => join(data, "role-message-guard", "history.jsonl");
type Line = GuardHistoryLine & { messageId?: string; before?: string; native?: string };
function settledLines(): Line[] {
	let raw = "";
	try {
		raw = readFileSync(historyPath(), "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Line)
		.filter((l) => (l.event as string) === "delivery_settled");
}
/** How many times a text reached a chat (a turn or an FYI note). */
const deliveries = (w: World, text: string) => w.got.filter((g) => g.text.includes(text)).length;

/** From now on every hand-off is stored natively but its acknowledgement is lost: E records "unknown". */
function loseAcks(w: World): () => void {
	const host = inner(w);
	const real = host.dispatch.bind(w.host);
	host.dispatch = async (entry) => {
		await real(entry);
		return { state: "unknown", reason: "synthetic lost acknowledgement" };
	};
	return () => {
		host.dispatch = real;
	};
}
/** The next hand-off is stored natively, then E's settle never commits (a crash): E keeps "dispatching". */
function crashAfterHandOff(w: World): void {
	const host = inner(w);
	const store = host.store;
	const realDispatch = host.dispatch.bind(w.host);
	const realTransact = store.transact.bind(store);
	let armed = false;
	host.dispatch = async (entry) => {
		const r = await realDispatch(entry);
		host.dispatch = realDispatch;
		armed = true;
		return r;
	};
	store.transact = async (...a: unknown[]) => {
		if (armed) {
			armed = false;
			store.transact = realTransact;
			throw new Error("synthetic crash after the hand-off");
		}
		return realTransact(...a);
	};
}
/** The next send is accepted, then its hand-off is never prepared (E refuses the step): E keeps "committed". */
function refuseNextHandOff(w: World): void {
	const store = inner(w).store;
	const real = store.transact.bind(store);
	let calls = 0;
	store.transact = async (...a: unknown[]) => {
		if (++calls === 2) {
			store.transact = real;
			throw new Error("synthetic refusal before the hand-off");
		}
		return real(...a);
	};
}
/** This chat stays busy (until restored, or a restart's fresh host): the native store keeps what is sent to it waiting. */
function busy(w: World, file: string): () => void {
	const host = (w.rm as unknown as { host: RoleMessageHost }).host;
	const deliver = host.deliver;
	const note = host.note;
	const later = { ok: false as const, busy: true, error: "synthetic busy chat" };
	host.deliver = async (f, text) => (f === file ? later : deliver.call(host, f, text));
	host.note = async (f, text) => (f === file ? later : note.call(host, f, text));
	return () => {
		host.deliver = deliver;
		host.note = note;
	};
}
/** a and b talk back and forth from a fresh root until the next send would be message `hop`. */
async function chainFrom(w: World, a: string, b: string, hop: number) {
	let [from, to] = [a, b];
	for (let h = 1; h < hop; h++) {
		expect(await send(w, from, homes()[from], to, {}, h === 1 ? "" : undefined), `hop ${h}`).toMatchObject({
			ok: true,
		});
		[from, to] = [to, from];
	}
	return { from, file: homes()[from], to };
}
async function restart(w: World): Promise<World> {
	w.rm.stop();
	w.host.stop();
	return world(w);
}

describe("ladder: stuck deliveries settle from the native store (#379)", () => {
	it("stale unknown and dispatching entries whose messages were delivered or replied leave after 5 h; waiting and young ones, an open request and a live grant stay; nothing is sent twice", async () => {
		const w = await world();
		const T0 = now;
		busy(w, G);
		let restore = loseAcks(w);
		// Each is stuck right after its own send (the next send's prune may already settle it).
		const s1 = idOf(await send(w, "alpha", A, "beta", { text: "stuck s1" }, ""));
		expect((await entryOf(w, s1))?.state).toBe("unknown");
		const s3 = idOf(await send(w, "alpha", A, "gamma", { text: "stuck s3" }, ""));
		expect((await entryOf(w, s3))?.state).toBe("unknown");
		// s4 waits in alpha's busy chat and is answered before it lands: it lands "replied".
		const freeAlpha = busy(w, A);
		const s4 = idOf(await send(w, "beta", B, "alpha", { text: "stuck s4" }, ""));
		expect((await entryOf(w, s4))?.state).toBe("unknown");
		restore();
		expect(await send(w, "alpha", A, "beta", { kind: "reply", replyTo: s4, text: "answer to s4" }, "")).toMatchObject({
			ok: true,
		});
		freeAlpha();
		await w.rm.tick();
		crashAfterHandOff(w);
		const s2 = idOf(await send(w, "beta", B, "coo", { kind: "fyi", text: "stuck s2" }, ""));
		expect((await entryOf(w, s2))?.state).toBe("dispatching");
		const before = await stateOf(w);
		const was = (id: string) => before.outbox.find((o) => o.message.id === id);
		expect([s1, s2, s3, s4].map((id) => w.rm.byId(id)?.state)).toEqual([
			"delivered",
			"delivered",
			"waiting",
			"replied",
		]);

		// T0 + 4 h: one more, young at the check.
		setNow(T0 + 4 * H);
		restore = loseAcks(w);
		const s5 = idOf(await send(w, "coo", C, "beta", { text: "stuck s5" }, ""));
		restore();
		expect((await entryOf(w, s5))?.state).toBe("unknown");

		// T0 + 4 h 30: an open request and a live grant (1 h).
		setNow(T0 + 4.5 * H);
		let at = await chainFrom(w, "coo", "beta", 7);
		const open = await ask(w, at.from, at.file, [at.to]);
		expect(open).toMatchObject({ ok: true });
		const openId = (open.details as { requestId: string }).requestId;
		at = await chainFrom(w, "alpha", "beta", 7);
		const asked = await ask(w, at.from, at.file, [at.to]);
		expect(await cooDecides(w, (asked.details as { requestId: string }).requestId, "requested_quantity")).toMatchObject(
			{ ok: true },
		);
		const mid = await stateOf(w);
		const request = mid.requests.find((r) => r.binding.requestId === openId);
		expect(OPEN).toContain(request?.state);
		const grant = mid.grants.find((g) => g.state === "approved");
		expect(grant).toBeDefined();

		// T0 + 5 h 10: the next send prunes.
		setNow(T0 + 5 * H + 10 * M);
		expect(await send(w, "gamma", G, "alpha", { text: "trigger" }, "")).toMatchObject({ ok: true });
		const after = await stateOf(w);
		const left = [s1, s2, s4];
		for (const id of left) {
			expect(
				after.outbox.some((o) => o.message.id === id),
				id,
			).toBe(false);
			expect(
				after.transactions.some(
					(t) => t.state === "committed" && t.result.state === "accepted" && t.result.receipt.messageId === id,
				),
				id,
			).toBe(false);
		}
		const leftOutbox = left.map((id) => `outbox:${was(id)?.receipt.outboxId}`);
		expect(after.audits.filter((a) => leftOutbox.includes(a.subjectId))).toEqual([]);
		// Still waiting natively: as it was. Young: settled, kept.
		expect(after.outbox.find((o) => o.message.id === s3)).toEqual(was(s3));
		expect((await entryOf(w, s5))?.state).toBe("handled");
		// The open request and the live grant are untouched.
		expect(after.requests.find((r) => r.binding.requestId === openId)).toEqual(request);
		expect(after.grants.find((g) => g.id === grant?.id)).toEqual(grant);
		// One metadata line per settled entry, written before it could leave; no words.
		const lines = settledLines();
		expect(lines.map((l) => l.messageId).sort()).toEqual([s1, s2, s4, s5].sort());
		expect(lines.find((l) => l.messageId === s4)).toMatchObject({
			before: "unknown",
			state: "handled",
			native: "replied",
		});
		expect(lines.find((l) => l.messageId === s2)).toMatchObject({
			before: "dispatching",
			state: "dispatched",
			native: "delivered",
		});
		expect(readFileSync(historyPath(), "utf8")).not.toContain("stuck");

		// Nothing was handed off twice, before or after a restart (gamma's chat is idle after it: s3's first delivery).
		const sent = [
			[s1, "stuck s1"],
			[s2, "stuck s2"],
			[s4, "stuck s4"],
			[s5, "stuck s5"],
		];
		for (const [id, text] of sent) expect(deliveries(w, text), id).toBe(1);
		expect(deliveries(w, "stuck s3")).toBe(0);
		const w2 = await restart(w);
		await w2.rm.tick();
		for (const [id, text] of sent) expect(deliveries(w2, text), id).toBe(1);
		expect(deliveries(w2, "stuck s3")).toBe(1);
		const ids = w2.rm.recent(0).map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(settledLines()).toHaveLength(4);
	});

	it("history first: while history.jsonl can't be written nothing settles; once it can, the line is there when the entry leaves", async () => {
		const w = await world();
		const T0 = now;
		const restore = loseAcks(w);
		const s1 = idOf(await send(w, "alpha", A, "beta", { text: "stuck h1" }, ""));
		restore();
		const stuck = await entryOf(w, s1);
		expect(stuck?.state).toBe("unknown");
		setNow(T0 + 5 * H + 10 * M);
		rmSync(historyPath(), { force: true });
		mkdirSync(historyPath());
		expect(await send(w, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, s1)).toEqual(stuck);
		expect(w.logs.some((l) => l.includes("history not written"))).toBe(true);
		rmSync(historyPath(), { recursive: true });
		expect(await send(w, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, s1)).toBeUndefined();
		expect(settledLines()).toMatchObject([{ messageId: s1, before: "unknown", state: "handled", native: "delivered" }]);
		expect(deliveries(w, "stuck h1")).toBe(1);
	});

	it("a send is confirmed by its own hand-off when the clock moves and other sends commit meanwhile (was left unknown or dispatching)", async () => {
		let tick = 0;
		const w = await world(undefined, { now: () => now + ++tick });
		const rs = await Promise.all([
			send(w, "alpha", A, "beta", { text: "m1" }, ""),
			send(w, "beta", B, "coo", { kind: "fyi", text: "m2" }, ""),
			send(w, "gamma", G, "alpha", { text: "m3" }, ""),
			send(w, "coo", C, "gamma", { text: "m4" }, ""),
		]);
		for (const r of rs) expect(r).toMatchObject({ ok: true });
		const s = await stateOf(w);
		for (const r of rs) {
			const e = s.outbox.find((o) => o.message.id === idOf(r));
			expect(e?.state, idOf(r)).toBe(e?.message.kind === "fyi" ? "dispatched" : "handled");
			// The transport's own confirmation, not the native store's evidence (which would also settle it later).
			expect(e?.lastEvidence?.sourceIncarnation, idOf(r)).toBe("native");
		}
		expect(settledLines()).toEqual([]);
	});

	it("past the native lifetime: a message the native store gave up on settles failed, and one accepted but never handed off settles failed a day after; neither is ever sent", async () => {
		const w = await world();
		const T0 = now;
		busy(w, G);
		const restore = loseAcks(w);
		const sw = idOf(await send(w, "alpha", A, "gamma", { text: "stuck w" }, ""));
		restore();
		refuseNextHandOff(w);
		expect(await send(w, "alpha", A, "beta", { text: "stuck c" }, "")).toMatchObject({
			ok: false,
			error: expect.stringContaining("not handed off yet"),
		});
		const sc = (await stateOf(w)).outbox.find((o) => o.state === "committed")?.message.id ?? "";
		expect(sc).not.toBe("");
		expect(w.rm.byId(sc)).toBeUndefined();

		setNow(T0 + 23 * H + 50 * M);
		expect(await send(w, "beta", B, "coo", {}, "")).toMatchObject({ ok: true });
		expect((await entryOf(w, sw))?.state).toBe("unknown");
		expect((await entryOf(w, sc))?.state).toBe("committed");

		setNow(T0 + 24 * H + 10 * M);
		await w.rm.tick(); // the native store gives up on the waiting one
		expect(w.rm.byId(sw)?.state).toBe("failed");
		expect(await send(w, "beta", B, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, sw)).toBeUndefined(); // failed at T0: settled and gone at once
		expect((await entryOf(w, sc))?.state).toBe("failed"); // absent a day after acceptance: kept 5 h from then
		setNow(T0 + 29 * H + 10 * M);
		expect(await send(w, "beta", B, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, sc)).toBeUndefined();
		expect(settledLines().map((l) => [l.messageId, l.before, l.state, l.native])).toEqual([
			[sw, "unknown", "failed", "failed"],
			[sc, "committed", "failed", "absent"],
		]);
		expect(deliveries(w, "stuck w")).toBe(0);
		expect(deliveries(w, "stuck c")).toBe(0);
		expect(w.rm.byId(sc)).toBeUndefined();
	});

	it("a record the native store dropped (finished) settles from its chain memory and leaves 5 h after the drop", async () => {
		const w = await world();
		const T0 = now;
		busy(w, G);
		const restore = loseAcks(w);
		const sd = idOf(await send(w, "alpha", A, "gamma", { text: "stuck d" }, ""));
		restore();
		// T0 + 1 h 10: a send prunes the hour-old charge (the store then refuses E's own late settle); still waiting.
		setNow(T0 + H + 10 * M);
		expect(await send(w, "beta", B, "coo", {}, "")).toMatchObject({ ok: true });
		expect((await entryOf(w, sd))?.state).toBe("unknown");
		// T0 + 2 h: 1000 old finished records behind ours; after the restart gamma's chat is idle.
		setNow(T0 + 2 * H);
		w.rm.stop();
		w.host.stop();
		const file = join(data, "role-messages.json");
		const stored = JSON.parse(readFileSync(file, "utf8")) as { messages: Array<Record<string, unknown>> };
		const m0 = stored.messages[0];
		for (let i = 0; i < 1000; i++)
			stored.messages.push({
				...m0,
				id: `rm-f${i.toString(16).padStart(7, "0")}`,
				from: { ...(m0.from as object), role: "filler" },
				to: "filler",
				at: now - 2 * 86_400_000,
				state: "delivered",
			});
		writeFileSync(file, JSON.stringify(stored));
		const w2 = await world(w);
		expect((await entryOf(w2, sd))?.state).toBe("unknown"); // the restart's reconcile couldn't settle it
		await w2.rm.tick(); // delivered, then dropped by the save (oldest finished record first)
		expect(w2.rm.byId(sd)).toBeUndefined();
		expect(w2.rm.chainFact(sd)).toBeDefined();
		expect(await send(w2, "coo", C, "alpha", { text: "trigger" }, "")).toMatchObject({ ok: true });
		expect(await entryOf(w2, sd)).toMatchObject({
			state: "handled",
			lastEvidence: { eventId: "native:dropped:delivered" },
		});
		setNow(T0 + 7 * H + 10 * M);
		expect(await send(w2, "coo", C, "alpha", { text: "trigger 2" }, "")).toMatchObject({ ok: true });
		expect(await entryOf(w2, sd)).toBeUndefined();
		expect(settledLines().map((l) => [l.messageId, l.native])).toEqual([[sd, "dropped:delivered"]]);
		expect(deliveries(w2, "stuck d")).toBe(1);
	});

	// Review of #379 (P2-1): the chain memory keeps how a dropped record ended, so one that failed is not read as done.
	it("a record the native store failed and then dropped settles failed from its chain memory and is never sent", async () => {
		const w = await world();
		const T0 = now;
		busy(w, G);
		const restore = loseAcks(w);
		const sf = idOf(await send(w, "alpha", A, "gamma", { text: "stuck f" }, ""));
		restore();
		setNow(T0 + H + 10 * M);
		expect(await send(w, "beta", B, "coo", {}, "")).toMatchObject({ ok: true });
		// 1000 old finished records behind ours; gamma's chat stays busy after the restart.
		w.rm.stop();
		w.host.stop();
		const file = join(data, "role-messages.json");
		const stored = JSON.parse(readFileSync(file, "utf8")) as { messages: Array<Record<string, unknown>> };
		const m0 = stored.messages[0];
		for (let i = 0; i < 1000; i++)
			stored.messages.push({
				...m0,
				id: `rm-f${i.toString(16).padStart(7, "0")}`,
				from: { ...(m0.from as object), role: "filler" },
				to: "filler",
				at: now - 2 * 86_400_000,
				state: "delivered",
			});
		writeFileSync(file, JSON.stringify(stored));
		const w2 = await world(w);
		busy(w2, G);
		expect(w2.rm.byId(sf)?.state).toBe("waiting");
		// T0 + 24 h 10: the native store gives up on it, and that save drops it (oldest finished record first).
		setNow(T0 + 24 * H + 10 * M);
		await w2.rm.tick();
		expect(w2.rm.byId(sf)).toBeUndefined();
		expect(w2.rm.chainFact(sf)).toBeDefined();
		expect((await entryOf(w2, sf))?.state).toBe("unknown");
		expect(await send(w2, "coo", C, "alpha", { text: "trigger" }, "")).toMatchObject({ ok: true });
		expect(await entryOf(w2, sf)).toMatchObject({
			state: "failed",
			lastEvidence: { eventId: "native:dropped:failed" },
		});
		setNow(T0 + 29 * H + 20 * M);
		expect(await send(w2, "coo", C, "alpha", { text: "trigger 2" }, "")).toMatchObject({ ok: true });
		expect(await entryOf(w2, sf)).toBeUndefined();
		expect(settledLines().map((l) => [l.messageId, l.before, l.state, l.native])).toEqual([
			[sf, "unknown", "failed", "dropped:failed"],
		]);
		expect(deliveries(w2, "stuck f")).toBe(0);
	});

	// Review of #379 (P2-3): the line is synced inside the send's transaction; when that commit then fails, nothing
	// changes, the line stays, and the next prune settles the entry without writing it again.
	it("a settle whose commit fails keeps its line and changes nothing; the next prune settles it without a second line", async () => {
		const w = await world();
		const T0 = now;
		const restore = loseAcks(w);
		const s1 = idOf(await send(w, "alpha", A, "beta", { text: "stuck x" }, ""));
		restore();
		const stuck = await entryOf(w, s1);
		expect(stuck?.state).toBe("unknown");
		setNow(T0 + 5 * H + 10 * M);
		const store = inner(w).store;
		const real = store.transact.bind(store);
		store.transact = async (...a: unknown[]) => {
			store.transact = real;
			const update = a[1] as (current: unknown) => Promise<unknown>;
			return real(a[0], async (current: unknown) => {
				await update(current);
				throw new Error("synthetic failure after the prune");
			});
		};
		expect(await send(w, "gamma", G, "coo", { text: "refused x" }, "")).toMatchObject({ ok: false });
		expect(await entryOf(w, s1)).toEqual(stuck);
		expect(settledLines().map((l) => l.messageId)).toEqual([s1]);
		expect(await send(w, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, s1)).toBeUndefined();
		expect(settledLines().map((l) => l.messageId)).toEqual([s1]);
		expect(deliveries(w, "stuck x")).toBe(1);
		expect(deliveries(w, "refused x")).toBe(0);
	});

	// Review of #379 (P2-3): an entry whose own reconcile is running is left to it.
	it("a prune leaves an entry alone while its own reconcile runs; a later prune settles it once", async () => {
		const w = await world();
		const T0 = now;
		const restore = loseAcks(w);
		const s1 = idOf(await send(w, "alpha", A, "beta", { text: "stuck q" }, ""));
		restore();
		const stuck = (await entryOf(w, s1)) as GuardOutboxEntry;
		expect(stuck.state).toBe("unknown");
		setNow(T0 + 5 * H + 10 * M);
		const host = w.host as unknown as {
			query(entry: GuardOutboxEntry): Promise<GuardTransportResult>;
			core: { reconcile(identity: unknown): Promise<unknown> };
		};
		const realQuery = host.query.bind(w.host);
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let asked = () => {};
		const queried = new Promise<void>((r) => {
			asked = r;
		});
		host.query = async (entry) => {
			if (entry.message.id === s1) {
				asked();
				await gate;
			}
			return realQuery(entry);
		};
		const running = host.core.reconcile(stuck.receipt.identity);
		await queried;
		expect(await send(w, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, s1)).toEqual(stuck);
		expect(settledLines()).toEqual([]);
		release();
		await running;
		host.query = realQuery;
		// Its own late settle is refused (the hour-old charge is gone), so it is still unknown here.
		expect((await entryOf(w, s1))?.state).toBe("unknown");
		expect(await send(w, "gamma", G, "coo", {}, "")).toMatchObject({ ok: true });
		expect(await entryOf(w, s1)).toBeUndefined();
		expect(settledLines().map((l) => [l.messageId, l.native])).toEqual([[s1, "delivered"]]);
		expect(deliveries(w, "stuck q")).toBe(1);
	});
});
