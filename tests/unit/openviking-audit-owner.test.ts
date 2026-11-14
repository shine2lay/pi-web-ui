/**
 * R-AUDIT-OWNER-1 (spec-explorer-writes.md G7, spec.md §3; QA rm-27a4d002, backend #171): `/api/openviking/audit`
 * serves the owner's edit/delete rows only to a request that passes the owner check for reads, through the one gate
 * (owner-gate.ts, the explorer routes' gate). Without it `?owner_only=true` answers `403 OWNER_ONLY` and plain
 * `/audit` answers `200` with owner rows left out before `limit` and `owner_events: "withheld"`.
 */
import type { Request } from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenVikingOwnerAccess } from "../../server/openviking/owner-gate.js";
import { OWNER_ONLY_BODY } from "../../server/openviking/owner-session-types.js";
import { NOW } from "./openviking-daemon-fake.js";
import { explorerHarness, type ExplorerHarness } from "./openviking-explorer-harness.js";
import { FakePasskey } from "./openviking-owner-fakes.js";
import { PI_RP, ownerHarness, type OwnerHarness } from "./openviking-owner-harness.js";

const QA_NOTE = "viking://user/qa/memories/cases/c1.md";

let h: ExplorerHarness | null = null;
let o: OwnerHarness | null = null;
afterEach(async () => {
	await h?.close();
	await o?.close();
	h = null;
	o = null;
});

const roleRow = (minutesAgo: number) => ({
	timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
	action: "update",
	source: "lead_direct",
	role: "qa",
	uri: QA_NOTE,
	summary: "qa wrote",
});
const ownerRow = (action: "owner_edit" | "owner_delete", minutesAgo: number, id: string) => ({
	timestamp: new Date(NOW - minutesAgo * 60_000).toISOString(),
	role: "owner",
	source: "owner_explorer",
	action,
	operation_id: id,
	uri: QA_NOTE,
	outcome: "applied",
	undo_of: null,
	before_sha256: null,
	after_sha256: null,
	summary: "owner edited a note: 1 -> 2 bytes",
	diff: null,
	task_id: null,
	session_id: null,
});

/** Newest first: owner delete (1 min), role write (2), owner edit (3), role write (4). */
const start = async (gate: NonNullable<Parameters<typeof explorerHarness>[0]>["gate"]) => {
	h = await explorerHarness({ gate });
	h.seedChangelog([
		roleRow(4),
		ownerRow("owner_edit", 3, "op-1-0000000a"),
		roleRow(2),
		ownerRow("owner_delete", 1, "op-1-0000000b"),
	]);
	return h;
};
const OWNER_ACTIONS = ["owner_edit", "owner_delete"];
const ownerRows = (body: any) => body.events.filter((e: any) => OWNER_ACTIONS.includes(e.action));

describe("/audit without the owner check (R-AUDIT-OWNER-1)", () => {
	it("?owner_only=true: 403 OWNER_ONLY with the one refusal body", async () => {
		const x = await start("deny");
		const r = await x.call("GET", "/api/openviking/audit?owner_only=true&limit=50");
		expect([r.status, r.body]).toEqual([403, OWNER_ONLY_BODY]);
	});

	it("plain /audit: 200, owner rows left out, owner_events withheld", async () => {
		const x = await start("deny");
		const r = await x.call("GET", "/api/openviking/audit?limit=50");
		expect(r.status).toBe(200);
		expect(r.body.owner_events).toBe("withheld");
		expect(ownerRows(r.body)).toEqual([]);
		expect(r.body.events.map((e: any) => e.action)).toEqual(["role_memory_write", "role_memory_write"]);
	});

	it("the production default gate (no owner check wired) withholds too", async () => {
		const x = await start("production");
		const r = await x.call("GET", "/api/openviking/audit");
		expect([r.status, r.body.owner_events, ownerRows(r.body)]).toEqual([200, "withheld", []]);
		expect((await x.call("GET", "/api/openviking/audit?owner_only=true")).status).toBe(403);
	});

	it("withheld never returns an owner row, whatever limit, action or role is asked", async () => {
		const x = await start("deny");
		const newest = await x.call("GET", "/api/openviking/audit?limit=1");
		expect([newest.status, newest.body.owner_events]).toEqual([200, "withheld"]);
		// Left out before limit: the newest role row, not an empty list.
		expect(newest.body.events).toEqual([expect.objectContaining({ action: "role_memory_write", role: "qa" })]);
		for (const action of OWNER_ACTIONS) {
			const r = await x.call("GET", `/api/openviking/audit?action=${action}`);
			expect([r.status, r.body.owner_events, r.body.events]).toEqual([200, "withheld", []]);
		}
		for (const query of ["role=qa", "limit=500", "owner_only=false", "action=role_memory_write&limit=2"]) {
			const r = await x.call("GET", `/api/openviking/audit?${query}`);
			expect([r.status, r.body.owner_events, ownerRows(r.body)]).toEqual([200, "withheld", []]);
		}
	});
});

