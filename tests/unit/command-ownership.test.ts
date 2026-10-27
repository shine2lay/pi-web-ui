import { describe, expect, it, vi } from "vitest";
import { claimAuthoredCommand } from "../../server/command-ownership";
import { isAuthoredCommandIntent, matchesAuthoredCommand } from "../../server/command-intent";
import { isRecoveryEligible } from "../../web/src/recovery-policy";
import type { AuthoredCommandIntent, ClientMessage, TerminalInfo } from "../../server/protocol";

function fixture(existing = false) {
	const original: AuthoredCommandIntent = {
		requestId: "r1",
		source: "scm",
		conversationId: "c1",
		sessionId: "s1",
		workspaceCwd: "/work",
		command: { name: "Commit", command: "  git commit -m '  exact 雪🙂\n'\n", cwd: "${pwd}" },
		terminal: {
			id: "t1",
			title: "Commit",
			cwd: "/work",
			cols: 80,
			rows: 24,
			mode: existing ? "existing" : "new",
			running: false,
			exitCode: existing ? 0 : null,
		},
		commitSource: { text: "  exact 雪🙂\n", revision: 7 },
	};
	const message: Extract<ClientMessage, { type: "run_command" }> = {
		type: "run_command",
		reqId: "r1",
		original,
		conversationId: "c1",
		terminalId: "t1",
		command: original.command,
		cols: 80,
		rows: 24,
		recovery: { id: "r1", sessionId: "s1", contentDigest: "digest", attemptId: "attempt1" },
	};
	const terminals: TerminalInfo[] = existing
		? [{ id: "t1", title: "Commit", cwd: "/work", cols: 80, rows: 24, running: false, exitCode: 0 }]
		: [];
	const manager = { list: () => terminals, runCommand: vi.fn() };
	let sid = "s1",
		cid = "c1";
	const host = {
		cwd: "/work",
		activeSessionId: () => sid,
		activeConversationId: () => cid,
		getTerminalManager: vi.fn(() => manager),
	};
	return {
		original,
		message,
		host,
		manager,
		terminals,
		move: (next: string) => {
			sid = next;
			cid = `c-${next}`;
		},
	};
}

describe("typed complete command ownership", () => {
	it("preserves raw commit/command bytes and claims no effect until explicitly run", () => {
		const f = fixture();
		const before = structuredClone(f.message);
		expect(isAuthoredCommandIntent(f.original)).toBe(true);
		expect(matchesAuthoredCommand(f.message)).toBe(true);
		const { recovery: _privateWire, ...candidate } = f.message;
		expect(isRecoveryEligible(candidate)).toBe(true);
		const claim = claimAuthoredCommand(f.host, f.message);
		expect(claim.kind).toBe("claimed");
		expect(f.manager.runCommand).not.toHaveBeenCalled();
		if (claim.kind !== "claimed") throw new Error("fixture did not claim");
		claim.run();
		claim.run();
		expect(f.manager.runCommand).toHaveBeenCalledExactlyOnceWith("t1", before.command, 80, 24, "/work");
		expect(f.message).toEqual(before);
	});
	it("same request or changed request identity cannot run twice, including a new wire attempt", () => {
		const f = fixture();
		const first = claimAuthoredCommand(f.host, f.message);
		if (first.kind !== "claimed") throw new Error("claim");
		first.run();
		f.message.recovery!.attemptId = "attempt2";
		expect(claimAuthoredCommand(f.host, f.message)).toEqual({
			kind: "refused",
			status: "uncertain",
			reason: "command-already-owned",
		});
		f.message.original = { ...f.original, commitSource: { text: "different", revision: 8 } };
		expect(claimAuthoredCommand(f.host, f.message)).toMatchObject({
			kind: "refused",
			status: "uncertain",
			reason: "command-identity-conflict",
		});
		expect(f.manager.runCommand).toHaveBeenCalledTimes(1);
	});
	it.each(["workspace", "session", "conversation", "terminal"])(
		"refuses changed original %s before claiming effects",
		(kind) => {
			const f = fixture(true);
			if (kind === "workspace") f.host.cwd = "/other";
			if (kind === "session" || kind === "conversation") f.move("s2");
			if (kind === "terminal") f.terminals[0].cwd = "/other";
			expect(claimAuthoredCommand(f.host, f.message)).toMatchObject({ kind: "refused", status: "unprocessed" });
			expect(f.manager.runCommand).not.toHaveBeenCalled();
		},
	);
	it("checks target again after claimed ownership and never retries a thrown run", () => {
		const f = fixture();
		const claim = claimAuthoredCommand(f.host, f.message);
		if (claim.kind !== "claimed") throw new Error("claim");
		f.move("s2");
		expect(() => claim.run()).toThrow("original command target changed");
		claim.run();
		expect(f.manager.runCommand).not.toHaveBeenCalled();
		expect(claimAuthoredCommand(f.host, f.message)).toMatchObject({ kind: "refused", status: "uncertain" });
	});
	it("copies original before caller mutation and keeps execution throws uncertain", () => {
		const f = fixture();
		const expected = structuredClone(f.message.command);
		const claim = claimAuthoredCommand(f.host, f.message);
		if (claim.kind !== "claimed") throw new Error("claim");
		f.message.command.command = "mutated";
		f.manager.runCommand.mockImplementation(() => {
			throw new Error("side effect may have started");
		});
		expect(() => claim.run()).toThrow("may have started");
		expect(f.manager.runCommand).toHaveBeenCalledExactlyOnceWith("t1", expected, 80, 24, "/work");
		claim.run();
		expect(f.manager.runCommand).toHaveBeenCalledTimes(1);
	});
	it.each([
		"wire-text",
		"wire-terminal",
		"wire-size",
		"wire-request",
		"wire-session",
		"unknown-original",
		"unknown-command",
		"new-collision",
		"existing-missing",
		"agent-bash",
	])("fails closed for %s", (reason) => {
		const f = fixture(reason === "existing-missing" || reason === "agent-bash");
		if (reason === "wire-text") f.message.command = { ...f.message.command, command: "different" };
		if (reason === "wire-terminal") f.message.terminalId = "t2";
		if (reason === "wire-size") f.message.cols = 81;
		if (reason === "wire-request") f.message.reqId = "other";
		if (reason === "wire-session") f.message.recovery!.sessionId = "other";
		if (reason === "unknown-original") Object.assign(f.original, { apiKey: "FAKE_ONLY" });
		if (reason === "unknown-command") Object.assign(f.original.command, { environment: { token: "FAKE_ONLY" } });
		if (reason === "new-collision")
			f.terminals.push({ id: "t1", title: "other", cwd: "/work", cols: 80, rows: 24, running: true, exitCode: null });
		if (reason === "existing-missing") f.terminals.length = 0;
		if (reason === "agent-bash") f.terminals[0].agentBash = true;
		expect(claimAuthoredCommand(f.host, f.message)).toMatchObject({ kind: "refused", status: "unprocessed" });
		expect(f.manager.runCommand).not.toHaveBeenCalled();
	});
	it("never calls an original/source accessor", () => {
		const f = fixture();
		const get = vi.fn(() => "FAKE_ONLY");
		Object.defineProperty(f.original, "requestId", { get, enumerable: true });
		expect(isAuthoredCommandIntent(f.original)).toBe(false);
		expect(get).not.toHaveBeenCalled();
	});
});
