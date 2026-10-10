import { describe, expect, it } from "vitest";
import {
	argsOf,
	ownerFacing,
	planQuietRuns,
	type QuietMsg,
	type QuietRun,
	type QuietStamp,
	type QuietSwitches,
	quietMsgOfAgent,
	quietSince,
	quietUnder,
	runAt,
	sentOf,
	starterOf,
} from "../../server/quiet-turns.js";
import { type BoardPostRecord, boardOrderText } from "../../server/role-board.js";
import { FOR_OWNER_TURN_HINT, QUIET_TURN_HINT, roleMessageHint, roleMessageText } from "../../server/role-messages.js";

// quiet-turns (task #96). The owner, 2026-10-10 (relayed by COO in rm-37872561): "in alot of chat, i see
// response to agent's message, like i see an actual output to me in chat, i dont need anything to see, the
// response should be sent to the agent only if needed or just don't respond at all".

type Parts = Parameters<typeof roleMessageText>[0];
const from = { role: "coo", title: "COO", chat: "home chat" };
const roleText = (kind: Parts["kind"], body = "Please look at this.", over: Partial<Parts> = {}, ownerAnswer = false) =>
	roleMessageText(
		{
			id: "rm-0123abcd",
			from,
			text: body,
			kind,
			...(kind === "reply" ? { replyTo: "rm-89abcdef" } : {}),
			...over,
		} as Parts,
		{ ownerAnswer },
	);
const post: BoardPostRecord = {
	id: "bp-00c0ffee",
	seq: 1,
	at: Date.parse("2026-10-10T18:54:00Z"),
	from: "owner",
	via: "product",
	kind: "order",
	to: ["ops"],
	title: "Re-arrange your queue",
	text: "One focus at a time.",
};

const user = (text: string, stamp?: QuietStamp | null): QuietMsg => ({
	role: "user",
	text,
	...(stamp ? { stamp } : {}),
});
const role = (kind: Parts["kind"], body?: string, stamp: QuietStamp | null = { kind }) =>
	user(roleText(kind, body), stamp);
const custom = (text: string, customType = "role-message"): QuietMsg => ({ role: "custom", customType, text });
let seq = 0;
/** An answer: "end" = the final one; calls make it a tool-use step. */
const asst = (calls: [name: string, args?: unknown][] = [], stop?: string): QuietMsg => ({
	role: "assistant",
	stopReason: stop ?? (calls.length ? "toolUse" : "stop"),
	calls: calls.map(([name, args]) => ({ id: `call-${++seq}`, name, args })),
});
const result = (of: QuietMsg, n = 0, over: Partial<QuietMsg> = {}): QuietMsg => ({
	role: "toolResult",
	toolCallId: of.calls?.[n]?.id,
	...over,
});
/** A turn that replies to coo with message_role, then ends with a short answer. */
function replyTurn(starter: QuietMsg): QuietMsg[] {
	const call = asst([["message_role", { to: "coo", kind: "reply", replyTo: "rm-0123abcd", text: "done" }]]);
	return [starter, call, result(call), asst()];
}
const ALL_ON: QuietSwitches = { queueWakes: true, stallPokes: true, scheduledWakes: true };
const only = (msgs: QuietMsg[]): QuietRun => {
	const runs = planQuietRuns(msgs);
	expect(runs).toHaveLength(1);
	return runs[0];
};

