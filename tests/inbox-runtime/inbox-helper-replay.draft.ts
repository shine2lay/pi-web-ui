import { expect, it } from "vitest";
import { A, B, send, useGuardWorld, who } from "../unit/role-message-guard-host-harness.js";
import { type InboxClaim } from "../../server/inbox-runtime.js";
import { identityOfEntry } from "../../server/specialist-entry.js";
import { inboxNextDispatch } from "../../server/shared/inbox-wire.js";
import { caseOf } from "./inbox-corpora.js";
import { plan } from "./inbox-queue-fixture.js";
import { claimOf } from "./inbox-world.js";
import { adds, item, journal, reboot, replayFixture, reply } from "./inbox-helper-replay-fixture.js";

useGuardWorld();
// Titles deliberately equal IDs: the ownership map resolves an exact test, not a substring tag.
it.each(["C-HSPAWN-1", "C-HSPAWN-2", "C-HSPAWN-3", "C-HSPAWN-4", "C-HSPAWN-5", "C-HSPAWN-12", "C-HSPAWN-13"])(
	"%s",
	async (id) => {
		caseOf("helper", id);
		const f = await replayFixture();
		if (id === "C-HSPAWN-3") expect((await send(f.h.w, "alpha", A, "beta")).ok).toBe(true);
		if (id === "C-HSPAWN-4" || id === "C-HSPAWN-5") {
			for (let i = 0; i < 3; i++) expect((await send(f.h.w, "alpha", A, "beta")).ok).toBe(true);
			expect(await f.admit()).toHaveLength(3);
		}
		if (id === "C-HSPAWN-12") await f.claim();
		if (id === "C-HSPAWN-13")
			f.ports.launch = async () => {
				throw new Error("Injected launch failure");
			};
		const launched = await f.admit(!["C-HSPAWN-2", "C-HSPAWN-3"].includes(id), id === "C-HSPAWN-5" ? 4 : 3);
		const none = ["C-HSPAWN-2", "C-HSPAWN-4", "C-HSPAWN-12", "C-HSPAWN-13"].includes(id);
		expect(launched).toHaveLength(none ? 0 : 1);
		if (id === "C-HSPAWN-5") expect(f.host.live("beta")).toBe(4);
		if (id === "C-HSPAWN-2") {
			expect(f.sessions.size).toBe(0);
			expect(f.h.runtime.audit("beta", "beta")).toHaveLength(0);
		}
		if (id === "C-HSPAWN-13") {
			expect(f.host.live("beta")).toBe(0);
			expect(item(f)).toMatchObject({ route: "helper_eligible", lifecycle: { state: "open" } });
			expect(f.h.runtime.audit("beta", "beta")).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ op: "release", reason: "spawn_failed" }),
					expect.objectContaining({ op: "attempt", outcome: "crashed", cause: "spawn_failed" }),
				]),
			);
		}
		for (const helper of launched) {
			expect(f.host.inboxHelperBinding(helper.sessionId)).toMatchObject({
				leaseId: helper.leaseId,
				msgId: helper.msgId,
			});
			expect(
				journal(helper.sessionFile)
					.filter((e) => e.type === "custom")
					.map((e) => e.customType)
					.slice(0, 3),
			).toEqual(["identity", "inbox-helper-seal", "inbox-helper-binding"]);
			expect(adds(helper.sessionFile)).toBe(0);
		}
	},
);

it("C-HID-2", () => {
	caseOf("helper", "C-HID-2");
	// Web-reader facet only: poisoned helper entry must never become an ordinary role.
	expect(
		identityOfEntry({
			type: "custom",
			customType: "identity",
			data: {
				v: 1,
				id: "backend",
				via: "inbox-helper",
				inbox: { msgId: "rm-a", leaseId: "L1", epoch: 2, homeChat: "h", tools: ["bash"] },
			},
		}),
	).toBe("unusable");
});

it.each(["C-HMSG-2", "C-HMSG-3", "C-HMSG-4", "C-HMSG-5", "C-HMSG-7", "C-HMSG-8", "C-HMSG-9"])("%s", async (id) => {
	caseOf("helper", id);
	const f = await replayFixture(),
		lease = await f.claim();
	const input = {
		kind: "reply" as "reply" | "fyi",
		to: "alpha",
		replyTo: f.h.id,
		text: "Technical answer",
		extra: undefined as unknown,
	};
	if (id === "C-HMSG-2") input.kind = "fyi";
	if (id === "C-HMSG-3") input.replyTo = "rm-other";
	if (id === "C-HMSG-4") input.to = "coo";
	if (id === "C-HMSG-5") input.extra = { approval: { action: "request" } };
	if (id === "C-HMSG-9") claimOf(await f.h.runtime.claim(f.h.key, { kind: "home", role: "beta", session: B }));
	let prior: Awaited<ReturnType<typeof reply>> | undefined;
	if (["C-HMSG-7", "C-HMSG-8"].includes(id)) prior = await reply(f, lease);
	const before = journal(f.h.ledgerFile).length;
	if (id === "C-HMSG-8") input.text = "Different answer";
	const result = await f.h.runtime.reply(lease, who(f.h.w, "beta", lease.session), input, "second-call");
	if (id === "C-HMSG-7") {
		expect(result.resultRef).toBe(prior!.resultRef);
		expect(result.resultRef).toBeTypeOf("string");
		expect(journal(f.h.ledgerFile)).toHaveLength(before);
	} else {
		expect(result.code).toBe(
			id === "C-HMSG-5"
				? "E_RPI_ARG_DENIED"
				: id === "C-HMSG-8"
					? "E_RPI_CONFLICT"
					: id === "C-HMSG-9"
						? "E_RPI_STALE_LEASE"
						: "E_RPI_TARGET",
		);
		if (id !== "C-HMSG-8") expect(f.h.w.rm.byId(f.h.id)?.replyId).toBeUndefined();
		else expect(f.h.w.rm.byId(f.h.id)?.replyId).toBe(prior!.resultRef);
	}
});

