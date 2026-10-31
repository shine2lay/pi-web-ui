// The read-only measures of Ops #688's two hypotheses: role-started turns and their status lines
// (server/turn-status-stats.ts), the lengths of agent-written text (server/agent-text-stats.ts), the shared
// size summary (server/size-summary.ts) and the scripts' window and check mode (scripts/stats-window.mts).
import { describe, expect, it } from "vitest";
import { agentTextSummary, boardPostSizes, roleMessageSizes, sizesInWindow } from "../../server/agent-text-stats.js";
import { type BoardPostRecord, boardOrderText } from "../../server/role-board.js";
import { roleMessageText } from "../../server/role-messages.js";
import { percentChange, sizeSummary } from "../../server/size-summary.js";
import { roleTurnsOf, turnStatusSummary, turnsInWindow } from "../../server/turn-status-stats.js";
import { checkExitOf, statsWindowOf } from "../../scripts/stats-window.mjs";

type Parts = Parameters<typeof roleMessageText>[0];
const from = { role: "coo", title: "COO", chat: "home chat" };
const T0 = Date.parse("2026-10-31T12:00:00Z");
let n = 0;
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const entry = (min: number, message: Record<string, unknown>) => ({
	type: "message",
	id: `e${++n}`,
	timestamp: at(min),
	message,
});
const user = (min: number, text: string) => entry(min, { role: "user", content: [{ type: "text", text }] });
const answer = (min: number, text: string | null, stop = "stop", model = "claude-opus-4-5") =>
	entry(min, {
		role: "assistant",
		model,
		stopReason: stop,
		content: [
			...(text === null ? [] : [{ type: "text", text }]),
			...(stop === "toolUse" ? [{ type: "toolCall", id: `c${n}`, name: "message_role", arguments: {} }] : []),
		],
	});
const result = (min: number) =>
	entry(min, { role: "toolResult", toolCallId: `c${n - 1}`, isError: false, content: [{ type: "text", text: "ok" }] });
const identity = (id: string) => ({ type: "custom", customType: "identity", timestamp: at(0), data: { id } });
const roleMsg = (kind: Parts["kind"], over: Partial<Parts> = {}, ownerAnswer = false) =>
	roleMessageText({ id: `rm-0000000${(n % 9) + 1}`, from, text: "Please look.", kind, ...over } as Parts, {
		ownerAnswer,
	});
const post: BoardPostRecord = {
	id: "bp-00c0ffee",
	seq: 1,
	at: T0,
	from: "owner",
	via: "coo",
	kind: "order",
	to: ["ops"],
	title: "Status lines",
	text: "One line per turn.",
};

const LONG = "Got the answer. I'll use port 8080 and carry on with the deploy next.";

describe("roleTurnsOf: which turns another role started, and whether their only text is status lines", () => {
	it("counts role questions, requests, replies and Board orders; checks the whole turn's text", () => {
		const turns = roleTurnsOf([
			identity("ops"),
			user(1, roleMsg("question")),
			answer(2, null, "toolUse"),
			result(2),
			answer(3, "ANSWERED"),
			user(10, roleMsg("request")),
			answer(11, "Looking at the queue first.", "toolUse"), // narration between tool calls counts
			result(11),
			answer(12, "QUEUED #12"),
			user(20, boardOrderText(post, "UTC")),
			answer(21, "DONE"),
			user(30, roleMsg("reply", { replyTo: "rm-89abcdef" })),
			answer(31, LONG),
		]);
		expect(turns.map((t) => [t.statusOnly, t.textChars, t.role, t.model])).toEqual([
			[true, 8, "ops", "claude-opus-4-5"],
			[false, "Looking at the queue first.\nQUEUED #12".length, "ops", "claude-opus-4-5"],
			[true, 4, "ops", "claude-opus-4-5"],
			[false, LONG.length, "ops", "claude-opus-4-5"],
		]);
		expect(turns[0]!.at).toBe(Date.parse(at(1)));
	});

	it("leaves out the owner's turns, answers for him, FYIs between turns, queue cards, wake-ups and unfinished turns", () => {
		const turns = roleTurnsOf([
			user(1, "Owner typed this."),
			answer(2, "A long answer for the owner."),
			user(5, roleMsg("reply", { replyTo: "rm-89abcdef" }, true)),
			answer(6, "Here is what Temper said, in full."),
			{ type: "custom_message", customType: "role-message", timestamp: at(7), content: "fyi" },
			user(8, '[Queue] Task #12 (x) is done in its chat "y".'),
			answer(9, "Noted."),
			user(10, "[Scheduled task check] look"),
			answer(11, "Checked."),
			user(20, roleMsg("question")),
			answer(21, "ANSWERED", "error"),
			user(30, roleMsg("request")),
			answer(31, null, "toolUse"),
		]);
		expect(turns).toEqual([]);
	});

	it("a role turn the owner joins is his", () => {
		const turns = roleTurnsOf([
			user(1, roleMsg("request")),
			answer(2, null, "toolUse"),
			user(2, "Owner: also do X."),
			result(2),
			answer(3, "Did both: X and the request."),
		]);
		expect(turns).toEqual([]);
	});

	it("summarises by window, role and model, oldest first, cut to the first N", () => {
		const turns = [
			...roleTurnsOf([identity("ops"), user(1, roleMsg("question")), answer(2, "ANSWERED")]),
			...roleTurnsOf([
				identity("qa"),
				user(5, roleMsg("request")),
				answer(6, "Done, replied with the numbers.", "stop", "gpt-5"),
				user(9, roleMsg("request")),
				answer(10, "DONE", "stop", "gpt-5"),
			]),
		];
		const inside = turnsInWindow(turns, T0, T0 + 3_600_000);
		expect(inside.map((t) => t.at)).toEqual([1, 5, 9].map((m) => Date.parse(at(m))));
		expect(turnsInWindow(turns, T0, T0 + 3_600_000, 2)).toHaveLength(2);
		expect(turnsInWindow(turns, Date.parse(at(4)), Date.parse(at(9)))).toHaveLength(1);
		const s = turnStatusSummary(inside);
		expect(s).toMatchObject({ turns: 3, statusOnly: 2, statusOnlyShare: 66.7, textChars: { n: 3, median: 8 } });
		expect(s.byRole.qa).toMatchObject({ turns: 2, statusOnly: 1, statusOnlyShare: 50 });
		expect(s.byModel["claude-opus-4-5"]).toMatchObject({ turns: 1, statusOnly: 1 });
		expect(JSON.stringify(s)).not.toContain("replied with the numbers");
	});
});

