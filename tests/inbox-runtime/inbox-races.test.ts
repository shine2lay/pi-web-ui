import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { InboxRuntime, type InboxQueuePort, type InboxTaskIntent } from "../../server/inbox-runtime.js";
import type { RoleMessageGuardHost } from "../../server/role-message-guard-host.js";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import { B, chat, useGuardWorld, who, world } from "../../tests/unit/role-message-guard-host-harness.js";
import { fixture, plan } from "./inbox-queue-fixture.js";
import { caseOf } from "./inbox-corpora.js";
import { claimOf, setup } from "./inbox-world.js";

useGuardWorld();
function queuePort(f: ReturnType<typeof fixture>): InboxQueuePort {
	return {
		homeSession: f.home.file,
		async accept(intent) {
			await f.home.command(f.mint(intent));
			const result = f.results.at(-1);
			if (!result) throw new Error("Real HOME command did not return a capability receipt");
			return result;
		},
		async find(opKey) {
			// Actual queue replay, not an in-memory task simulation.
			for (const task of f.home.state().tasks) {
				const inputs = task.origin?.inputs as Array<{ opKey?: string; payloadSha256?: string }> | undefined;
				const origin = inputs?.find(input => input.opKey === opKey);
				if (origin?.payloadSha256) return { queuedTask: task.id, payloadSha256: origin.payloadSha256 };
			}
			return undefined;
		},
	};
}
function addCount(file: string): number {
	return readFileSync(file, "utf8").split("\n").filter(Boolean)
		.map(line => JSON.parse(line)).filter(row => row.customType === "queue" && row.data.op === "add").length;
}
const outboxReplies = async (host: RoleMessageGuardHost, id: string) => {
	const state = await (host as unknown as { state_(): Promise<GuardStoreState> }).state_();
	return state.outbox.filter(row => row.message.replyTo === id).length;
};

it.each(["helper-first", "home-first", "overlap"])("H3 reply race %s: real guard accepts exactly one reply", async order => {
	caseOf("helper", "C-HRACE-1");
	caseOf("helper", "C-HRACE-2");
	caseOf("helper", "C-HRACE-3");
	const h = await setup();
	const file = chat("inbox-helper");
	const helper = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: file }));
	const reply = () => h.runtime.reply(helper, who(h.w, "beta", file), { kind: "reply", replyTo: h.id, to: "alpha", text: "fixture answer" }, "helper-reply");
	const home = () => h.runtime.claim(h.key, { kind: "home", role: "beta", session: B });
	let homeResult;
	if (order === "helper-first") { await reply(); homeResult = await home(); }
	else if (order === "home-first") { homeResult = await home(); expect((await reply()).code).toBe("E_RPI_STALE_LEASE"); }
	else { [, homeResult] = await Promise.all([reply(), home()]); }
	if ("leaseId" in homeResult) await h.runtime.reply(homeResult, who(h.w, "beta", B), { kind: "reply", replyTo: h.id, to: "alpha", text: "fixture home answer" }, "home-reply");
	await h.runtime.recover();
	expect(await outboxReplies(h.w.host, h.id)).toBe(1);
	const id = h.w.rm.byId(h.id)?.replyId;
	expect(typeof id).toBe("string");
	expect(h.w.rm.byId(id!)?.replyTo).toBe(h.id);
});

it("C-HRACE-6 task then reply: real HOME append once, task not semantic receipt", async () => {
	caseOf("helper", "C-HRACE-6");
	const f = fixture();
	const h = await setup(queuePort(f));
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("task-helper") }));
	const accepted = await h.runtime.task(lease, plan, "ticket-attempt-1");
	expect(accepted).toMatchObject({ status: "accepted", replyOwed: true, semanticReceipt: null });
	expect(addCount(f.home.file)).toBe(1);
	expect(addCount(f.helper.file)).toBe(0);
	expect(h.w.rm.byId(h.id)?.replyId).toBeUndefined();
	expect(await h.runtime.task(lease, plan, "ticket-retry")).toEqual(accepted);
	expect(addCount(f.home.file)).toBe(1);
	await h.runtime.reply(lease, who(h.w, "beta", lease.session), { kind: "reply", replyTo: h.id, to: "alpha", text: "Queued" }, "reply-after-task");
	expect(await outboxReplies(h.w.host, h.id)).toBe(1);
	expect(addCount(f.home.file)).toBe(1);
});