it.each([
	"C-HTASK-2",
	"C-HTASK-3",
	"C-HTASK-8",
	"C-HTASK-9",
	"C-HTASK-10",
	"C-HTASK-16",
	"C-HTASK-17",
	"C-HTASK-18",
	"C-HTASK-19",
])("%s", async (id) => {
	caseOf("helper", id);
	const f = await replayFixture(id !== "C-HTASK-2", id === "C-HTASK-3");
	const lease = await f.claim();
	const priorIds = ["C-HTASK-8", "C-HTASK-9", "C-HTASK-10", "C-HTASK-17", "C-HTASK-18"];
	const prior = priorIds.includes(id) ? await f.h.runtime.task(lease, plan, "first-ticket") : undefined;
	let caller = lease;
	if (["C-HTASK-10", "C-HTASK-17", "C-HTASK-19"].includes(id)) {
		const home = claimOf(await f.h.runtime.claim(f.h.key, { kind: "home", role: "beta", session: B }));
		if (id !== "C-HTASK-19") caller = home;
	}
	const result = await f.h.runtime.task(
		caller,
		id === "C-HTASK-9" ? { ...plan, title: "Different plan" } : plan,
		"next-ticket",
	);
	if (["C-HTASK-2", "C-HTASK-3"].includes(id)) {
		expect(result).toMatchObject({ status: "refused", code: "E_RPI_NEEDS_HOME", need: "plan" });
		expect(adds(f.q.home.file)).toBe(0);
		expect(f.q.home.dialogs()).toBe(0);
	} else if (["C-HTASK-9", "C-HTASK-10", "C-HTASK-17", "C-HTASK-19"].includes(id)) {
		expect(result).toMatchObject({
			status: "refused",
			code: id === "C-HTASK-19" ? "E_RPI_STALE_LEASE" : "E_RPI_CONFLICT",
		});
		expect(adds(f.q.home.file)).toBe(id === "C-HTASK-19" ? 0 : 1);
	} else {
		expect(result).toMatchObject({ status: "accepted", replyOwed: true, semanticReceipt: null });
		if (prior) expect(result).toEqual(prior);
		expect(adds(f.q.home.file)).toBe(1);
		expect(item(f).lifecycle).toMatchObject({ state: "claimed", lease: lease.leaseId, receipt: { semantic: null } });
	}
	expect(adds(f.q.helper.file)).toBe(0);
	expect(f.h.w.rm.byId(f.h.id)?.replyId).toBeUndefined();
});

it.each(["C-HRACE-1", "C-HRACE-2", "C-HRACE-6", "C-HRACE-8", "C-HRACE-12"])("%s", async (id) => {
	caseOf("helper", id);
	const f = await replayFixture(),
		helper = await f.claim();
	const task = ["C-HRACE-6", "C-HRACE-8"].includes(id);
	if (task) expect(await f.h.runtime.task(helper, plan, "task")).toMatchObject({ status: "accepted" });
	if (["C-HRACE-1", "C-HRACE-8", "C-HRACE-12"].includes(id)) {
		const home = claimOf(await f.h.runtime.claim(f.h.key, { kind: "home", role: "beta", session: B }));
		if (id !== "C-HRACE-12") expect((await reply(f, helper)).code).toBe("E_RPI_STALE_LEASE");
		if (id !== "C-HRACE-1")
			expect(await f.h.runtime.task(helper, plan, "stale-task")).toMatchObject({ code: "E_RPI_STALE_LEASE" });
		if (id === "C-HRACE-8") {
			expect(item(f).lifecycle.effect?.queuedTask).not.toBeNull();
			expect((await reply(f, home)).resultRef).toBeTypeOf("string");
		}
	} else {
		expect((await reply(f, helper)).resultRef).toBeTypeOf("string");
		if (id === "C-HRACE-2")
			expect(await f.h.runtime.claim(f.h.key, { kind: "home", role: "beta", session: B })).toMatchObject({
				code: "E_RPI_ALREADY_REPLIED",
			});
	}
	expect(adds(f.q.home.file)).toBe(task ? 1 : 0);
	expect(Boolean(f.h.w.rm.byId(f.h.id)?.replyId)).toBe(["C-HRACE-2", "C-HRACE-6", "C-HRACE-8"].includes(id));
});