describe("agent-text-stats: lengths of agent-written text", () => {
	const msgs = [
		{ id: "rm-1", at: 3, kind: "reply", from: { role: "qa" }, text: "x".repeat(30) },
		{ id: "rm-2", at: 1, kind: "question", from: { role: "coo" }, text: "x".repeat(10) },
		{ id: "rm-3", at: 2, kind: "report", from: { role: "app" }, text: "x".repeat(999) },
		{ id: "rm-4", at: 4, kind: "question", from: { role: "ops" }, text: "x".repeat(20) },
	];
	it("leaves out the app's own sends, sorts by time, splits by kind", () => {
		const sizes = roleMessageSizes(msgs);
		expect(sizes.map((s) => s.chars)).toEqual([10, 30, 20]);
		const s = agentTextSummary(sizesInWindow(sizes, 0, 10), boardPostSizes([{ at: 1, kind: "news", text: "abc" }]));
		expect(s.messages).toMatchObject({ n: 3, median: 20, p90: 30 });
		expect(s.messages.byKind).toEqual({
			question: { n: 2, mean: 15, median: 10, p90: 20 },
			reply: { n: 1, mean: 30, median: 30, p90: 30 },
		});
		expect(s.board).toMatchObject({ n: 1, median: 3, byKind: { news: { n: 1, mean: 3, median: 3, p90: 3 } } });
		expect(sizesInWindow(sizes, 2, 4)).toHaveLength(1);
		expect(sizesInWindow(sizes, 0, 10, 2).map((x) => x.chars)).toEqual([10, 30]);
	});
});

describe("size-summary", () => {
	it("nearest-rank median and p90; the change in percent", () => {
		expect(sizeSummary([])).toEqual({ n: 0, mean: null, median: null, p90: null });
		expect(sizeSummary([5])).toEqual({ n: 1, mean: 5, median: 5, p90: 5 });
		expect(sizeSummary([10, 1, 9, 2, 8, 3, 7, 4, 6, 5])).toEqual({ n: 10, mean: 5.5, median: 5, p90: 9 });
		expect(sizeSummary([0, 0, 1]).mean).toBe(0.3);
		expect(percentChange(1000, 150)).toBe(-85);
		expect(percentChange(null, 1)).toBeNull();
		expect(percentChange(0, 1)).toBeNull();
	});
});

describe("stats-window: the scripts' window and check mode", () => {
	const now = Date.parse("2026-11-01T00:00:00Z");
	it("reads the window; check mode passes on the count or after the time", () => {
		const w = statsWindowOf(["--since", "2026-10-31T00:00:00Z", "--first", "100"], now);
		expect(w).toEqual({ since: Date.parse("2026-10-31T00:00:00Z"), until: now, first: 100 });
		expect(checkExitOf(w, 3, now)).toBeUndefined();
		const c = statsWindowOf(
			["--since", "2026-10-31T00:00:00Z", "--at-least", "100", "--or-after", "2026-11-02T00:00:00Z"],
			now,
		);
		expect(checkExitOf(c, 99, now)).toBe(1);
		expect(checkExitOf(c, 100, now)).toBe(0);
		expect(checkExitOf(c, 0, Date.parse("2026-11-02T00:00:00Z"))).toBe(0);
	});
	it("refuses a missing or bad value", () => {
		expect(() => statsWindowOf([], now)).toThrow("--since");
		expect(() => statsWindowOf(["--since", "yesterday"], now)).toThrow("ISO time");
		expect(() => statsWindowOf(["--since", "2026-10-31", "--first", "0"], now)).toThrow("whole number");
		expect(() => statsWindowOf(["--since", "2026-10-31", "--at-least"], now)).toThrow("needs a value");
	});
});
