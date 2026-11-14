/**
 * showtell-owner-answer (server/owner-front-door.ts; ops #882 acceptance tests, built by ops #883): the owner's
 * Mark done or sent comments through pi-web-ui's /showtell/ front door become one `answer` record; a direct call,
 * an agent tool, a repeat or a forged receipt never write one. Real DecisionRecords on a temp dir, stand-in
 * proxy exchanges, no model call. Seam: ~/ops-checks/owner-answers-2026-11-13/showtell-seam.md.
 *
 * Ops #882 writes each case as `notBuilt(` (passing only while the stub throws); ops #883 turns every
 * `notBuilt(` into `it(` and never weakens or deletes an assertion.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DecisionRecords } from "../../server/decision-records.js";
import {
	type FrontDoorExchange,
	OWNER_FRONT_DOOR_NOT_BUILT,
	type OwnerActionReceipt,
	type OwnerActionRecordFields,
	type OwnerActionWatch,
	OwnerFrontDoor,
	RECEIPT_TTL_MS,
} from "../../server/owner-front-door.js";

/** Passes only while the seam is a stub; built, it fails and names what to do. */
function notBuilt(name: string, fn: () => unknown | Promise<unknown>): void {
	it(`[not built] ${name}`, async () => {
		let error: unknown;
		try {
			await fn();
		} catch (e) {
			error = e;
		}
		if (!(error instanceof Error) || error.message !== OWNER_FRONT_DOOR_NOT_BUILT) {
			throw new Error(
				`owner front door is built (or failed otherwise): turn this notBuilt( into it( (ops #883); got ${String(error)}`,
			);
		}
	});
}

const PLUGIN = "show-and-tell";
const T0 = Date.UTC(2025, 0, 2, 12);
const SHARER_SESSION = "01a00000-0000-7000-8000-000000000315";
const SHARER_FILE = `2025-01-02T11-00-00-000Z_${SHARER_SESSION}.jsonl`;
const SHOWTELL: OwnerActionWatch = {
	answeredIn: "showtell",
	actions: [
		{ method: "POST", path: "/api/docs/:doc/status", body: { status: "done" }, refField: "batch_id" },
		{ method: "POST", path: "/api/docs/:doc/send", refField: "batch_id" },
	],
};
const BROWSER = { "sec-fetch-site": "same-origin", "content-type": "application/json" };
const idFor = (source: string, ref: string) =>
	`dr-${createHash("sha1").update(`${source}\0${ref}`).digest("hex").slice(0, 12)}`;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Rig {
	door: OwnerFrontDoor;
	file: string;
	receipts: OwnerActionReceipt[];
	clock: { now: number };
	lines(): Record<string, unknown>[];
}
function rig(): Rig {
	const dir = mkdtempSync(join(tmpdir(), "owner-front-door-"));
	dirs.push(dir);
	const clock = { now: T0 };
	const records = new DecisionRecords(dir, { now: () => clock.now });
	let n = 0;
	const door = new OwnerFrontDoor({
		records,
		now: () => clock.now,
		newId: () => `fd-${++n}`,
		sessionFileOf: (id) => (id === SHARER_SESSION ? `/synthetic/sessions/${SHARER_FILE}` : undefined),
	});
	const receipts: OwnerActionReceipt[] = [];
	door.watch(PLUGIN, SHOWTELL, (r) => receipts.push(r));
	return {
		door,
		file: records.file,
		receipts,
		clock,
		lines: () =>
			existsSync(records.file)
				? readFileSync(records.file, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l) as Record<string, unknown>)
				: [],
	};
}

