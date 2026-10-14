// M0 (#139): inert I-MESSAGE adapters and arrows on fixed synthetic metadata only. No chat file, SDK, model or
// model input is touched; every record is an rtpi-fixture record from a synthetic capability.
import { describe, expect, it } from "vitest";
import {
	createRtpiFixtureCapability,
	rtpiCanonical,
	type RtpiCapability,
	type RtpiFact,
	type RtpiRef,
	type RtpiSeams,
	type RtpiVerdict,
} from "../../server/rtpi-core.js";
import {
	ROLES_MESSAGE_SEAMS,
	rolesMessageAdmission,
	rolesMessageArrows,
	rolesMessageDelivery,
	rolesMessageInputSettlement,
	rolesWitness,
	type RolesAttemptIds,
	type RolesMessageEnvelope,
	type RolesMessageIndex,
	type RolesMessageMeta,
	type RolesMessageOptions,
	type RolesMessageTarget,
} from "../../server/roles-messages.js";

const ref = (kind: string, id: string): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision: "1" });
const SEAMS_ON: RtpiSeams = {
	inputHook: true,
	atomicOutbox: true,
	ownerPrincipal: false,
	confinedReader: false,
	issuerRegistry: true,
};
const cap = (name: string, facts: RtpiFact[], seams: RtpiSeams = SEAMS_ON): RtpiCapability =>
	createRtpiFixtureCapability({
		source: ref("source", `${name}-source`),
		issuer: ref("issuer", `${name}-issuer`),
		subject: ref("subject", "role-ops"),
		roots: ["rtpi/event/1"],
		facts,
		policyAccepted: true,
		acceptedSidecars: [],
		seams,
	});
const admissionCap = cap("admission", ["message-admitted", "message-replied"]);
const deliveryCap = cap("delivery", ["message-delivered"]);
const settleCap = cap("settle", ["message-included", "message-settled"]);
/** The input-settlement capability on today's native seams: T01 missing. */
const settleCapToday = cap("settle", ["message-included", "message-settled"], { ...SEAMS_ON, inputHook: false });

/** One synthetic native operation per record: revision/sequence n on the capability's lineage. */
function env(c: RtpiCapability, n: number, occurredAt = 1000): RolesMessageEnvelope {
	return {
		eventId: `ev-${n}`,
		source: c.source,
		issuer: c.issuer,
		subject: c.subject,
		lineage: ref("lineage", `${c.source.id}-lineage`),
		incarnation: "inc-1",
		sequence: n,
		revision: n,
		expectedRevision: n - 1,
		occurredAt,
	};
}
function opts(
	c: RtpiCapability,
	n: number,
	witness?: ReturnType<typeof rolesWitness>,
	success?: boolean,
): RolesMessageOptions {
	return {
		enabled: true,
		capability: c,
		qualification: {
			lineage: ref("lineage", `${c.source.id}-lineage`),
			incarnation: "inc-1",
			currentRevision: n - 1,
			currentSequence: n - 1,
			sourceCommitted: true,
			serverNow: 2000,
			includedWitness: witness ?? null,
			settledWitness: witness ?? null,
			settledSuccess: success ?? null,
		},
	};
}

const HOME: RolesMessageTarget = { sessionId: "S-ops-home", sessionEpoch: "E1", branchId: "B1", homeRevision: 3 };
const TASK: RolesMessageTarget = { sessionId: "S-ops-task-7", sessionEpoch: "E1", branchId: "B1", homeRevision: 3 };
const meta = (over: Partial<RolesMessageMeta> & { id: string }): RolesMessageMeta => ({
	schema: "i-message/1",
	kind: "request",
	route: "home",
	from: { role: "security", homeRevision: 1 },
	to: { role: "ops", homeRevision: 3 },
	target: HOME,
	task: null,
	replyTo: null,
	...over,
});
const home = meta({ id: "rm-home0001" });
const task = meta({
	id: "rm-task0001",
	route: "task",
	target: TASK,
	task: { queueId: "S-ops-home", taskId: 7, planRevision: 2 },
});
const fyi = meta({ id: "rm-fyi00001", kind: "fyi" });
const A = (turn: string, attempt: string): RolesAttemptIds => ({
	turnId: turn,
	runId: `run-${turn}`,
	attemptId: attempt,
});

