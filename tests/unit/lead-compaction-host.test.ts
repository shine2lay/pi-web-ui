import { readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFencedSession, nativeLeadAdmission, SessionManager } from "../../server/lead-compaction-runtime.js";
import { fenceSession } from "../../server/lead-compaction-session.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { isKnownNoTurnMessagePath } from "../../server/prompt-start-guard.js";
import { afterEach, expect, it, vi } from "vitest";
import { nativeFixture } from "../helpers/lead-compaction-fixture.js";

it("actual host factory refuses detached cached writers and colliding runtime construction", async () => {
	const f = await fixture({ admission: nativeLeadAdmission });
	const detached = SessionManager.open(f.source);
	expect(() => detached.appendCustomEntry("forbidden", {})).toThrow("detached-native-writer");
	await expect(
		createFencedSession(detached, async () => {
			throw new Error("unreachable-factory");
		}),
	).rejects.toThrow("cached-owner-collision");
});
it("actual host opens refuse a second spelling through a symlink", async () => {
	const f = await fixture({ admission: nativeLeadAdmission });
	const alias = join(dirname(f.source), "alias.jsonl");
	symlinkSync(f.source, alias);
	expect(() => SessionManager.open(alias)).toThrow("noncanonical-source");
});
it("in-memory worker sessions keep their original native input methods", async () => {
	const f = await fixture();
	const session = await f.create(SessionManager.inMemory(f.manager.getCwd()));
	const prompt = session.prompt;
	const custom = session.sendCustomMessage;
	fenceSession(session, nativeLeadAdmission);
	expect(session.prompt).toBe(prompt);
	expect(session.sendCustomMessage).toBe(custom);
	session.dispose();
});

const fixtures: Awaited<ReturnType<typeof nativeFixture>>[] = [];
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		expect(f.modelCalls()).toBe(0);
		f.close();
	}
});
async function fixture(options?: Parameters<typeof nativeFixture>[0]) {
	const f = await nativeFixture(options);
	fixtures.push(f);
	return f;
}
it("A2 busy refuses without changing native journal", async () => {
	const f = await fixture();
	const ticket = f.ticket();
	const before = readFileSync(f.source);
	f.busy();
	expect((await f.host.tryApply(ticket)).state).toBe("waiting_busy");
	expect(readFileSync(f.source)).toEqual(before);
});
it("A3 appended entry after capture refuses stale capability", async () => {
	const f = await fixture();
	const ticket = f.ticket();
	f.manager.appendCustomEntry("checkpoint", { work: "retained" });
	expect((await f.host.tryApply(ticket)).state).toBe("blocked");
	expect(f.manager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(0);
});
it("A3 binding drift refuses", async () => {
	const f = await fixture();
	const ticket = f.ticket();
	f.drift();
	expect((await f.host.tryApply(ticket)).state).toBe("blocked");
});
it("A5 same manager native pair preserves prefix and retained work, acknowledges once", async () => {
	const f = await fixture();
	const before = readFileSync(f.source);
	const ticket = f.ticket();
	const result = await f.host.tryApply(ticket);
	expect(result.state).toBe("applied");
	expect(f.session.sessionManager).toBe(f.manager);
	expect(readFileSync(f.source).subarray(0, before.length)).toEqual(before);
	expect(f.manager.getEntry(f.boundary)).toBeDefined();
	expect(f.session.messages.some((m) => m.role === "user")).toBe(true);
	expect(f.acknowledgements()).toBe(1);
	expect((await f.host.tryApply(ticket)).state).toBe("blocked");
	expect(f.manager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
});
it("A2 nextTurn notes invisible to native pendingMessageCount still prevent a cut", async () => {
	const f = await fixture();
	await f.session.sendCustomMessage(
		{ customType: "pending-checkpoint", content: "pending work", display: false },
		{ deliverAs: "nextTurn" },
	);
	expect(f.session.pendingMessageCount).toBe(0);
	expect((await f.host.tryApply(f.ticket())).state).toBe("waiting_busy");
	expect(f.host.admission.file(f.source).deferred).toBe(1);
});
it("A2 arriving input remains owned through durable acknowledgement and is delivered once", async () => {
	const f = await fixture();
	let release!: () => void;
	f.holdAck(
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	expect(isKnownNoTurnMessagePath(f.session, AgentSession.prototype.sendCustomMessage)).toBe(true);
	const apply = f.host.tryApply(f.ticket());
	expect(isKnownNoTurnMessagePath(f.session, AgentSession.prototype.sendCustomMessage)).toBe(false);
	// The synchronous pair is complete before tryApply yields to fsync.
	expect(f.manager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
	const input = f.session.sendCustomMessage({ customType: "arriving-input", content: "keep this", display: false });
	expect(f.host.admission.file(f.source).pending).toBe(1);
	expect(
		f.manager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "arriving-input"),
	).toHaveLength(0);
	release();
	expect((await apply).state).toBe("applied");
	await input;
	expect(
		f.manager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "arriving-input"),
	).toHaveLength(1);
	expect(f.host.admission.file(f.source).pending).toBe(0);
	expect(isKnownNoTurnMessagePath(f.session, AgentSession.prototype.sendCustomMessage)).toBe(true);
});
it("A4 append then refresh failure holds only this home and rebinds queued input to reopened SDK", async () => {
	const f = await fixture();
	vi.spyOn(f.session, "refreshContext").mockImplementation(() => {
		throw new Error("planted-refresh-failure");
	});
	expect((await f.host.tryApply(f.ticket())).errorCode).toBe("native-recovery-required");
	const input = f.session.sendCustomMessage({
		customType: "recovery-input",
		content: "never lose this",
		display: false,
	});
	const other = await fixture({ admission: f.host.admission });
	expect((await other.host.tryApply(other.ticket())).state).toBe("applied");
	await f.host.recover(f.session.sessionId);
	await input;
	const current = f.host.admission.file(f.source).session!;
	expect(current).not.toBe(f.session);
	expect(current.sessionId).toBe(f.session.sessionId);
	expect(current.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
	expect(
		current.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "recovery-input"),
	).toHaveLength(1);
	expect(f.acknowledgements()).toBe(1);
	expect(f.host.admission.file(f.source).recovery).toBe(false);
});
it("A3 clone capability and native generation change cannot commit", async () => {
	const f = await fixture();
	const ticket = f.ticket();
	expect((await f.host.tryApply(structuredClone(ticket))).errorCode).toBe("invalid-ticket");
	f.manager.branch(f.boundary);
	expect((await f.host.tryApply(ticket)).errorCode).toBe("stale-fence");
});