const markDone = (o: Partial<FrontDoorExchange> = {}): FrontDoorExchange => ({
	pluginId: PLUGIN,
	method: "POST",
	path: "/api/docs/d_mtpsg67izk/status",
	headers: BROWSER,
	body: { status: "done" },
	status: 200,
	responseText: JSON.stringify({ ok: true, status: "done", batch_id: "b_sgoxttej4o" }),
	...o,
});
const sendComments = (o: Partial<FrontDoorExchange> = {}): FrontDoorExchange => ({
	pluginId: PLUGIN,
	method: "POST",
	path: "/api/docs/d_3zmrwvqhsm/send",
	headers: BROWSER,
	body: {},
	status: 201,
	responseText: JSON.stringify({ batch_id: "b_gtfqa7ywlo", count: 2 }),
	...o,
});
const approvedFields = (o: Partial<OwnerActionRecordFields["doc"]> = {}): OwnerActionRecordFields => ({
	doc: {
		id: "d_mtpsg67izk",
		title: "The Memory page, redrawn as a memory explorer: build this?",
		version: 2,
		latestVersion: 2,
		kind: "approved",
		words: ["Approved"],
		link: "/showtell/#/d/d_mtpsg67izk",
		batchId: "b_sgoxttej4o",
		...o,
	},
	sharer: { sessionId: SHARER_SESSION, role: "design", chat: "Design #315" },
});
const commentFields = (): OwnerActionRecordFields => ({
	doc: {
		id: "d_3zmrwvqhsm",
		title: "Two blind picks",
		version: 1,
		latestVersion: 1,
		kind: "comments",
		words: ["i like M and Q", "second note,\n  kept as typed  "],
		link: "/showtell/#/d/d_3zmrwvqhsm",
		batchId: "b_gtfqa7ywlo",
	},
	sharer: { sessionId: SHARER_SESSION, role: "design", chat: "Design #308" },
});

