// Q0 S3: inert adapter, fixed RTPI fixtures only. Never native receipts or chat/model access.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createRtpiFixtureCapability, type RtpiRef } from "../../server/rtpi-core.js";
import { rolesQueueSnapshot, type RolesQueueEnvelope, type RolesQueueInput } from "../../server/roles-queue.js";

const ref = (kind: string, id: string): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision: "1" });
const envelope: RolesQueueEnvelope = {
	eventId: "queue-event-1",
	source: ref("source", "q0-source"),
	issuer: ref("issuer", "q0-issuer"),
	subject: ref("subject", "role-ops"),
	lineage: ref("lineage", "q0-lineage"),
	incarnation: "q0-incarnation",
	sequence: 1,
	revision: 1,
	expectedRevision: 0,
	occurredAt: 1000,
};
const capability = createRtpiFixtureCapability({
	source: envelope.source,
	issuer: envelope.issuer,
	subject: envelope.subject,
	roots: ["rtpi/event/1"],
	facts: ["queue-snapshot"],
	policyAccepted: true,
	acceptedSidecars: [],
	seams: { inputHook: false, atomicOutbox: true, ownerPrincipal: false, confinedReader: false, issuerRegistry: true },
});
const qualification = {
	lineage: envelope.lineage,
	incarnation: envelope.incarnation,
	currentRevision: 0,
	currentSequence: 0,
	sourceCommitted: true,
	serverNow: 2000,
};
const options = { enabled: true, capability, qualification };
const fixture = (): RolesQueueInput => ({
	schema: "i-queue/1",
	binding: { queueId: "Q-A", sessionId: "Q-A", sessionEpoch: "epoch-1", branchId: "leaf-1", homeRevision: 1 },
	revision: "a".repeat(64),
	queueCoverage: "complete",
	runtimeCoverage: "complete",
	capacity: 4,
	working: 1,
	free: 3,
	counts: { ready: 240, working: 1, asking: 2, stuck: 3, waiting: 4, blocked: 5, done: 45, removed: 8 },
});

const canonicalModule = process.env.Q0_QUEUE_MODULE ?? resolve("../pi-queue/queue-projection.ts");