describe("quiet-turns: which turns another agent began", () => {
	it("a role's request, question, reply, or an old fyi that started a turn: quiet, one run from the message to the last answer", () => {
		for (const kind of ["request", "question", "reply", "fyi"] as const) {
			const msgs = replyTurn(role(kind));
			const run = only(msgs);
			expect(run).toMatchObject({ row: 0, start: 0, last: 3, kinds: ["role"], visible: false, running: false });
			expect(quietUnder(run)).toBe(true);
			expect(run.sent).toEqual([{ t: "message", kind: "reply", to: "coo" }]);
		}
	});

	it("an order the Board sent directly: quiet", () => {
		const run = only(replyTurn(user(boardOrderText(post, "UTC"))));
		expect(run.kinds).toEqual(["board-order"]);
		expect(quietUnder(run)).toBe(true);
	});

	it("two role messages in one turn (the second steered in while it ran): one quiet run, the second counted as joined", () => {
		const step = asst([["bash", { command: "ls" }]]);
		const msgs = [role("request"), step, result(step), role("question"), asst()];
		const run = only(msgs);
		expect(run).toMatchObject({ start: 0, last: 4, kinds: ["role"], joined: 1, visible: false });
		expect(quietUnder(run)).toBe(true);
	});

	it("an old role message the store no longer keeps (no stamp): its header alone says it came from a role", () => {
		const run = only(replyTurn(role("request", undefined, null)));
		expect(quietUnder(run)).toBe(true);
		// a stamp-less "[Role message" with a header the server never writes stays in full
		expect(starterOf(user("[Role message rm-0123abcd from someone] hi"))).toBe("visible");
		expect(starterOf(user("[Role message ] typed by hand"))).toBe("visible");
	});

	it("stays in full: a reply answering a question asked for the owner (by stamp, or by its hint line when the store forgot it)", () => {
		const stamped = only(replyTurn(role("reply", "Here is the answer.", { kind: "reply", forOwner: true })));
		expect(stamped.visible).toBe(true);
		expect(quietUnder(stamped, ALL_ON)).toBe(false);
		const old = only(replyTurn(user(roleText("reply", "Here is the answer.", {}, true))));
		expect(quietUnder(old, ALL_ON)).toBe(false);
		// the same reply without the owner's question behind it folds
		expect(quietUnder(only(replyTurn(user(roleText("reply", "Here is the answer.")))))).toBe(true);
	});

	it("stays in full: the app's 6 am report request (by stamp or header), and plugin sends such as the morning brief", () => {
		const report = roleMessageText({
			id: "rm-0badcafe",
			from: { role: "the app", title: "pi-web-ui", chat: "home chat" },
			kind: "report",
			report: { date: "2026-10-10" },
			text: "Write your 6 am report.",
		} as Parts);
		expect(report.split("\n")[0]).toMatch(/from the app · 6 am report/);
		expect(quietUnder(only(replyTurn(user(report, { kind: "report" }))), ALL_ON)).toBe(false);
		expect(quietUnder(only(replyTurn(user(report))), ALL_ON)).toBe(false);
		expect(quietUnder(only(replyTurn(user("Morning brief for Saturday: three things need you."))), ALL_ON)).toBe(false);
	});

	it("stays in full: the owner typed while a role's turn ran, or his message started it", () => {
		const step = asst([["bash"]]);
		const joined = only([role("request"), step, result(step), user("also check the logs"), asst()]);
		expect(joined.visible).toBe(true);
		expect(quietUnder(joined, ALL_ON)).toBe(false);
		// his own `!` command is never folded either
		const runs = planQuietRuns([{ role: "bashExecution" }, ...replyTurn(role("request"))]);
		expect(runs.map((r) => quietUnder(r))).toEqual([true]);
		expect(starterOf({ role: "bashExecution" })).toBe("visible");
	});

	it("an FYI entry is not a turn: the owner's next message starts his own, shown in full; a role's next message folds", () => {
		const fyi = custom(roleText("fyi"));
		const runs = planQuietRuns([fyi, user("what's new?"), asst()]);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({ start: 1, visible: true });
		expect(runAt(runs, 0)).toBeNull();
		const quiet = planQuietRuns([fyi, ...replyTurn(role("question"))]);
		expect(quiet[0].start).toBe(1);
		expect(quietUnder(quiet[0])).toBe(true);
	});

	it("a \"[Board]\" note riding on the owner's message leaves his turn in full; on a role's message it is part of the fold", () => {
		const note = custom("[Board] 2 new posts", "board");
		const own = planQuietRuns([user("hi"), note, asst()]);
		expect(own[0]).toMatchObject({ start: 0, last: 2, visible: true });
		const roleTurn = planQuietRuns([role("request"), note, asst()]);
		expect(roleTurn[0]).toMatchObject({ start: 0, last: 2, visible: false });
		expect(quietUnder(roleTurn[0])).toBe(true);
	});

	it("entries after a turn's last answer stay outside it", () => {
		const runs = planQuietRuns([...replyTurn(role("request")), custom(roleText("fyi"))]);
		expect(runs[0].last).toBe(3);
		expect(runAt(runs, 4)).toBeNull();
	});
});