describe("owner front door (ops #882 seam)", () => {
	notBuilt("Mark done through the front door: one receipt, then one owner answer record with his word", () => {
		const r = rig();
		r.door.observe(markDone());
		expect(r.receipts).toHaveLength(1);
		const receipt = r.receipts[0]!;
		expect(receipt).toMatchObject({
			pluginId: PLUGIN,
			answeredIn: "showtell",
			method: "POST",
			path: "/api/docs/d_mtpsg67izk/status",
			params: { doc: "d_mtpsg67izk" },
			ref: "showtell:b_sgoxttej4o",
			at: T0,
		});
		r.clock.now = T0 + 500;
		const res = r.door.record(PLUGIN, receipt.id, approvedFields());
		const id = idFor("answer", "showtell:b_sgoxttej4o");
		expect(res).toEqual({ ok: true, id, added: true });
		const lines = r.lines();
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			v: 1,
			id,
			source: "answer",
			from: "owner",
			how: "live",
			ask: "showtell",
			answeredIn: "showtell",
			ref: "showtell:b_sgoxttej4o",
			at: T0,
			to: "design",
			chat: "Design #315",
			file: SHARER_FILE,
			title: "The Memory page, redrawn as a memory explorer: build this?",
			summary: "Approved",
			doc: {
				id: "d_mtpsg67izk",
				version: 2,
				latestVersion: 2,
				kind: "approved",
				words: ["Approved"],
				link: "/showtell/#/d/d_mtpsg67izk",
				batchId: "b_sgoxttej4o",
				sharerSession: SHARER_SESSION,
			},
		});
		expect(r.door.recordIdFor("showtell:b_sgoxttej4o")).toBe(id);
	});

	notBuilt("a sent comment batch: his comments verbatim, in number order, joined as the summary", () => {
		const r = rig();
		r.door.observe(sendComments());
		expect(r.receipts.map((x) => [x.ref, x.params.doc])).toEqual([["showtell:b_gtfqa7ywlo", "d_3zmrwvqhsm"]]);
		const res = r.door.record(PLUGIN, r.receipts[0]!.id, commentFields());
		expect(res).toMatchObject({ ok: true, added: true });
		const [rec] = r.lines();
		expect(rec).toMatchObject({
			source: "answer",
			from: "owner",
			answeredIn: "showtell",
			ref: "showtell:b_gtfqa7ywlo",
			summary: "i like M and Q\nsecond note,\n  kept as typed  ",
			doc: { kind: "comments", words: ["i like M and Q", "second note,\n  kept as typed  "] },
		});
	});

	notBuilt("no receipt without the browser's same-origin header (a script on the machine, curl)", () => {
		const r = rig();
		r.door.observe(markDone({ headers: { "content-type": "application/json" } }));
		r.door.observe(markDone({ headers: { ...BROWSER, "sec-fetch-site": "cross-site" } }));
		expect(r.receipts).toEqual([]);
		expect(r.lines()).toEqual([]);
	});

	notBuilt("no receipt for a non-2xx answer, another path, another body value, or no ref field", () => {
		const r = rig();
		r.door.observe(markDone({ status: 409, responseText: JSON.stringify({ error: "conflict" }) }));
		r.door.observe(markDone({ body: { status: "open" }, responseText: JSON.stringify({ ok: true, status: "open" }) }));
		r.door.observe(markDone({ method: "GET" }));
		r.door.observe(
			markDone({ path: "/api/comments/c_1/agent-reply", responseText: JSON.stringify({ batch_id: "b_x" }) }),
		);
		r.door.observe(markDone({ path: "/api/docs/d_mtpsg67izk/working" }));
		r.door.observe(markDone({ responseText: JSON.stringify({ ok: true, status: "done" }) }));
		r.door.observe(markDone({ responseText: "not json" }));
		expect(r.receipts).toEqual([]);
	});

	notBuilt("no receipt for another plugin's proxy, which declared nothing", () => {
		const r = rig();
		r.door.observe(markDone({ pluginId: "notes" }));
		expect(r.receipts).toEqual([]);
	});

	notBuilt("an agent tool or a direct server call has no receipt: record() with a made-up id writes nothing", () => {
		const r = rig();
		const res = r.door.record(PLUGIN, "fd-made-up", approvedFields());
		expect(res.ok).toBe(false);
		expect(r.lines()).toEqual([]);
		expect(r.door.recordIdFor("showtell:b_sgoxttej4o")).toBeUndefined();
	});

	notBuilt("a receipt is single use, its own plugin's only, for its own doc, and expires", () => {
		const r = rig();
		r.door.observe(markDone());
		const id = r.receipts[0]!.id;
		expect(r.door.record("notes", id, approvedFields()).ok).toBe(false);
		expect(r.door.record(PLUGIN, id, approvedFields({ id: "d_other00001" })).ok).toBe(false);
		expect(r.lines()).toEqual([]);
		r.clock.now = T0 + RECEIPT_TTL_MS + 1;
		expect(r.door.record(PLUGIN, id, approvedFields()).ok).toBe(false);
		expect(r.lines()).toEqual([]);

		r.door.observe(markDone({ responseText: JSON.stringify({ ok: true, batch_id: "b_second0001" }) }));
		const second = r.receipts[1]!.id;
		expect(r.door.record(PLUGIN, second, approvedFields({ batchId: "b_second0001" }))).toMatchObject({ ok: true });
		expect(r.door.record(PLUGIN, second, approvedFields({ batchId: "b_second0001" })).ok).toBe(false);
		expect(r.lines()).toHaveLength(1);
	});

	notBuilt("the same batch again writes nothing and gives the same id", () => {
		const r = rig();
		r.door.observe(markDone());
		r.door.observe(markDone());
		expect(r.receipts).toHaveLength(2);
		const a = r.door.record(PLUGIN, r.receipts[0]!.id, approvedFields());
		const b = r.door.record(PLUGIN, r.receipts[1]!.id, approvedFields());
		const id = idFor("answer", "showtell:b_sgoxttej4o");
		expect(a).toEqual({ ok: true, id, added: true });
		expect(b).toEqual({ ok: true, id, added: false });
		expect(r.lines()).toHaveLength(1);
	});

	notBuilt("an unknown sharer session still writes the record, without a chat file", () => {
		const r = rig();
		r.door.observe(markDone());
		const fields = { ...approvedFields(), sharer: { sessionId: "unknown-session", role: "design" } };
		expect(r.door.record(PLUGIN, r.receipts[0]!.id, fields)).toMatchObject({ ok: true });
		const [rec] = r.lines();
		expect(rec).not.toHaveProperty("file");
		expect(rec).toMatchObject({ doc: { sharerSession: "unknown-session" } });
	});
});