describe("/audit with the owner check passed", () => {
	it("plain /audit: owner rows included, owner_events included; owner_only and action filter them", async () => {
		const x = await start("allow");
		const all = await x.call("GET", "/api/openviking/audit?limit=50");
		expect([all.status, all.body.owner_events]).toEqual([200, "included"]);
		expect(all.body.events.map((e: any) => e.action)).toEqual([
			"owner_delete",
			"role_memory_write",
			"owner_edit",
			"role_memory_write",
		]);
		const mine = await x.call("GET", "/api/openviking/audit?owner_only=true");
		expect([mine.status, mine.body.owner_events]).toEqual([200, "included"]);
		expect(mine.body.events.map((e: any) => e.operation_id)).toEqual(["op-1-0000000b", "op-1-0000000a"]);
		const edits = await x.call("GET", "/api/openviking/audit?action=owner_edit");
		expect(edits.body.events.map((e: any) => e.operation_id)).toEqual(["op-1-0000000a"]);
	});

	it("asks the explorer's one gate for a read", async () => {
		const asked: OpenVikingOwnerAccess[] = [];
		const gate = (_req: Request, access: OpenVikingOwnerAccess) => {
			asked.push(access);
			return true;
		};
		const x = await start(gate);
		expect((await x.call("GET", "/api/openviking/audit")).body.owner_events).toBe("included");
		expect(asked).toEqual([{ kind: "read" }]);
	});

	it("a gate that throws withholds (fail closed); owner_only refuses", async () => {
		const x = await start(() => {
			throw new Error("boom");
		});
		const r = await x.call("GET", "/api/openviking/audit");
		expect([r.status, r.body.owner_events, ownerRows(r.body)]).toEqual([200, "withheld", []]);
		const mine = await x.call("GET", "/api/openviking/audit?owner_only=true");
		expect([mine.status, mine.body]).toEqual([403, OWNER_ONLY_BODY]);
	});
});

describe("/audit through the real passkey owner check", () => {
	it("no cookie: owner_only 403 OWNER_ONLY, plain withheld; a session: included", async () => {
		o = await ownerHarness();
		const refused = await o.call("GET", "/api/openviking/audit?owner_only=true", { origin: null });
		expect([refused.status, refused.text]).toEqual([403, JSON.stringify(OWNER_ONLY_BODY)]);
		const plain = await o.call("GET", "/api/openviking/audit", { origin: null });
		expect([plain.status, (plain.body as any).owner_events]).toEqual([200, "withheld"]);
		const cookie = await o.owned(new FakePasskey(PI_RP.rpID));
		const mine = await o.call("GET", "/api/openviking/audit?owner_only=true", { cookie, origin: PI_RP.origin });
		expect([mine.status, (mine.body as any).owner_events]).toEqual([200, "included"]);
		const all = await o.call("GET", "/api/openviking/audit", { cookie, origin: PI_RP.origin });
		expect([all.status, (all.body as any).owner_events]).toEqual([200, "included"]);
	});
});