/** Records builder: each call is a new native operation (its own revision n). */
function recorder() {
	let n = 0;
	const out: RtpiVerdict[] = [];
	const keep = (r: { verdict: RtpiVerdict | null; state: string; reason: string }) => {
		expect(r.state, r.reason).toBe("accepted");
		out.push(r.verdict!);
		return r.verdict!;
	};
	return {
		out,
		admit: (m: RolesMessageMeta) =>
			keep(rolesMessageAdmission("message-admitted", m, env(admissionCap, ++n), opts(admissionCap, n))),
		reply: (m: RolesMessageMeta) =>
			keep(rolesMessageAdmission("message-replied", m, env(admissionCap, ++n), opts(admissionCap, n))),
		deliver: (m: RolesMessageMeta, delivered = true) =>
			keep(rolesMessageDelivery(m, { revision: 1, delivered }, env(deliveryCap, ++n), opts(deliveryCap, n))),
		include: (m: RolesMessageMeta, a: RolesAttemptIds) => {
			const w = rolesWitness("rtpi-fixture", m.target!, a);
			return keep(
				rolesMessageInputSettlement(
					{ fact: "message-included", meta: m, attempt: a },
					env(settleCap, ++n),
					opts(settleCap, n, w),
				),
			);
		},
		settle: (target: RolesMessageTarget, a: RolesAttemptIds, outcome: "success" | "error" | "aborted") => {
			const w = rolesWitness("rtpi-fixture", target, a);
			return keep(
				rolesMessageInputSettlement(
					{ fact: "message-settled", settlement: { recipient: "ops", target, attempt: a, outcome } },
					env(settleCap, ++n),
					opts(settleCap, n, w, outcome === "success"),
				),
			);
		},
	};
}
const index = (messages: RolesMessageMeta[], over: Partial<RolesMessageIndex> = {}): RolesMessageIndex => ({
	messages,
	coverage: "complete",
	total: messages.length,
	currentHome: { ops: 3, security: 1 },
	...over,
});
const viewOf = (r: ReturnType<typeof rolesMessageArrows>, id: string) =>
	r.arrows.flatMap((a) => a.messages).find((m) => m.id === id)!;

describe("M0 adapters are off by default (adapter-disable undo)", () => {
	it("every adapter is off without enabled:true and builds no record", () => {
		const o = { capability: settleCap };
		expect(rolesMessageAdmission("message-admitted", home, env(admissionCap, 1), o).state).toBe("off");
		expect(rolesMessageDelivery(home, { revision: 1, delivered: true }, env(deliveryCap, 1), o).state).toBe("off");
		const r = rolesMessageInputSettlement(
			{ fact: "message-included", meta: home, attempt: A("T1", "A1") },
			env(settleCap, 1),
			{
				...o,
				enabled: false,
			},
		);
		expect(r).toEqual({ state: "off", reason: "message-adapter-off", verdict: null });
	});
	it("today's seams are C0's: T01 missing", () => {
		expect(ROLES_MESSAGE_SEAMS.inputHook).toBe(false);
	});
});

describe("T01 missing (today): processed stays unknown and the badge is blocked", () => {
	it("input-settlement refuses before building a record, even with inclusion-looking input", () => {
		for (const c of [settleCapToday, null]) {
			const r = rolesMessageInputSettlement(
				{ fact: "message-included", meta: home, attempt: A("T1", "A1") },
				env(settleCap, 1),
				{ enabled: true, capability: c },
			);
			expect(r).toEqual({ state: "unknown", reason: "input-hook-unsupported", verdict: null });
		}
	});
	it("arrows: every message unknown, ready false, blocked input-hook-unsupported", () => {
		const rec = recorder();
		rec.admit(home);
		rec.deliver(home);
		rec.include(home, A("T1", "A1"));
		rec.settle(HOME, A("T1", "A1"), "success");
		const r = rolesMessageArrows(index([home]), rec.out, settleCapToday);
		expect(r.badge).toEqual({ ready: false, blocked: "input-hook-unsupported" });
		expect(viewOf(r, home.id)).toMatchObject({
			processed: "unknown",
			reason: "input-hook-unsupported",
			inputBound: false,
		});
		expect(viewOf(r, home.id).pending).toBe(true);
	});
});

