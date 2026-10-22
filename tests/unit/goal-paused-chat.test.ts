/**
 * queue-back-owed (Ops #393): a goal review's result goes into a queued task's chat the owner paused (or one still
 * owed its "Back to task" note) without a turn; elsewhere as the user's message, as before.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type GoalHost, GoalService } from "../../server/goal-service.js";

function setup(paused: (file: string) => { ok: boolean; error?: string } | undefined) {
	const notes: Array<[string, string]> = [];
	const sent: Array<[string, unknown]> = [];
	const host = {
		clientId: "c1",
		stateStore: { getGoalPrefs: () => undefined },
		pausedChatNote: async (file: string, text: string) => {
			const r = paused(file);
			if (r) notes.push([file, text]);
			return r;
		},
	} as unknown as GoalHost;
	const svc = new GoalService(host);
	const session = {
		sessionFile: "/s/task.jsonl",
		isStreaming: false,
		sendUserMessage: async (text: string, opts: unknown) => {
			sent.push([text, opts]);
		},
	} as unknown as AgentSession;
	const send = (text: string) => svc["sendReview"](session, text);
	return { notes, sent, send };
}

describe("goal review results in a paused task's chat (Ops #393)", () => {
	it("a paused or back-owed task's chat: added without a turn", async () => {
		const t = setup(() => ({ ok: true }));
		await t.send("Goal failed review");
		expect(t.notes).toEqual([["/s/task.jsonl", "Goal failed review"]]);
		expect(t.sent).toEqual([]);
	});

	it("the chat couldn't take it: an error, and still no turn", async () => {
		const t = setup(() => ({ ok: false, error: "closed" }));
		await expect(t.send("x")).rejects.toThrow("closed");
		expect(t.sent).toEqual([]);
	});

	it("any other chat: the user's message, as before", async () => {
		const t = setup(() => undefined);
		await t.send("Goal achieved");
		expect(t.notes).toEqual([]);
		expect(t.sent).toEqual([["Goal achieved", { deliverAs: "followUp" }]]);
	});
});