it.each(["C-HRST-3", "C-HRST-4", "C-HRST-8"])("%s", async (id) => {
	caseOf("helper", id);
	const f = await replayFixture(),
		lease = await f.claim();
	const accept = f.queue.accept;
	f.queue.accept = async (intent) => {
		if (id !== "C-HRST-4") await accept(intent);
		throw new Error("Injected acceptance interruption");
	};
	await expect(f.h.runtime.task(lease, plan, "interrupted")).rejects.toThrow("Injected acceptance interruption");
	f.queue.accept = accept;
	const r = await reboot(f);
	await r.runtime.recover();
	await r.runtime.recover();
	expect(adds(f.q.home.file)).toBe(id === "C-HRST-4" ? 0 : 1);
	expect(item(f, r.runtime).lifecycle).toMatchObject({ state: "open", receipt: { semantic: null } });
	expect(await r.runtime.task(lease, plan, "old-lease")).toMatchObject({ code: "E_RPI_STALE_LEASE" });
	expect(r.w.rm.byId(f.h.id)?.replyId).toBeUndefined();
	if (id !== "C-HRST-4") {
		expect(item(f, r.runtime).lifecycle.effect?.queuedTask).not.toBeNull();
		expect(r.runtime.audit("beta", "beta").filter((l) => l.op === "effect_done" && l.effect === "task")).toHaveLength(
			1,
		);
		if (id === "C-HRST-8") expect(inboxNextDispatch(item(f, r.runtime))).toBe("reply_only");
	}
});

it.each(["C-HREL-1", "C-HREL-3", "C-HREL-6"])("%s", async (id) => {
	caseOf("helper", id);
	const f = await replayFixture(),
		[helper] = await f.admit();
	const lease: InboxClaim = { key: f.h.key, session: helper.sessionFile, leaseId: helper.leaseId, epoch: helper.epoch };
	if (id === "C-HREL-6")
		expect(await f.h.runtime.task(lease, plan, "before-release")).toMatchObject({ status: "accepted" });
	await f.host.release(helper.sessionId, "lead");
	const before = journal(f.h.ledgerFile).length;
	if (id === "C-HREL-3") {
		await f.host.release(helper.sessionId, "lead");
		expect(journal(f.h.ledgerFile)).toHaveLength(before);
	}
	expect(item(f)).toMatchObject({
		route: "home_only",
		effectivePriority: "P1",
		lifecycle: { state: "open", receipt: { semantic: null } },
	});
	expect(f.h.w.rm.byId(f.h.id)?.replyId).toBeUndefined();
	expect(f.q.home.dialogs()).toBe(0);
	if (id === "C-HREL-6") {
		expect(adds(f.q.home.file)).toBe(1);
		expect(inboxNextDispatch(item(f))).toBe("reply_only");
	}
});

it.each(["C-HCLOSE-1", "C-HCLOSE-3", "C-HCLOSE-6", "C-HCLOSE-9"])("%s", async (id) => {
	caseOf("helper", id);
	const f = await replayFixture(),
		[helper] = await f.admit();
	if (id !== "C-HCLOSE-1")
		expect(
			await f.h.runtime.task(
				{ key: f.h.key, session: helper.sessionFile, leaseId: helper.leaseId, epoch: helper.epoch },
				plan,
				"before-close",
			),
		).toMatchObject({ status: "accepted" });
	f.failClose(id === "C-HCLOSE-1" || id === "C-HCLOSE-9");
	await f.host.end(helper.sessionId, "turn_ended_unanswered");
	if (["C-HCLOSE-1", "C-HCLOSE-9"].includes(id)) {
		expect(f.host.live("beta")).toBe(1);
		expect(f.closed).toHaveLength(0);
	}
	if (id === "C-HCLOSE-1") expect(f.h.runtime.alarm("beta", "beta").count).toBe(0);
	f.failClose(false);
	await f.host.reconcile();
	await f.host.reconcile();
	expect(f.closed).toHaveLength(1);
	expect(f.archived).toEqual([helper.sessionId]);
	expect(f.launched).toHaveLength(1);
	expect(item(f).lifecycle.state).toBe("open");
	expect(f.h.w.rm.byId(f.h.id)?.replyId).toBeUndefined();
	if (id !== "C-HCLOSE-1") {
		expect(adds(f.q.home.file)).toBe(1);
		expect(f.q.home.state().tasks).toHaveLength(1);
		expect(inboxNextDispatch(item(f))).toBe("reply_only");
	}
	if (id === "C-HCLOSE-6")
		expect(f.h.runtime.audit("beta", "beta")).toContainEqual(
			expect.objectContaining({ op: "attempt", outcome: "turn_ended_unanswered" }),
		);
});