describe("F13/V03 positive: exact inclusion + successful SAME attempt, per receipt class", () => {
	it("home, task and FYI each processed only on their own receipts", () => {
		const rec = recorder();
		for (const m of [home, task, fyi]) {
			rec.admit(m);
			rec.deliver(m);
		}
		rec.include(home, A("T1", "A1"));
		rec.include(fyi, A("T1", "A1"));
		rec.settle(HOME, A("T1", "A1"), "success");
		rec.include(task, A("T9", "A1"));
		rec.settle(TASK, A("T9", "A1"), "success");
		const r = rolesMessageArrows(index([home, task, fyi]), rec.out, settleCap);
		expect(r.badge.ready).toBe(true);
		for (const id of [home.id, task.id, fyi.id])
			expect(viewOf(r, id)).toMatchObject({ processed: "processed", reason: "same-attempt-success", pending: false });
		const arrow = r.arrows.find((a) => a.from === "security" && a.to === "ops")!;
		expect(arrow.byClass).toEqual({
			home: { shown: 1, processed: 1 },
			task: { shown: 1, processed: 1 },
			fyi: { shown: 1, processed: 1 },
		});
		expect(viewOf(r, task.id).taskId).toBe(7);
	});
});

describe("V03/S04 negatives: none of these is processed", () => {
	const run = (build: (rec: ReturnType<typeof recorder>) => void, ms: RolesMessageMeta[] = [home]) => {
		const rec = recorder();
		build(rec);
		return rolesMessageArrows(index(ms), rec.out, settleCap);
	};
	const cases: [string, (rec: ReturnType<typeof recorder>) => void, string, string][] = [
		["admission only", (r) => r.admit(home), "unknown", "inclusion-unknown"],
		["header / delivered only", (r) => (r.admit(home), r.deliver(home)), "unknown", "inclusion-unknown"],
		[
			"idle: a settled success in a turn that never included it",
			(r) => (r.deliver(home), r.settle(HOME, A("T2", "A1"), "success")),
			"unknown",
			"inclusion-unknown",
		],
		[
			"empty error, same attempt",
			(r) => (r.include(home, A("T1", "A1")), r.settle(HOME, A("T1", "A1"), "error")),
			"not-processed",
			"same-attempt-error-or-abort",
		],
		[
			"abort, same attempt",
			(r) => (r.include(home, A("T1", "A1")), r.settle(HOME, A("T1", "A1"), "aborted")),
			"not-processed",
			"same-attempt-error-or-abort",
		],
		[
			"failed A1 (retry pending)",
			(r) => (r.include(home, A("T1", "A1")), r.settle(HOME, A("T1", "A1"), "error")),
			"not-processed",
			"same-attempt-error-or-abort",
		],
		[
			"retry A2 succeeded for an A1 inclusion",
			(r) => (r.include(home, A("T1", "A1")), r.settle(HOME, A("T1", "A2"), "success")),
			"unknown",
			"settled-different-attempt",
		],
		["settlement pruned", (r) => r.include(home, A("T1", "A1")), "unknown", "settlement-unknown"],
		[
			"compaction: included in T1, only a later turn settled",
			(r) => (r.include(home, A("T1", "A1")), r.settle(HOME, A("T2", "A1"), "success")),
			"unknown",
			"settlement-unknown",
		],
	];
	for (const [name, build, state, reason] of cases)
		it(name, () => {
			const v = viewOf(run(build), home.id);
			expect(v).toMatchObject({ processed: state, reason });
			expect(v.pending).toBe(true);
		});

	it("a reply arrived: it links a new id and arrow, the original stays unknown", () => {
		const reply = meta({
			id: "rm-reply001",
			kind: "reply",
			replyTo: home.id,
			from: { role: "ops", homeRevision: 3 },
			to: { role: "security", homeRevision: 1 },
			target: { sessionId: "S-sec-home", sessionEpoch: "E1", branchId: "B1", homeRevision: 1 },
		});
		const r = run((rec) => (rec.admit(home), rec.deliver(home), rec.reply(reply)), [home, reply]);
		expect(viewOf(r, home.id)).toMatchObject({ processed: "unknown", replies: [reply.id], pending: true });
		const back = r.arrows.find((a) => a.from === "ops" && a.to === "security")!;
		expect(back.messages.map((m) => m.id)).toEqual([reply.id]);
	});

	it("FYI without its own inclusion stays unknown while the home message in that turn is processed", () => {
		const r = run((rec) => (rec.include(home, A("T1", "A1")), rec.settle(HOME, A("T1", "A1"), "success")), [home, fyi]);
		expect(viewOf(r, home.id).processed).toBe("processed");
		expect(viewOf(r, fyi.id)).toMatchObject({ processed: "unknown", reason: "inclusion-unknown", receiptClass: "fyi" });
	});

	it("home-only producer: task and FYI-to-task messages stay unknown", () => {
		const fyiTask = meta({ ...task, id: "rm-fyitask1", kind: "fyi" });
		const r = run(
			(rec) => (rec.include(home, A("T1", "A1")), rec.settle(HOME, A("T1", "A1"), "success")),
			[home, task, fyiTask],
		);
		expect(viewOf(r, task.id).processed).toBe("unknown");
		expect(viewOf(r, fyiTask.id).processed).toBe("unknown");
	});

	it("a failed delivery is shown failed, not pending and not processed", () => {
		const v = viewOf(
			run((rec) => rec.deliver(home, false)),
			home.id,
		);
		expect(v).toMatchObject({ delivered: "failed", processed: "unknown", pending: false });
	});

	it("legacy record with no receipts: unknown, kept pending, nothing cleared", () => {
		const r = run(() => {});
		expect(viewOf(r, home.id)).toMatchObject({
			admitted: false,
			delivered: "unknown",
			processed: "unknown",
			pending: true,
		});
	});
});