describe("quiet-turns: the kinds the owner decides on (switches, default off)", () => {
	const queueWake = user('[Queue] Task #12 (Fix the (big) thing) is done in its chat "Fix it": done. Its summary: ok.');
	const queueWakes = user("[Queue] 2 tasks are done in their chats:\n- #3 ...");
	const stall = role("question", "[Stall check] Your task #40 has had no news for 2 hours. Is it still going?");
	const scheduled = user("[Scheduled task nightly check] Look at the backups and report.");
	const cases: [string, QuietMsg, keyof QuietSwitches, string][] = [
		["a finished queue task waking its main chat", queueWake, "queueWakes", "queue-wake"],
		["several finished queue tasks", queueWakes, "queueWakes", "queue-wake"],
		["a stall-check poke", stall, "stallPokes", "stall-poke"],
		["a scheduled wake-up", scheduled, "scheduledWakes", "scheduled"],
	];
	for (const [what, msg, sw, kind] of cases) {
		it(`${what}: in full while its switch is off, folded when on`, () => {
			const run = only(replyTurn(msg));
			expect(run.kinds).toEqual([kind]);
			expect(quietUnder(run)).toBe(false);
			expect(quietUnder(run, { [sw]: false })).toBe(false);
			expect(quietUnder(run, { [sw]: true })).toBe(true);
			// the other switches don't fold it
			const others = Object.fromEntries(
				(["queueWakes", "stallPokes", "scheduledWakes"] as const).filter((k) => k !== sw).map((k) => [k, true]),
			);
			expect(quietUnder(run, others)).toBe(false);
		});
	}

	it("a turn a role began and a queue notice joined folds only when that switch is on", () => {
		const step = asst([["bash"]]);
		const run = only([role("request"), step, result(step), queueWake, asst()]);
		expect(run.kinds).toEqual(["role", "queue-wake"]);
		expect(quietUnder(run)).toBe(false);
		expect(quietUnder(run, { queueWakes: true })).toBe(true);
	});

	it("other [Queue] messages (a task handed to its chat, a task asking) and old scheduled prompts", () => {
		expect(starterOf(user("[Queue] Task #96: Quiet agent turns\n\nYou're working on this task..."))).toBe("visible");
		expect(starterOf(user("[Queue] Task #40 asks: which port?"))).toBe("visible");
		expect(starterOf(user("[定时任务 nightly] look"))).toEqual({ kind: "scheduled" });
		expect(starterOf(user("(System notice) something"))).toBe("neutral");
	});
});

