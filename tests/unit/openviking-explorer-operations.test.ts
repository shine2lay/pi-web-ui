/**
 * Memory Explorer operations (backend #163): spec-explorer-writes.md "Operation States", row by row (From, Event, To,
 * line appended), plus the per-uri lock (R-EXPLORER-WRITE-3) and timer cleanup. Runs against an in-memory store and
 * the manual clock; no daemon of any kind is called.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ExplorerOperations, type ExplorerNoteStore } from "../../server/openviking/explorer-operations.js";
import { parseExplorerUri } from "../../server/openviking/explorer-rules.js";
import type { OwnerExplorerChangelogLine } from "../../server/openviking/explorer-types.js";
import { EXPLORER_UNDO_WINDOW_MS, OpenVikingDashboardError } from "../../server/openviking/index.js";
import { manualClock, type ManualClock } from "./openviking-daemon-fake.js";

const NOTE = "viking://user/default/memories/preferences/backend_code.md";
const OTHER = "viking://user/default/memories/preferences/frontend_code.md";
const BEFORE = "rule one\n";
const AFTER = "rule one\nrule two\n";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}
function deferred(): Deferred {
	let resolve = () => {};
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
}

function setup(options: { append?: boolean } = {}) {
	const clock: ManualClock = manualClock();
	const notes = new Map<string, { content: string; modTimeMs: number }>([
		[NOTE, { content: BEFORE, modTimeMs: clock.now() - 60_000 }],
		[OTHER, { content: BEFORE, modTimeMs: clock.now() - 60_000 }],
	]);
	const calls: string[] = [];
	const failures: Partial<Record<"write" | "remove" | "stat", Error>> = {};
	const holds: Partial<Record<"write" | "remove", Deferred>> = {};
	const lines: OwnerExplorerChangelogLine[] = [];
	const note = (uri: string) => {
		const n = notes.get(uri);
		if (!n) throw new OpenVikingDashboardError("missing", 404, "NOT_FOUND");
		return n;
	};
	const store: ExplorerNoteStore = {
		stat: async ({ uri }) => {
			calls.push(`stat ${uri}`);
			if (failures.stat) throw failures.stat;
			const n = note(uri);
			return { isDir: false, size: Buffer.byteLength(n.content), modTime: new Date(n.modTimeMs).toISOString() };
		},
		read: async ({ uri }) => {
			calls.push(`read ${uri}`);
			return note(uri).content;
		},
		write: async ({ uri }, content) => {
			calls.push(`write ${uri}`);
			await holds.write?.promise;
			if (failures.write) throw failures.write;
			notes.set(uri, { content, modTimeMs: clock.now() });
		},
		remove: async ({ uri }) => {
			calls.push(`remove ${uri}`);
			await holds.remove?.promise;
			if (failures.remove) throw failures.remove;
			notes.delete(uri);
		},
	};
	let n = 0;
	const ops = new ExplorerOperations({
		store,
		clock,
		append: (line) => {
			lines.push(line);
			return options.append ?? true;
		},
		random: () => Uint8Array.of(0, 0, 0, ++n),
	});
	const openedAt = (uri = NOTE) => new Date(note(uri).modTimeMs).toISOString();
	const outcomes = () => lines.map((l) => `${l.action} ${l.outcome}`);
	return { clock, notes, calls, failures, holds, lines, ops, openedAt, outcomes };
}

const target = (uri = NOTE) => parseExplorerUri(uri);
const flush = () => new Promise((r) => setTimeout(r, 0));

async function refusal(promise: Promise<unknown> | (() => unknown)): Promise<OpenVikingDashboardError> {
	try {
		await (typeof promise === "function" ? promise() : promise);
	} catch (err) {
		if (err instanceof OpenVikingDashboardError) return err;
		throw err;
	}
	throw new Error("expected a refusal");
}

describe("explorer operations: delete rows", () => {
	it("(request) accepted -> pending, no line, nothing sent to the store", async () => {
		const t = setup();
		const res = await t.ops.requestDelete(target());
		expect(res).toMatchObject({ uri: NOTE, state: "pending" });
		expect(res.applies_at).toBe(new Date(t.clock.now() + EXPLORER_UNDO_WINDOW_MS).toISOString());
		expect(t.ops.stateOf(res.operation_id)).toBe("pending");
		expect(t.lines).toEqual([]);
		expect(t.calls).toEqual([`stat ${NOTE}`, `read ${NOTE}`]);
	});

	it("pending, window closes, store 200 -> applied, owner_delete applied", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS - 1);
		expect(t.calls.filter((c) => c.startsWith("remove"))).toEqual([]);
		t.clock.advance(1);
		await t.ops.shutdown();
		expect(t.ops.stateOf(operation_id)).toBe("applied");
		expect(t.calls.filter((c) => c.startsWith("remove"))).toEqual([`remove ${NOTE}`]);
		expect(t.outcomes()).toEqual(["owner_delete applied"]);
		expect(t.lines[0]).toMatchObject({
			operation_id,
			undo_of: null,
			before_sha256: sha(BEFORE),
			after_sha256: null,
			summary: `owner deleted a note: ${BEFORE.length} bytes`,
		});
		expect(t.notes.has(NOTE)).toBe(false);
	});

	it("pending, window closes, store error -> failed, owner_delete failed + code", async () => {
		const t = setup();
		t.failures.remove = new OpenVikingDashboardError("boom", 502, "MEMORY_ERROR", { upstream_code: "INTERNAL" });
		const { operation_id } = await t.ops.requestDelete(target());
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		await t.ops.shutdown();
		expect(t.ops.stateOf(operation_id)).toBe("failed");
		expect(t.outcomes()).toEqual(["owner_delete failed"]);
		expect(t.lines[0].summary).toContain("MEMORY_ERROR/INTERNAL");
		expect(t.notes.get(NOTE)?.content).toBe(BEFORE);
	});

	it("pending, undo asked -> undo_pending, no line; the window's end no longer deletes", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		const untilMs = t.clock.now() + 60_000;
		expect(t.ops.askUndo(operation_id, untilMs)).toBe("undo_pending");
		expect(t.lines).toEqual([]);
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		await flush();
		expect(t.ops.stateOf(operation_id)).toBe("undo_pending");
		expect(t.calls.some((c) => c.startsWith("remove"))).toBe(false);
	});

	it("undo_pending, assertion verified -> cancelled, owner_undo applied + owner_delete cancelled", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		t.ops.askUndo(operation_id, t.clock.now() + 60_000);
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS + 5_000);
		expect(await t.ops.undo(operation_id)).toEqual({ operation_id, state: "cancelled" });
		expect(t.outcomes()).toEqual(["owner_undo applied", "owner_delete cancelled"]);
		expect(t.lines[0]).toMatchObject({ operation_id, undo_of: "delete", before_sha256: null, after_sha256: null });
		expect(t.lines[1]).toMatchObject({ before_sha256: sha(BEFORE), after_sha256: sha(BEFORE) });
		expect(t.clock.pendingTimers()).toBe(0);
		expect(t.calls.some((c) => c.startsWith("remove"))).toBe(false);
	});

	it("undo_pending, challenge expires unused -> cancelled, owner_undo unconfirmed + owner_delete cancelled", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		t.ops.askUndo(operation_id, t.clock.now() + 60_000);
		t.clock.advance(60_000);
		expect(t.ops.stateOf(operation_id)).toBe("cancelled");
		expect(t.outcomes()).toEqual(["owner_undo unconfirmed", "owner_delete cancelled"]);
		expect(t.calls.some((c) => c.startsWith("remove"))).toBe(false);
		expect((await refusal(t.ops.undo(operation_id))).details).toEqual({ state: "cancelled" });
	});

	it("pending, server stops -> not_applied_restart, its line, never deleted later", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		await t.ops.shutdown();
		expect(t.ops.stateOf(operation_id)).toBe("not_applied_restart");
		expect(t.outcomes()).toEqual(["owner_delete not_applied_restart"]);
		expect(t.lines[0]).toMatchObject({ before_sha256: sha(BEFORE), after_sha256: sha(BEFORE) });
		expect(t.clock.pendingTimers()).toBe(0);
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		await t.ops.shutdown();
		expect(t.calls.some((c) => c.startsWith("remove"))).toBe(false);
		expect(t.lines).toHaveLength(1);
	});

	it("server stops while a delete is already at the store: waits for it, no restart line", async () => {
		const t = setup();
		t.holds.remove = deferred();
		const { operation_id } = await t.ops.requestDelete(target());
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		const stopped = t.ops.shutdown();
		await flush();
		expect(t.ops.stateOf(operation_id)).toBe("pending");
		t.holds.remove.resolve();
		await stopped;
		expect(t.outcomes()).toEqual(["owner_delete applied"]);
	});

	it("pending, undo without a confirmation ask -> cancelled, the timer is cleared", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		expect(t.clock.pendingTimers()).toBe(1);
		await t.ops.undo(operation_id);
		expect(t.clock.pendingTimers()).toBe(0);
		expect(t.outcomes()).toEqual(["owner_undo applied", "owner_delete cancelled"]);
	});
});

describe("explorer operations: edit rows", () => {
	it("(request) written -> edited, owner_edit applied with both hashes and byte counts only", async () => {
		const t = setup();
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		expect(res).toMatchObject({
			changed: true,
			uri: NOTE,
			before_sha256: sha(BEFORE),
			after_sha256: sha(AFTER),
			audit_recorded: true,
		});
		if (!res.changed) throw new Error("expected a change");
		expect(res.undo_until).toBe(new Date(t.clock.now() + EXPLORER_UNDO_WINDOW_MS).toISOString());
		expect(t.ops.stateOf(res.operation_id)).toBe("edited");
		expect(t.outcomes()).toEqual(["owner_edit applied"]);
		expect(t.lines[0]).toMatchObject({
			role: "owner",
			source: "owner_explorer",
			undo_of: null,
			diff: null,
			summary: `owner edited a note: ${BEFORE.length} -> ${AFTER.length} bytes`,
		});
		expect(JSON.stringify(t.lines)).not.toContain("rule two");
	});

	it("edited, undo with the note unchanged -> undone, owner_undo applied, the old text written back", async () => {
		const t = setup();
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		if (!res.changed) throw new Error("expected a change");
		t.clock.advance(5_000);
		expect(await t.ops.undo(res.operation_id)).toMatchObject({ operation_id: res.operation_id, state: "undone" });
		expect(t.notes.get(NOTE)?.content).toBe(BEFORE);
		expect(t.outcomes()).toEqual(["owner_edit applied", "owner_undo applied"]);
		expect(t.lines[1]).toMatchObject({ undo_of: "edit", before_sha256: sha(AFTER), after_sha256: sha(BEFORE) });
		expect(t.clock.pendingTimers()).toBe(0);
	});

	it("edited, undo with the note changed since -> undo_refused, owner_undo refused, nothing written", async () => {
		const t = setup();
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		if (!res.changed) throw new Error("expected a change");
		t.clock.advance(2_000);
		t.notes.set(NOTE, { content: "someone else\n", modTimeMs: t.clock.now() });
		const err = await refusal(t.ops.undo(res.operation_id));
		expect(err.code).toBe("UNDO_REFUSED");
		expect(err.details).toEqual({ current_mod_time: new Date(t.clock.now()).toISOString() });
		expect(t.ops.stateOf(res.operation_id)).toBe("undo_refused");
		expect(t.notes.get(NOTE)?.content).toBe("someone else\n");
		expect(t.outcomes()).toEqual(["owner_edit applied", "owner_undo refused"]);
		expect(t.calls.filter((c) => c.startsWith("write"))).toHaveLength(1);
		expect(t.clock.pendingTimers()).toBe(0);
	});

	it("edited, 10 s pass -> closed, no line; a later undo is 410 { state: closed }", async () => {
		const t = setup();
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		if (!res.changed) throw new Error("expected a change");
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS);
		expect(t.ops.stateOf(res.operation_id)).toBe("closed");
		expect(t.outcomes()).toEqual(["owner_edit applied"]);
		const err = await refusal(t.ops.undo(res.operation_id));
		expect([err.statusCode, err.code, err.details]).toEqual([410, "UNDO_WINDOW_CLOSED", { state: "closed" }]);
	});

	it("an edit's confirmation ask keeps its undo open until the challenge expires", async () => {
		const t = setup();
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		if (!res.changed) throw new Error("expected a change");
		expect(t.ops.askUndo(res.operation_id, t.clock.now() + 30_000)).toBe("edited");
		t.clock.advance(EXPLORER_UNDO_WINDOW_MS + 1_000);
		expect(t.ops.stateOf(res.operation_id)).toBe("edited");
		await t.ops.undo(res.operation_id);
		expect(t.ops.stateOf(res.operation_id)).toBe("undone");
	});

	it("same text -> changed:false, no operation, no write, no line", async () => {
		const t = setup();
		expect(await t.ops.edit(target(), BEFORE, t.openedAt())).toEqual({ changed: false });
		expect(t.calls.some((c) => c.startsWith("write"))).toBe(false);
		expect(t.lines).toEqual([]);
		expect(t.clock.pendingTimers()).toBe(0);
	});

	it("a failed append keeps the change and answers audit_recorded:false", async () => {
		const t = setup({ append: false });
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		expect(res).toMatchObject({ changed: true, audit_recorded: false });
		expect(t.notes.get(NOTE)?.content).toBe(AFTER);
	});

	it("a store refusal writes no line and leaves no operation", async () => {
		const t = setup();
		t.failures.write = new OpenVikingDashboardError("no", 502, "MEMORY_ERROR", { upstream_code: "DENIED" });
		const err = await refusal(t.ops.edit(target(), AFTER, t.openedAt()));
		expect([err.code, err.details]).toEqual(["MEMORY_WRITE_FAILED", { upstream_code: "MEMORY_ERROR/DENIED" }]);
		expect(t.lines).toEqual([]);
		expect(t.clock.pendingTimers()).toBe(0);
	});
});

describe("explorer operations: unknown ids, lock and pending deletes", () => {
	it("undo of an unknown id or a non-string is 404 OPERATION_UNKNOWN", async () => {
		const t = setup();
		for (const id of ["op-1-00000000", 42, undefined]) {
			const err = await refusal(t.ops.undo(id));
			expect([err.statusCode, err.code]).toEqual([404, "OPERATION_UNKNOWN"]);
		}
	});

	it("an edit or a second delete of a uri with a pending delete is 409 DELETE_PENDING", async () => {
		const t = setup();
		const { operation_id } = await t.ops.requestDelete(target());
		for (const attempt of [() => t.ops.edit(target(), AFTER, t.openedAt()), () => t.ops.requestDelete(target())]) {
			const err = await refusal(attempt());
			expect([err.code, err.details]).toEqual(["DELETE_PENDING", { operation_id }]);
		}
		expect(t.lines).toEqual([]);
	});

	it("two edits of one uri run one after the other: the second sees the first's write and is NOTE_CHANGED", async () => {
		const t = setup();
		t.holds.write = deferred();
		const opened = t.openedAt();
		const first = t.ops.edit(target(), AFTER, opened);
		const second = t.ops.edit(target(), "third text\n", opened);
		await flush();
		expect(t.calls).toEqual([`stat ${NOTE}`, `read ${NOTE}`, `write ${NOTE}`]);
		t.clock.advance(1_000);
		t.holds.write.resolve();
		expect(await first).toMatchObject({ changed: true });
		const err = await refusal(second);
		expect(err.code).toBe("NOTE_CHANGED");
		expect(t.notes.get(NOTE)?.content).toBe(AFTER);
		expect(t.outcomes()).toEqual(["owner_edit applied"]);
	});

	it("the lock is per uri: an edit of another note does not wait", async () => {
		const t = setup();
		const parked = deferred();
		t.holds.write = parked;
		const blocked = t.ops.edit(target(), AFTER, t.openedAt());
		await flush();
		t.holds.write = undefined; // the first write stays parked on `parked`
		const other = await t.ops.edit(target(OTHER), AFTER, t.openedAt(OTHER));
		expect(other).toMatchObject({ changed: true, uri: OTHER });
		expect(t.notes.get(NOTE)?.content).toBe(BEFORE);
		parked.resolve();
		expect(await blocked).toMatchObject({ changed: true, uri: NOTE });
	});

	it("a delete asked while an edit holds the lock waits for it, then is accepted", async () => {
		const t = setup();
		t.holds.write = deferred();
		const edit = t.ops.edit(target(), AFTER, t.openedAt());
		const del = t.ops.requestDelete(target());
		await flush();
		expect(t.calls.filter((c) => c.startsWith("stat"))).toHaveLength(1);
		t.holds.write.resolve();
		await edit;
		expect(await del).toMatchObject({ state: "pending" });
	});

	it("an edit undo while its note has a pending delete is 409 DELETE_PENDING, the edit stays open", async () => {
		const t = setup();
		const res = await t.ops.edit(target(), AFTER, t.openedAt());
		if (!res.changed) throw new Error("expected a change");
		await t.ops.requestDelete(target());
		const err = await refusal(t.ops.undo(res.operation_id));
		expect(err.code).toBe("DELETE_PENDING");
		expect(t.ops.stateOf(res.operation_id)).toBe("edited");
	});
});