describe("I-QUEUE S3 C0 seam", () => {
	it.skipIf(!existsSync(canonicalModule))("cross-repo canonical DTO enters C0 without truncated totals", () => {
		// Plain native add-on code in Node, fixed synthetic operations; no SDK, model or live session.
		const script = `
			import { projectQueue } from ${JSON.stringify(pathToFileURL(canonicalModule).href)};
			const b = { queueId:'Q-A', sessionId:'Q-A', sessionEpoch:'epoch-1', branchId:'leaf-1', homeRevision:1 };
			const plan = { title:'fixed', goal:'g', doneWhen:'d', decided:'c', steps:'s', verify:'v', mustNot:'m' };
			const s = { binding:b, children:[], coverage:'complete', observedAt:1000,
				entries:Array.from({length:240},(_,i)=>({type:'custom',customType:'queue',data:{v:1,op:'add',id:i+1,plan,ts:900}})) };
			const p = projectQueue(s,b);
			const runtime = {binding:b,revision:p.revision,observedAt:1000,coverage:'complete',homeBusy:false,observations:[]};
			console.log(JSON.stringify(projectQueue(s,b,runtime)));
		`;
		const dto = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" }));
		expect(dto.pending).toHaveLength(200);
		expect(dto.index).toHaveLength(240);
		expect(dto.index[239].key).toEqual({
			queueId: "Q-A",
			sessionId: "Q-A",
			sessionEpoch: "epoch-1",
			branchId: "leaf-1",
			homeRevision: 1,
			taskId: 240,
			planRevision: 1,
		});
		const r = rolesQueueSnapshot(dto, envelope, options);
		if (r.verdict?.status !== "accepted") throw new Error("canonical DTO did not validate");
		expect(JSON.parse(r.verdict.canonical).body.counts.ready).toBe(240);
	});
	it("is off by default; disabling leaves inputs unchanged and writes nothing", () => {
		const p = fixture();
		const before = structuredClone(p);
		expect(rolesQueueSnapshot(p, envelope).state).toBe("off");
		expect(rolesQueueSnapshot(p, envelope, { ...options, enabled: false }).state).toBe("off");
		expect(p).toEqual(before);
	});
	it("accepts complete synthetic metadata, with full totals independent of display caps", () => {
		const p = fixture();
		const before = structuredClone(p);
		const r = rolesQueueSnapshot(p, envelope, options);
		expect(r.state).toBe("validated");
		expect(r.verdict?.status).toBe("accepted");
		if (r.verdict?.status !== "accepted") throw new Error("fixed snapshot did not validate");
		const text = r.verdict.canonical;
		const root = JSON.parse(text);
		expect(root.body).toEqual({
			fact: "queue-snapshot",
			status: "known",
			capacity: 4,
			occupied: 1,
			counts: { ready: 240, working: 1, asking: 2, stuck: 3, waiting: 4, blocked: 5, done: 45 },
			fullIndex: true,
			refs: [],
		});
		expect(root.context.queue.id).toBe("Q-A");
		expect(root.context.session.revision).toBe("leaf-1");
		expect(root.context.epoch).toMatchObject({ id: "epoch-1", revision: "1" });
		expect(Buffer.byteLength(text)).toBeLessThan(8192);
		expect(text).not.toContain("title");
		expect(text).not.toContain("/synthetic/");
		expect(p).toEqual(before);
	});
	it("fixture capability cannot mint native output; no native issuer/outbox means unavailable", () => {
		const native = {
			...envelope,
			source: { ...envelope.source, namespace: "rtpi-native" as const },
			issuer: { ...envelope.issuer, namespace: "rtpi-native" as const },
			subject: { ...envelope.subject, namespace: "rtpi-native" as const },
			lineage: { ...envelope.lineage, namespace: "rtpi-native" as const },
		};
		expect(rolesQueueSnapshot(fixture(), native, { enabled: true }).state).toBe("unavailable");
		expect(rolesQueueSnapshot(fixture(), native, options).state).not.toBe("validated");
	});
	for (const coverage of ["partial", "stale", "unknown"] as const)
		it(`${coverage} runtime cannot become live/zero/free`, () => {
			const r = rolesQueueSnapshot(
				{ ...fixture(), runtimeCoverage: coverage, working: null, free: null },
				envelope,
				options,
			);
			expect(r.state).toBe("unknown");
			if (r.verdict?.status !== "accepted") throw new Error("unknown fixture did not validate");
			const body = JSON.parse(r.verdict.canonical).body;
			expect(body.capacity).toBeNull();
			expect(body.occupied).toBeNull();
			expect(body.fullIndex).toBe(false);
			expect(Object.values(body.counts).every((v) => v === null)).toBe(true);
		});
	it("missing/unbound queue is unknown, no fabricated queue reference or default capacity", () => {
		expect(rolesQueueSnapshot(null, envelope, options)).toMatchObject({ state: "unknown", verdict: null });
		expect(rolesQueueSnapshot({ ...fixture(), binding: null }, envelope, options).state).toBe("unknown");
		expect(
			rolesQueueSnapshot({ ...fixture(), binding: { ...fixture().binding!, sessionEpoch: "old\n" } }, envelope, options)
				.state,
		).toBe("unknown");
	});
	it("rejects bad counts, forged free slots and changed source revision", () => {
		expect(rolesQueueSnapshot({ ...fixture(), free: 4 }, envelope, options).state).toBe("rejected");
		expect(
			rolesQueueSnapshot({ ...fixture(), counts: { ...fixture().counts!, done: -1 } }, envelope, options).state,
		).toBe("rejected");
		expect(rolesQueueSnapshot(fixture(), { ...envelope, expectedRevision: 2 }, options).state).toBe("rejected");
	});
	it("has no production importer, registration, store mutation, timer or dispatch hook", () => {
		for (const path of [
			"server/index.ts",
			"server/agent-service.ts",
			"server/roles-overview.ts",
			"server/roles-overview-tool.ts",
		]) {
			const code = readFileSync(path, "utf8");
			expect(code).not.toMatch(/from\s+["'][^"']*roles-queue/);
		}
		const code = readFileSync("server/roles-queue.ts", "utf8");
		expect(code).not.toMatch(/registerTool|appendFile|writeFile|setInterval|setTimeout|process\.env/);
	});
});
