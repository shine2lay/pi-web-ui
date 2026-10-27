import { describe, expect, it, vi } from "vitest";
import { createTerminalRecovery } from "../../web/src/recovery-terminal";
import type { AdmissionBinding } from "../../web/src/recovery-admission";
import type { AuthoredCommandIntent, ClientMessage, TerminalViewReply } from "../../web/src/types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function fixture() {
	const sent: ClientMessage[] = [];
	const socket = {
		send: vi.fn((text: string) => {
			sent.push(JSON.parse(text));
		}),
	};
	const binding: AdmissionBinding = {
		transport: socket,
		generation: "g1",
		sessionId: "s1",
		conversationId: "c1",
		workspace: "/work",
		lifetime: {},
	};
	let current = true;
	const owned = deferred<boolean>();
	const admit = vi.fn((_msg: ClientMessage, _binding?: AdmissionBinding) => owned.promise);
	const bridge = {
		captureBinding: () => binding,
		isCurrent: (candidate: AdmissionBinding) => current && candidate === binding,
		admit,
	};
	const api = createTerminalRecovery(bridge);
	const original: AuthoredCommandIntent = {
		requestId: "r1",
		source: "scm",
		conversationId: "c1",
		sessionId: "s1",
		workspaceCwd: "/work",
		command: { name: "Commit", command: "  git commit -m ' original 雪 '\n", cwd: "${pwd}" },
		terminal: {
			id: "t1",
			title: "Commit",
			cwd: "/work",
			cols: 80,
			rows: 24,
			mode: "new",
			running: false,
			exitCode: null,
		},
		commitSource: { text: " original 雪 ", revision: 9 },
	};
	const view = { conversationId: "c1", sessionId: "s1", terminalId: "t1", cols: 80, rows: 24, viewId: "v1" };
	const reply = (): TerminalViewReply => ({
		type: "terminal_view",
		reqId: (sent[0] as Extract<ClientMessage, { type: "terminal_attach" }>).reqId,
		...view,
		available: true,
		terminal: { id: "t1", title: "Commit", cwd: "/work", cols: 80, rows: 24, running: false, exitCode: 0 },
		data: "original output\r\n",
		offset: 0,
	});
	return {
		api,
		original,
		view,
		owned,
		admit,
		socket,
		binding,
		sent,
		reply,
		stale: () => {
			current = false;
		},
	};
}

describe("actual terminal recovery caller bridge", () => {
	it("captures all original authored bytes before awaiting the one checkpoint/dispatch owner", async () => {
		const f = fixture();
		const before = structuredClone(f.original);
		const result = f.api.command(f.original);
		Object.assign(f.original.command, { command: "caller-mutated" });
		Object.assign(f.original.commitSource!, { text: "newer", revision: 10 });
		expect(f.admit).toHaveBeenCalledTimes(1);
		expect(f.admit.mock.calls[0][0]).toEqual({
			type: "run_command",
			reqId: "r1",
			original: before,
			conversationId: "c1",
			terminalId: "t1",
			command: before.command,
			cols: 80,
			rows: 24,
		});
		expect(f.admit.mock.calls[0][1]).toBe(f.binding);
		expect(f.socket.send).not.toHaveBeenCalled();
		f.owned.resolve(true);
		expect(await result).toBe(true);
	});
	it.each(["conversationId", "sessionId", "workspaceCwd", "unknown"])(
		"does not admit mismatched/unknown %s",
		async (field) => {
			const f = fixture();
			Object.assign(f.original, { [field]: "other" });
			expect(await f.api.command(f.original)).toBe(false);
			expect(f.admit).not.toHaveBeenCalled();
		},
	);
	it.each([false, null, "truthy"])("does not report non-exact ownership %s", async (response) => {
		const f = fixture();
		const result = f.api.command(f.original);
		f.owned.resolve(response as boolean);
		expect(await result).toBe(false);
		expect(f.socket.send).not.toHaveBeenCalled();
	});
	it("refuses stale source and propagates failed storage without sending itself", async () => {
		const f = fixture();
		f.stale();
		expect(await f.api.command(f.original)).toBe(false);
		const g = fixture();
		g.admit.mockRejectedValueOnce(new Error("committed envelope failure"));
		await expect(g.api.command(g.original)).rejects.toThrow("committed envelope failure");
		expect(g.socket.send).not.toHaveBeenCalled();
		expect(g.original.commitSource!.text).toBe(" original 雪 ");
	});
	it("mount attach requests only an existing view and replaces once after exact reply", async () => {
		const f = fixture();
		const replace = vi.fn();
		const result = f.api.attach(f.view, replace);
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0].type).toBe("terminal_attach");
		expect(f.admit).not.toHaveBeenCalled();
		expect(f.api.receive(f.socket, f.reply())).toBe(true);
		expect(await result).toBe(true);
		expect(replace).toHaveBeenCalledExactlyOnceWith("original output\r\n");
		expect(f.api.receive(f.socket, f.reply())).toBe(false);
		expect(replace).toHaveBeenCalledTimes(1);
	});
	it.each(["socket", "reqId", "viewId", "terminalId", "sessionId", "conversationId"])(
		"ignores mismatched %s without settling another renderer",
		async (field) => {
			const f = fixture();
			const replace = vi.fn();
			const result = f.api.attach(f.view, replace);
			const reply = f.reply();
			if (field !== "socket") Object.assign(reply, { [field]: "different" });
			expect(f.api.receive(field === "socket" ? {} : f.socket, reply)).toBe(false);
			expect(replace).not.toHaveBeenCalled();
			f.api.cancel();
			expect(await result).toBe(false);
			expect(f.admit).not.toHaveBeenCalled();
		},
	);
	it("missing output, stale binding and throwing renderer never become attachment success or spawn", async () => {
		for (const kind of ["missing", "stale", "throw"] as const) {
			const f = fixture();
			const replace = vi.fn(() => {
				if (kind === "throw") throw new Error("renderer gone");
			});
			const result = f.api.attach(f.view, replace);
			const good = f.reply();
			if (kind === "stale") f.stale();
			const reply: TerminalViewReply =
				kind === "missing"
					? { type: "terminal_view", reqId: good.reqId, ...f.view, available: false, reason: "missing" }
					: good;
			expect(f.api.receive(f.socket, reply)).toBe(true);
			expect(await result).toBe(false);
			expect(f.sent).toHaveLength(1);
			expect(f.admit).not.toHaveBeenCalled();
		}
	});
	it("closed send or canceled connection retains no false renderer success", async () => {
		const f = fixture();
		f.socket.send.mockImplementation(() => {
			throw new Error("closed");
		});
		expect(await f.api.attach(f.view, vi.fn())).toBe(false);
		const g = fixture();
		const replace = vi.fn();
		const result = g.api.attach(g.view, replace);
		g.api.cancel();
		expect(await result).toBe(false);
		expect(g.api.receive(g.socket, g.reply())).toBe(false);
		expect(replace).not.toHaveBeenCalled();
	});
});