describe("S02: tuple and stale home", () => {
	it("a message bound to an older home revision stays in its own stale arrow; new-home inclusion does not process it", () => {
		const oldTarget = { ...HOME, sessionId: "S-ops-old", homeRevision: 2 };
		const old = meta({ id: "rm-old00001", to: { role: "ops", homeRevision: 2 }, target: oldTarget });
		const rec = recorder();
		// The new home includes and settles a different message (and a forged new-home inclusion of the old id fails).
		rec.include(home, A("T1", "A1"));
		rec.settle(HOME, A("T1", "A1"), "success");
		rec.include({ ...old, to: { role: "ops", homeRevision: 3 }, target: HOME }, A("T1", "A1"));
		const r = rolesMessageArrows(index([home, old]), rec.out, settleCap);
		const staleArrow = r.arrows.find((a) => a.toHomeRevision === 2)!;
		expect(staleArrow.stale).toBe(true);
		expect(staleArrow.messages.map((m) => m.id)).toEqual([old.id]);
		expect(viewOf(r, old.id).processed).toBe("unknown");
		expect(r.arrows.find((a) => a.toHomeRevision === 3)!.messages.map((m) => m.id)).toEqual([home.id]);
	});
	it("a task receipt for another task id or queue does not count", () => {
		const rec = recorder();
		rec.include({ ...task, task: { ...task.task!, taskId: 8 } }, A("T9", "A1"));
		rec.include({ ...task, task: { ...task.task!, queueId: "S-other" } }, A("T9", "A1"));
		rec.settle(TASK, A("T9", "A1"), "success");
		expect(viewOf(rolesMessageArrows(index([task]), rec.out, settleCap), task.id).processed).toBe("unknown");
	});
	it("bad or partial bindings are unknown, never defaulted", () => {
		const bad = [
			{ ...home, target: null },
			{ ...home, target: { ...HOME, homeRevision: 9 } },
			{ ...task, task: null },
			{ ...home, task: task.task },
			{ ...home, kind: "reply" as const },
			{ ...home, id: "rm-x\n" },
			{ ...home, target: { ...HOME, sessionId: "/home/x/chat.jsonl" } },
		];
		for (const m of bad)
			expect(rolesMessageAdmission("message-admitted", m, env(admissionCap, 1), opts(admissionCap, 1)).reason).toBe(
				"message-binding-unknown",
			);
	});
});