it.each(["before-append", "after-append"])("C-HRST-3/C-DDONE-10 task crash %s reconciles actual journal", async point => {
	caseOf("helper", "C-HRST-3"); caseOf("delivery", "C-DDONE-10");
	const f = fixture();
	const port = queuePort(f);
	let intent: InboxTaskIntent | undefined;
	const normal = port.accept;
	port.accept = async request => {
		intent = request;
		if (point === "before-append") throw new Error("Injected before HOME append");
		await normal(request);
		throw new Error("Injected after HOME append before ledger receipt");
	};
	const h = await setup(port);
	const lease = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("crash-helper") }));
	await expect(h.runtime.task(lease, plan, "crash-ticket")).rejects.toThrow("Injected");
	expect(addCount(f.home.file)).toBe(point === "before-append" ? 0 : 1);
	port.accept = normal;
	h.w.rm.stop(); h.w.host.stop();
	const reboot = await world(h.w);
	const resumed = new InboxRuntime({ ...h.runtime.ports, messages: reboot.rm, guard: reboot.host });
	await resumed.recover(); await resumed.recover();
	expect(addCount(f.home.file)).toBe(point === "before-append" ? 0 : 1);
	expect(reboot.rm.byId(h.id)?.replyId).toBeUndefined();
	const read = resumed.read("beta");
	if (read.status !== "ok") throw new Error("Expected whole read after qualified journal recovery");
	const item = read.items.find(i => i.key === h.key)!;
	expect(item.lifecycle.state).toBe("open");
	expect(item.lifecycle.receipt.semantic).toBeNull();
	if (point === "after-append") {
		expect(await port.find(intent!.opKey)).toBeDefined();
		expect(item.lifecycle.effect?.queuedTask).not.toBeNull();
		const home = claimOf(await resumed.claim(h.key, { kind: "home", role: "beta", session: B }));
		expect(await resumed.task(home, plan, "later-lease")).toMatchObject({ status: "refused", code: "E_RPI_CONFLICT" });
		expect(addCount(f.home.file)).toBe(1);
	}
});

it("H3 concurrent task calls serialize at real HOME acceptance; changed payload conflicts", async () => {
	caseOf("helper", "C-HTASK-8");
	caseOf("helper", "C-HTASK-9");
	const f = fixture();
	const h = await setup(queuePort(f));
	const helper = claimOf(await h.runtime.claim(h.key, { kind: "helper", role: "beta", session: chat("task-race-helper") }));
	const results = await Promise.all([h.runtime.task(helper, plan, "ticket-a"), h.runtime.task(helper, plan, "ticket-b")]);
	expect(results[0]).toMatchObject({ status: "accepted" });
	expect(results[1]).toEqual(results[0]);
	expect(addCount(f.home.file)).toBe(1);
	expect(await h.runtime.task(helper, { ...plan, title: "Changed body" }, "ticket-c")).toMatchObject({ status: "refused", code: "E_RPI_CONFLICT" });
	const home = claimOf(await h.runtime.claim(h.key, { kind: "home", role: "beta", session: B }));
	expect(await h.runtime.task(home, plan, "ticket-d")).toMatchObject({ status: "refused", code: "E_RPI_CONFLICT" });
	expect((await h.runtime.reply(helper, who(h.w, "beta", helper.session), { kind: "reply", to: "alpha", replyTo: h.id, text: "late" }, "late-helper")).code).toBe("E_RPI_STALE_LEASE");
	await h.runtime.reply(home, who(h.w, "beta", B), { kind: "reply", to: "alpha", replyTo: h.id, text: "Queued" }, "home-after-task");
	expect(addCount(f.home.file)).toBe(1);
	expect(await outboxReplies(h.w.host, h.id)).toBe(1);
});

it("GREEN actual queue fixture ordinary HOME add appends one journal card", async () => {
	const f = fixture();
	await f.home.add();
	expect(addCount(f.home.file)).toBe(1);
	expect(f.home.state().tasks).toHaveLength(1);
	expect(f.home.dialogs()).toBe(0);
});