describe("quiet-turns: what stays outside the fold, and what the row says", () => {
	it("a question dialog or a Needs-you item in a quiet turn is kept out of the fold", () => {
		const ask = asst([["ask_user_question", { questions: [{ id: "a", question: "Which?" }] }]]);
		const tl = asst([["tldr", { text: "Need your pick", needs_you: true }]]);
		const plain = asst([["tldr", { text: "Started" }]]);
		const stuck = asst([["queue_stuck", { question: "Which?", choices: ["a", "b"] }]]);
		const passOn = asst([["queue_reply", { id: 4, question: "Which?", choices: ["a", "b"] }]]);
		const answer = asst([["queue_reply", { id: 4, answer: "Carry on" }]]);
		const msgs = [role("request"), ask, result(ask), tl, result(tl), plain, result(plain), stuck, result(stuck)];
		msgs.push(passOn, result(passOn), answer, result(answer), asst());
		const run = only(msgs);
		expect(quietUnder(run)).toBe(true);
		expect(run.keep).toEqual([1, 3, 7, 9]);
		expect(run.sent).toEqual([
			{ t: "passed", n: 4 },
			{ t: "answered", n: 4 },
		]);
	});

	it("the row lists what the turn sent, each once; failed calls and reads don't count", () => {
		const m1 = asst([
			["message_role", { to: "coo", kind: "reply", text: "a" }],
			["board", { action: "ack", id: "bp-00c0ffee", note: "done" }],
			["read", { path: "x" }],
		]);
		const m2 = asst([
			["message_role", { to: "coo", kind: "reply", text: "b" }],
			["queue_add", { title: "t", goal: "g" }],
			["message_role", { to: "qa", kind: "fyi", text: "c" }],
		]);
		const m3 = asst([
			["queue_add", { id: 12, steps: "new" }],
			["board", { action: "read" }],
		]);
		const msgs = [user(boardOrderText(post, "UTC")), m1, result(m1, 0), result(m1, 1), result(m1, 2)];
		msgs.push(
			m2,
			result(m2, 0),
			result(m2, 1, { details: { accepted: true, id: 97 } }),
			result(m2, 2, { isError: true }),
		);
		msgs.push(m3, result(m3, 0), result(m3, 1), asst());
		expect(only(msgs).sent).toEqual([
			{ t: "message", kind: "reply", to: "coo" },
			{ t: "ack", id: "bp-00c0ffee" },
			{ t: "queued", n: 97 },
			{ t: "plan", n: 12 },
		]);
		// nothing sent; a plan the owner refused isn't a queued task
		const refused = asst([["queue_add", { title: "t" }]]);
		expect(only([role("request"), refused, result(refused, 0, { details: { accepted: false } }), asst()]).sent).toEqual(
			[],
		);
	});

	it("a failed or stopped turn says so; a turn still going says it is running", () => {
		expect(only([role("request"), asst([], "error")]).ended).toBe("error");
		expect(only([role("request"), asst([], "aborted")]).ended).toBe("aborted");
		// a retry after an error that then works ends fine
		expect(only([role("request"), asst([], "error"), asst()]).ended).toBeUndefined();
		const step = asst([["bash"]]);
		expect(only([role("request"), step]).running).toBe(true);
		expect(only([role("request"), step, result(step)]).running).toBe(true);
		expect(only([role("request")]).running).toBe(true);
	});

	it("a window that starts inside a turn takes the turn it began in (lead)", () => {
		const step = asst([["bash"]]);
		const runs = planQuietRuns([result(step), asst(), ...replyTurn(user("hi"))], { kinds: ["role"], visible: false });
		expect(runs[0]).toMatchObject({ row: -1, start: 0, last: 1, kinds: ["role"] });
		expect(quietUnder(runs[0])).toBe(true);
		expect(runs[1]).toMatchObject({ row: 2, visible: true });
		// without a lead, a window starting with an answer is shown in full
		expect(planQuietRuns([asst(), ...replyTurn(user("hi"))])[0]).toMatchObject({ row: 0, visible: true });
	});

	it("quietSince: the runs touched from a point on, all quiet (the server asks when a turn ends)", () => {
		const msgs = [...replyTurn(user("hi")), ...replyTurn(role("request"))];
		expect(quietSince(msgs, 4)).toBe(true);
		expect(quietSince(msgs, 3)).toBe(false);
		expect(quietSince(msgs, 8)).toBe(false);
		expect(quietSince([...replyTurn(user("[Scheduled task x] y"))], 0, { scheduledWakes: true })).toBe(true);
	});
});

describe("quiet-turns: tool call arguments as the page has them (JSON text, maybe cut short)", () => {
	it("reads whole JSON and the fields of cut-short JSON", () => {
		expect(argsOf('{"to":"coo","kind":"reply","text":"x"}')).toEqual({ to: "coo", kind: "reply", text: "x" });
		expect(argsOf('{"to":"coo","kind":"reply","replyTo":"rm-1","text":"a long answer that was cut sh')).toEqual({
			to: "coo",
			kind: "reply",
		});
		expect(argsOf('{"action":"ack","id":"bp-00c0ffee","note":"cut')).toEqual({ action: "ack", id: "bp-00c0ffee" });
		expect(argsOf('{"text":"x","needs_you":true')).toEqual({ needs_you: true });
		expect(argsOf('{"id":12,"steps":"cut')).toEqual({ id: 12 });
		expect(argsOf(undefined)).toEqual({});
		expect(argsOf("[1,2]")).toEqual({});
	});

	it("sentOf and ownerFacing from JSON text", () => {
		expect(sentOf({ id: "1", name: "message_role", args: '{"to":"qa","kind":"request","text":"…' }, {})).toEqual({
			t: "message",
			kind: "request",
			to: "qa",
		});
		expect(sentOf({ id: "1", name: "board", args: '{"action":"close","id":"bp-1"}' }, {})).toEqual({
			t: "close",
			id: "bp-1",
		});
		expect(sentOf({ id: "1", name: "board", args: '{"action":"post","kind":"news"}' }, {})).toEqual({ t: "post" });
		expect(sentOf({ id: "1", name: "queue_done", args: "{}" }, {})).toEqual({ t: "done" });
		expect(sentOf({ id: "1", name: "bash", args: "{}" }, {})).toBeNull();
		expect(ownerFacing({ id: "1", name: "tldr", args: '{"text":"x","needs_you":true}' })).toBe(true);
		expect(ownerFacing({ id: "1", name: "tldr", args: '{"text":"x"}' })).toBe(false);
	});
});