describe("index honesty and windows", () => {
	it("a 100-row tail of a 1000-record store is partial: no totals", () => {
		const ms = Array.from({ length: 100 }, (_, i) => meta({ id: `rm-t${String(i).padStart(6, "0")}` }));
		const r = rolesMessageArrows(index(ms, { coverage: "partial", total: 1000 }), [], settleCap);
		expect(r).toMatchObject({ complete: false, total: null, shown: 100 });
		expect(r.arrows[0].pendingTotal).toBeNull();
	});
	it("a complete index claiming a total it doesn't hold is not complete", () => {
		const r = rolesMessageArrows(index([home], { total: 2 }), [], settleCap);
		expect(r).toMatchObject({ complete: false, total: null });
	});
	it("240 pending: 200 shown, full total carried", () => {
		const ms = Array.from({ length: 240 }, (_, i) => meta({ id: `rm-p${String(i).padStart(6, "0")}` }));
		const r = rolesMessageArrows(index(ms), [], settleCap);
		expect(r.arrows[0].pending).toHaveLength(200);
		expect(r.arrows[0].pendingTotal).toBe(240);
		expect(r.total).toBe(240);
	});
});

describe("V04 idempotence and V15 privacy", () => {
	it("same receipt rebuilt: same bytes and key; other bytes under the key is a conflict and stays unknown", () => {
		const a = rolesMessageAdmission("message-admitted", home, env(admissionCap, 1), opts(admissionCap, 1)).verdict!;
		const b = rolesMessageAdmission("message-admitted", home, env(admissionCap, 1), opts(admissionCap, 1)).verdict!;
		const c = rolesMessageAdmission(
			"message-admitted",
			home,
			env(admissionCap, 1, 1500),
			opts(admissionCap, 1),
		).verdict!;
		if (a.status !== "accepted" || b.status !== "accepted" || c.status !== "accepted") throw new Error("not accepted");
		expect(a.canonical).toBe(b.canonical);
		expect(a.dedupKey).toBe(c.dedupKey);
		expect(a.digest).not.toBe(c.digest);
		const rec = recorder();
		rec.include(home, A("T1", "A1"));
		rec.settle(HOME, A("T1", "A1"), "success");
		const r = rolesMessageArrows(index([home]), [a, b, c, ...rec.out], settleCap);
		expect(r.conflicts).toEqual([home.id]);
		expect(viewOf(r, home.id)).toMatchObject({ processed: "unknown", reason: "receipt-conflict" });
	});
	it("extra body, header, hash or path fields never reach a record", () => {
		const leaky = {
			...home,
			text: "SECRET-BODY",
			header: "[Role message rm-home0001]",
			hash: "a".repeat(40),
			file: "/home/shinelay/.pi/agent/sessions/x.jsonl",
			title: "Ops lead",
		} as RolesMessageMeta;
		const rec = recorder();
		for (const v of [rec.admit(leaky), rec.deliver(leaky), rec.include(leaky, A("T1", "A1"))]) {
			if (v.status !== "accepted") throw new Error("not accepted");
			for (const s of ["SECRET-BODY", "Role message", "a".repeat(40), "/home/", "jsonl", "Ops lead"])
				expect(v.canonical).not.toContain(s);
		}
	});
	it("records not made by C0 (copies, parsed JSON) are ignored", () => {
		const rec = recorder();
		rec.include(home, A("T1", "A1"));
		const settled = rec.settle(HOME, A("T1", "A1"), "success");
		const forged = [rec.out[0], JSON.parse(JSON.stringify(settled)) as RtpiVerdict];
		expect(viewOf(rolesMessageArrows(index([home]), forged, settleCap), home.id).processed).toBe("unknown");
	});
});

