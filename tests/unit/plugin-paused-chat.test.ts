/**
 * queue-back-owed (Ops #393, re-review N3 and N4).
 * N3: a scheduler's or plugin's client sends its prompt into its open chat. When that chat is a queued task's chat
 * the owner paused (or one still owed its "Back to task" note), it moves to a new chat first, so the prompt starts
 * no turn there; when it can't, it sends nothing.
 * N4: chatState's subagent count includes pi-subagents' background runs started from the chat, so a paused chat
 * isn't seen stopped while one of them may still write.
 * R1: the model and thinking level of a scheduled or plugin job are set after the client leaves such a chat, so
 * the paused task's chat keeps its own, and the new chat gets the job's.
 * R2: a closed chat's background runs count too (they run in a process of their own).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentService, ClientSession } from "../../server/agent-service.js";

afterEach(() => {
	vi.restoreAllMocks();
});

type Leave = (paused: (file: string) => Promise<boolean>) => Promise<boolean>;

function client(active: string | undefined, newChat: { opens: boolean; file?: string } = { opens: true }) {
	const state = { active, newChats: 0, asked: [] as string[] };
	const cs = Object.create(ClientSession.prototype) as unknown as Record<string, unknown>;
	cs.activeSessionFileResolved = () => state.active;
	cs.newChat = async () => {
		state.newChats++;
		if (newChat.opens) state.active = newChat.file;
		return newChat.opens;
	};
	const leave = (paused: (file: string) => Promise<boolean>) =>
		(ClientSession.prototype as unknown as { leavePausedTaskChat: Leave }).leavePausedTaskChat.call(cs, paused);
	const pausedIf = (files: string[]) => async (file: string) => {
		state.asked.push(file);
		return files.includes(file);
	};
	return { state, leave, pausedIf };
}

describe("a scheduler's or plugin's client leaves a paused task's chat before it sends (Ops #393, N3)", () => {
	it("its open chat is a paused or back-owed task's chat: a new chat, then it sends", async () => {
		const c = client("/s/task.jsonl", { opens: true, file: "/s/new.jsonl" });
		expect(await c.leave(c.pausedIf(["/s/task.jsonl"]))).toBe(true);
		expect(c.state.newChats).toBe(1);
		expect(c.state.active).toBe("/s/new.jsonl");
	});

	it("a new blank chat without a transcript yet counts as left", async () => {
		const c = client("/s/task.jsonl", { opens: true });
		expect(await c.leave(c.pausedIf(["/s/task.jsonl"]))).toBe(true);
		expect(c.state.newChats).toBe(1);
	});

	it("any other chat, or none: it stays and sends as before", async () => {
		const other = client("/s/other.jsonl");
		expect(await other.leave(other.pausedIf(["/s/task.jsonl"]))).toBe(true);
		expect(other.state.newChats).toBe(0);
		const none = client(undefined);
		expect(await none.leave(none.pausedIf(["/s/task.jsonl"]))).toBe(true);
		expect(none.state.asked).toEqual([]);
		expect(none.state.newChats).toBe(0);
	});

	it("no new chat could be opened, or it stayed on the same chat: false, so nothing is sent", async () => {
		const refused = client("/s/task.jsonl", { opens: false });
		expect(await refused.leave(refused.pausedIf(["/s/task.jsonl"]))).toBe(false);
		const same = client("/s/task.jsonl", { opens: true, file: "/s/task.jsonl" });
		expect(await same.leave(same.pausedIf(["/s/task.jsonl"]))).toBe(false);
	});
});

describe("chatState counts pi-subagents' background runs of the chat (Ops #393, N4)", () => {
	it("one or more background runs for the chat: one more at work", () => {
		const runs = (o: { sessionId: string }) => o.sessionId === "/s/a.jsonl";
		expect(ClientSession.chatSubagentsAtWork("/s/a.jsonl", runs)).toBe(1);
		expect(ClientSession.chatSubagentsAtWork("/s/b.jsonl", runs)).toBe(0);
	});

	it("a closed chat's background runs count too (R2)", () => {
		const spy = vi.spyOn(ClientSession, "chatSubagentsAtWork").mockReturnValue(1);
		const look = (
			AgentService.prototype.queueChatState as (file: string) => { state: string; subagents?: number }
		).call({}, "/nonexistent-qp393/closed.jsonl");
		expect(spy).toHaveBeenCalledWith("/nonexistent-qp393/closed.jsonl");
		expect(look.state).toBe("closed");
		expect(look.subagents).toBe(1);
	});

	it("matched by the transcript as given too, and a scan that throws counts as none", () => {
		const asGiven = (o: { sessionId: string }) => o.sessionId === "/s/x/../a.jsonl";
		expect(ClientSession.chatSubagentsAtWork("/s/x/../a.jsonl", asGiven)).toBe(1);
		expect(
			ClientSession.chatSubagentsAtWork("/s/a.jsonl", () => {
				throw new Error("unreadable");
			}),
		).toBe(0);
	});
});

describe("a job's model and thinking level go to the chat it sends in, not the paused task's chat (Ops #393, R1)", () => {
	/** A service whose client records, in order, what is done to its open chat. */
	function service(leaves: boolean) {
		const calls: string[] = [];
		const cs = {
			cwd: "/p",
			setCwd: async () => calls.push("cwd"),
			switchModelOrThrow: async (m: string) => calls.push(`model ${m}`),
			setThinking: (t: string) => calls.push(`thinking ${t}`),
			leavePausedTaskChat: async () => {
				calls.push("leave");
				return leaves;
			},
			conversationIdForPlugins: () => "c-new",
			prompt: async () => calls.push("prompt"),
			readConversationForPlugins: () => ({ isStreaming: false, messages: [] }),
		};
		const svc = Object.create(AgentService.prototype) as AgentService;
		const raw = svc as unknown as Record<string, unknown>;
		raw.quiesced = false;
		raw.attach = async () => cs;
		return { svc, calls };
	}

	it("plugin: it leaves the paused chat first, then sets the model and thinking level, then sends", async () => {
		const { svc, calls } = service(true);
		await svc.chatFromPlugin("tg", { text: "hi", model: "m1", thinkingLevel: "high" });
		expect(calls).toEqual(["leave", "model m1", "thinking high", "prompt"]);
	});

	it("plugin: no new chat could be opened: nothing is changed in the paused chat, and nothing is sent", async () => {
		const { svc, calls } = service(false);
		await expect(svc.chatFromPlugin("tg", { text: "hi", model: "m1", thinkingLevel: "high" })).rejects.toThrow(
			/paused queued task's chat/,
		);
		expect(calls).toEqual(["leave"]);
	});

	it("scheduler: no new chat could be opened: nothing is changed in the paused chat, and nothing is sent", async () => {
		const { svc, calls } = service(false);
		const r = await svc.chatFromScheduler({ id: "job", cwd: "/", prompt: "go", model: "m1", thinkingLevel: "high" });
		expect(r.ok).toBe(false);
		expect(calls).toEqual(["cwd", "leave"]);
	});
});