describe("quiet-turns: transcript messages (the server's view)", () => {
	it("quietMsgOfAgent reads user text, stamps, tool calls and results", () => {
		const text = roleText("request");
		const stampOf = () => ({ kind: "request" }) as QuietStamp;
		expect(quietMsgOfAgent({ role: "user", content: [{ type: "text", text }] }, stampOf)).toEqual({
			role: "user",
			text,
			stamp: { kind: "request" },
		});
		expect(quietMsgOfAgent({ role: "user", content: "hi" }, stampOf)).toEqual({ role: "user", text: "hi" });
		expect(
			quietMsgOfAgent({
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "thinking", thinking: "x" },
					{ type: "toolCall", id: "t1", name: "board", arguments: { action: "ack", id: "bp-1" } },
				],
			}),
		).toEqual({
			role: "assistant",
			stopReason: "toolUse",
			calls: [{ id: "t1", name: "board", args: { action: "ack", id: "bp-1" } }],
		});
		expect(quietMsgOfAgent({ role: "toolResult", toolCallId: "t1", isError: false, details: { id: 3 } })).toEqual({
			role: "toolResult",
			toolCallId: "t1",
			isError: false,
			details: { id: 3 },
		});
		expect(quietMsgOfAgent({ role: "custom", customType: "board", content: "[Board] 1 new post" })).toEqual({
			role: "custom",
			customType: "board",
			text: "[Board] 1 new post",
		});
	});
});

describe("quiet-turns: the hint lines tell a role to write nothing for the owner", () => {
	const base = { id: "rm-0123abcd", from, text: "x" } as const;
	it("question, request, reply and fyi say the owner doesn't read the turn; request keeps its reply-once rule", () => {
		for (const kind of ["question", "request", "reply"] as const) {
			expect(roleMessageHint({ ...base, kind, replyTo: "rm-89abcdef" } as Parts)).toContain(QUIET_TURN_HINT);
		}
		expect(roleMessageHint({ ...base, kind: "request" } as Parts)).toContain("then reply once, with message_role");
		expect(roleMessageHint({ ...base, kind: "question" } as Parts)).toMatch(
			/^\(Answer it once, with message_role .*\)$/,
		);
		expect(roleMessageHint({ ...base, kind: "fyi" } as Parts)).toBe(
			"(An FYI from another role, added without a turn of its own: no reply needed. Write nothing for the owner about it; if the sender needs an answer, send it with message_role.)",
		);
		expect(QUIET_TURN_HINT).toBe(
			"The owner doesn't read this turn: write nothing for him. If the sender needs an answer, send it with message_role; otherwise end the turn without a summary.",
		);
	});

	it("a reply answering a question asked for the owner says its answer goes to him in full; the report request is unchanged", () => {
		const hint = roleMessageHint({ ...base, kind: "reply", replyTo: "rm-89abcdef" } as Parts, { ownerAnswer: true });
		expect(hint).toBe(`(The answer to your message rm-89abcdef: no need to answer it. ${FOR_OWNER_TURN_HINT})`);
		expect(hint).not.toContain(QUIET_TURN_HINT);
		expect(FOR_OWNER_TURN_HINT).toBe(
			"This answers a question you asked for the owner: your answer in this turn goes to him in full.",
		);
		expect(roleMessageHint({ ...base, kind: "report" } as Parts)).toBe(
			"(The app's 6 am report request: your answer in this chat is the report the owner reads. No message_role, no new work, no tasks started.)",
		);
	});

	it("a Board order's turn says the same; steered into a running turn it adds nothing for the owner", () => {
		const turn = boardOrderText(post, "UTC");
		expect(turn).toContain(
			`It asks for no reply. ${QUIET_TURN_HINT})\nWhen you have acted on it: board ack bp-00c0ffee`,
		);
		const steer = boardOrderText(post, "UTC", "steer");
		expect(steer).toContain("It asks for no reply: write nothing for the owner about it.)\nWhen you have acted on it:");
		expect(steer).not.toContain(QUIET_TURN_HINT);
	});
});