describe("old-code counterfactuals (each old rule fails a case the new code passes)", () => {
	type Legacy = { id: string; state: "waiting" | "delivered" | "replied" | "failed"; route: "home" | "task" };
	/** Old rule 1: treat the record state as processed (delivered = header found, replied = a reply linked). */
	const oldStateProcessed = (r: Legacy) => r.state === "delivered" || r.state === "replied";
	/** Old rule 2: roleReplyOf-style: any settled home turn after delivery processes every message to that role. */
	const oldHomeSettled = (_r: Legacy, homeTurnSettled: boolean) => homeTurnSettled;
	/** Old rule 3: count the protocol list (newest 100) as the whole index. */
	const oldTotal = (list: unknown[]) => list.length;

	it("old state map calls header-only and reply-arrived processed; new says unknown", () => {
		expect(oldStateProcessed({ id: home.id, state: "delivered", route: "home" })).toBe(true);
		expect(oldStateProcessed({ id: home.id, state: "replied", route: "home" })).toBe(true);
		const rec = recorder();
		rec.admit(home);
		rec.deliver(home);
		expect(viewOf(rolesMessageArrows(index([home]), rec.out, settleCap), home.id).processed).toBe("unknown");
	});
	it("old home settlement processes a task message and an idle/aborted turn; new does not", () => {
		expect(oldHomeSettled({ id: task.id, state: "delivered", route: "task" }, true)).toBe(true);
		const rec = recorder();
		rec.include(home, A("T1", "A1"));
		rec.settle(HOME, A("T1", "A1"), "aborted");
		rec.settle(HOME, A("T2", "A1"), "success");
		const r = rolesMessageArrows(index([home, task]), rec.out, settleCap);
		expect(viewOf(r, task.id).processed).toBe("unknown");
		expect(viewOf(r, home.id).processed).toBe("not-processed");
	});
	it("old list count reports 100 as the total; new reports none", () => {
		const ms = Array.from({ length: 100 }, (_, i) => meta({ id: `rm-c${String(i).padStart(6, "0")}` }));
		expect(oldTotal(ms)).toBe(100);
		expect(rolesMessageArrows(index(ms, { coverage: "partial", total: 1000 }), [], settleCap).total).toBeNull();
	});
	it("whole-ref witness: same ids with another session revision (branch) do not match", () => {
		const rec = recorder();
		rec.include(home, A("T1", "A1"));
		rec.settle({ ...HOME, branchId: "B2" }, A("T1", "A1"), "success");
		const r = rolesMessageArrows(index([home]), rec.out, settleCap);
		expect(viewOf(r, home.id).processed).toBe("unknown");
		expect(rtpiCanonical(rolesWitness("rtpi-fixture", HOME, A("T1", "A1")).session)).not.toBe(
			rtpiCanonical(rolesWitness("rtpi-fixture", { ...HOME, branchId: "B2" }, A("T1", "A1")).session),
		);
	});
});

// H-ROLES-M0-2: each case fails on afdf36af (the first M0 land) and passes after the review fix.
describe("H-ROLES-M0-2 review: no answer by record order, repeat or missing registry entry", () => {
	const arrowsOf = (build: (rec: ReturnType<typeof recorder>) => void, ms: RolesMessageMeta[] = [home]) => {
		const rec = recorder();
		build(rec);
		return rolesMessageArrows(index(ms), rec.out, settleCap);
	};

	it("(a) a failed delivery and a successful one, in either order: delivered and still pending", () => {
		for (const order of [
			[false, true],
			[true, false],
		]) {
			const r = arrowsOf((rec) => order.forEach((ok) => rec.deliver(home, ok)));
			expect(viewOf(r, home.id), String(order)).toMatchObject({
				delivered: "yes",
				processed: "unknown",
				pending: true,
			});
			expect(r.arrows[0].pendingTotal).toBe(1);
		}
		// Failures only: still failed and not pending.
		const f = arrowsOf((rec) => (rec.deliver(home, false), rec.deliver(home, false)));
		expect(viewOf(f, home.id)).toMatchObject({ delivered: "failed", pending: false });
	});

	it("(b) settlements of the included attempt that disagree: unknown receipt-conflict, whichever comes first", () => {
		const orders: ("success" | "error")[][] = [
			["success", "error"],
			["error", "success"],
		];
		for (const order of orders) {
			const r = arrowsOf((rec) => {
				rec.include(home, A("T1", "A1"));
				for (const o of order) rec.settle(HOME, A("T1", "A1"), o);
			});
			expect(viewOf(r, home.id), order.join()).toMatchObject({ processed: "unknown", reason: "receipt-conflict" });
			expect(r.conflicts).toEqual([home.id]);
		}
	});

	it("(b) a settlement rebuilt with other bytes under the same key is a conflict; the same bytes again are not", () => {
		const rec = recorder();
		rec.include(home, A("T1", "A1")); // revision 1
		const s = rec.settle(HOME, A("T1", "A1"), "success"); // revision 2
		const w = rolesWitness("rtpi-fixture", HOME, A("T1", "A1"));
		const other = rolesMessageInputSettlement(
			{
				fact: "message-settled",
				settlement: { recipient: "ops", target: HOME, attempt: A("T1", "A1"), outcome: "success" },
			},
			env(settleCap, 2, 1500),
			opts(settleCap, 2, w, true),
		).verdict!;
		if (s.status !== "accepted" || other.status !== "accepted") throw new Error("not accepted");
		expect(other.dedupKey).toBe(s.dedupKey);
		expect(other.digest).not.toBe(s.digest);
		const same = rolesMessageArrows(index([home]), [...rec.out, s], settleCap);
		expect(viewOf(same, home.id).processed).toBe("processed");
		expect(same.conflicts).toEqual([]);
		const r = rolesMessageArrows(index([home]), [...rec.out, other], settleCap);
		expect(viewOf(r, home.id)).toMatchObject({ processed: "unknown", reason: "receipt-conflict" });
		expect(r.conflicts).toEqual([home.id]);
	});

	it("(b) a conflict on another attempt leaves a message processed on its own clean attempt", () => {
		const r = arrowsOf((rec) => {
			rec.include(home, A("T1", "A1"));
			rec.settle(HOME, A("T1", "A1"), "success");
			rec.settle(HOME, A("T2", "A9"), "success");
			rec.settle(HOME, A("T2", "A9"), "error");
		});
		expect(viewOf(r, home.id)).toMatchObject({ processed: "processed" });
		expect(r.conflicts).toEqual([]);
	});

	it("(c) stale is null without the role's own current home in the registry", () => {
		const homes: Record<string, number>[] = [{}, { security: 1 }, { ops: 0 }];
		for (const currentHome of homes)
			expect(rolesMessageArrows(index([home], { currentHome }), [], settleCap).arrows[0].stale).toBeNull();
		for (const role of ["constructor", "__proto__", "toString"]) {
			const m = meta({ id: "rm-proto001", to: { role, homeRevision: 3 } });
			const r = rolesMessageArrows(index([m], { currentHome: { ops: 3 } }), [], settleCap);
			expect(r.arrows[0].stale, role).toBeNull();
		}
		expect(rolesMessageArrows(index([home]), [], settleCap).arrows[0].stale).toBe(false);
		expect(rolesMessageArrows(index([home], { currentHome: { ops: 4 } }), [], settleCap).arrows[0].stale).toBe(true);
	});

	it("(d) an id listed twice: shown once, index not complete, still processed on its exact receipts", () => {
		const r = arrowsOf(
			(rec) => (rec.include(home, A("T1", "A1")), rec.settle(HOME, A("T1", "A1"), "success")),
			[home, home],
		);
		expect(r).toMatchObject({ complete: false, total: null, shown: 1 });
		expect(r.arrows).toHaveLength(1);
		expect(r.arrows[0].messages.map((m) => m.id)).toEqual([home.id]);
		expect(r.arrows[0].byClass.home).toEqual({ shown: 1, processed: 1 });
		expect(r.arrows[0].pendingTotal).toBeNull();
		expect(viewOf(r, home.id).processed).toBe("processed");
	});

	it("(d) two index entries for one id that disagree: one arrow, unknown index-conflict", () => {
		const moved = meta({
			id: home.id,
			to: { role: "security", homeRevision: 1 },
			target: { sessionId: "S-sec-home", sessionEpoch: "E1", branchId: "B1", homeRevision: 1 },
		});
		const r = arrowsOf(
			(rec) => (rec.include(home, A("T1", "A1")), rec.settle(HOME, A("T1", "A1"), "success")),
			[home, moved],
		);
		expect(r).toMatchObject({ complete: false, total: null, shown: 1 });
		expect(r.arrows).toHaveLength(1);
		expect(viewOf(r, home.id)).toMatchObject({ processed: "unknown", reason: "index-conflict" });
		expect(r.conflicts).toEqual([home.id]);
	});
});
