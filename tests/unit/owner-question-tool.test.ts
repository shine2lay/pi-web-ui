/**
 * owner-question-routing (Ops #686, H-OWNER-COO-CARD): owner_question, COO's tool. Each action, each
 * refusal (another chat, routing off, a note holding an id, path or code, return on a stuck card, pop-up
 * or tool approval, a hold over 2 hours), answered and gone asks reported as such, and no way to answer
 * for the owner. Runs on a real AskHub and hold store; no chat, no model.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalAsk, dialogAsk, stuckAsk } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import { holdKeyOfAsk } from "../../server/owner-question-holds.js";
import {
	isCooHomeChat,
	makeOwnerQuestionTool,
	ONLY_IN_COO_HOME,
	OWNER_QUESTION_TOOL,
	ownerTextProblem,
	parseHoldUntil,
	ROUTING_OFF,
} from "../../server/owner-question-tool.js";
import { deskFixture, MIN, portQuestion as q, T0 } from "./owner-question-desk-fixture.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oq-tool-"));
	vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

type Result = { content: Array<{ type: string; text: string }>; details: { ok: boolean; [k: string]: unknown } };

function setup(opts: { inCoo?: boolean; noDesk?: boolean } = {}) {
	const f = deskFixture(dir);
	const tool = makeOwnerQuestionTool({
		inCooHomeChat: () => opts.inCoo ?? true,
		desk: () => (opts.noDesk ? undefined : f.desk),
		now: () => f.s.now,
		tz: "UTC",
	});
	const call = async (
		params: Record<string, unknown>,
	): Promise<{ text: string; ok: boolean; details: Result["details"] }> => {
		const r = (await tool.execute("t1", params as never, undefined, undefined, {} as never)) as unknown as Result;
		return { text: r.content.map((c) => c.text).join("\n"), ok: r.details.ok, details: r.details };
	};
	return { ...f, tool, call };
}

const stuck = (id: string) =>
	stuckAsk(id, { taskId: 12, taskTitle: "New fonts", question: "Buy the font licence?" }, {}, T0);

describe("only in COO's home chat, only with routing on", () => {
	it("isCooHomeChat: COO's home chat and nothing else", () => {
		const def = (id: string, homeChat: string | null): IdentityDef =>
			({
				id,
				title: id,
				folder: null,
				homeChat,
				pastHomeChats: [],
				raw: {},
				role: {} as never,
				dir: "",
			}) as IdentityDef;
		const ids = [def("coo", "/s/coo-home.jsonl"), def("design", "/s/design-home.jsonl"), def("ops", null)];
		expect(isCooHomeChat("/s/coo-home.jsonl", ids)).toBe(true);
		expect(isCooHomeChat("/s/design-home.jsonl", ids)).toBe(false);
		expect(isCooHomeChat("/s/some-task-chat.jsonl", ids)).toBe(false);
		expect(isCooHomeChat(undefined, ids)).toBe(false);
	});

	it("another chat: every action refused, nothing changes", async () => {
		const { call, hold, hub } = setup({ inCoo: false });
		const tag = hold(q("q-1"));
		for (const params of [
			{ action: "list" },
			{ action: "release", id: tag, note: "Design needs a port picked." },
			{ action: "hold", id: tag, until: "30m", why: "asking Design" },
			{ action: "return", id: tag, note: "Pick it yourself." },
		]) {
			const r = await call(params);
			expect(r).toMatchObject({ ok: false, text: ONLY_IN_COO_HOME });
		}
		expect(hub.heldList().map((a) => a.id)).toEqual(["q-1"]);
	});

	it("switch off: the tool says routing is off", async () => {
		const { call, s } = setup();
		s.on = false;
		expect(await call({ action: "list" })).toMatchObject({ ok: false, text: ROUTING_OFF, details: { routing: "off" } });
		for (const action of ["release", "hold", "return"]) {
			expect(
				await call({ action, id: "oq-deadbeef", note: "Plain words.", until: "30m", why: "Context" }),
			).toMatchObject({ ok: false, text: ROUTING_OFF });
		}
		const none = setup({ noDesk: true });
		expect(await none.call({ action: "list" })).toMatchObject({ ok: false, text: ROUTING_OFF });
	});

	it("the tool's actions are list, release, hold and return: none answers for the owner", () => {
		const { tool } = setup();
		expect(tool.name).toBe(OWNER_QUESTION_TOOL);
		const action = (tool.parameters as { properties: { action: { anyOf: Array<{ const: string }> } } }).properties
			.action;
		expect(action.anyOf.map((a) => a.const)).toEqual(["list", "release", "hold", "return"]);
		const guidance = [tool.description, ...(tool.promptGuidelines ?? [])].join("\n");
		expect(guidance).toMatch(/never answer/i);
		for (const w of ["consent", "spending", "publishing", "pauses", "stops"]) expect(guidance).toContain(w);
		expect(guidance).toMatch(/return only when/i);
	});
});

describe("list", () => {
	it("nothing held", async () => {
		const { call } = setup();
		expect(await call({ action: "list" })).toMatchObject({ ok: true, text: "Nothing is held for you now." });
	});

	it("each held one: tag, who, kind, question, when it goes", async () => {
		const { call, hold } = setup();
		const a = hold(q("q-1"));
		const b = hold(stuck("st-2"), "queued-work");
		await call({ action: "hold", id: b, until: "45m", why: "asking Design" });
		const r = await call({ action: "list" });
		expect(r.ok).toBe(true);
		expect(r.details.held).toEqual([a, b]);
		const [, lineA, lineB] = r.text.split("\n");
		expect(lineA).toContain(`${a} · Design's home chat · question · “Which port?” · goes to the owner at`);
		expect(lineA).toContain("card not delivered yet");
		expect(lineB).toContain(`${b} · Design's home chat · queued task's card`);
		expect(lineB).toContain("you hold it until 09:45");
		expect(lineB).toContain("(asking Design)");
	});
});

describe("release", () => {
	it("goes to the owner with COO's note and recommendation, by coo", async () => {
		const { call, hold, hub, holds, s } = setup();
		const tag = hold(q("q-1"));
		const r = await call({
			action: "release",
			id: tag,
			note: "Design needs one port picked before it can finish the page.",
			recommendation: "The first one, it is what the other apps use.",
		});
		expect(r).toMatchObject({ ok: true });
		expect(r.text).toContain("went to the owner with your note first and your recommendation");
		expect(hub.list().map((a) => a.id)).toEqual(["q-1"]);
		expect(s.events).toContainEqual(expect.objectContaining({ type: "released", by: "coo" }));
		expect(holds.get(holdKeyOfAsk("q-1"))).toMatchObject({
			state: "released",
			releasedBy: "coo",
			note: "Design needs one port picked before it can finish the page.",
			recommendation: "The first one, it is what the other apps use.",
		});
		expect(s.answered).not.toHaveBeenCalled();
	});

	it.each([
		["an id", "Task #686 needs a port picked.", "an id (#686)"],
		["a record id", "See rm-fbbc87f6 for why.", "an id (rm-fbbc87f6)"],
		["an alphabetic owner-question tag", "Review oq-deadbeef first.", "an id (oq-deadbeef)"],
		["a numeric owner-question tag", "Review oq-12345678 first.", "an id (oq-12345678)"],
		["a path", "The setting lives in /home/shinelay/.pi-web-ui/settings.json now.", "a path"],
		["code", "Run `pi-web-deploy` after.", "code"],
	])("refused: a note holding %s; it stays held", async (_what, note, named) => {
		const { call, hold, hub } = setup();
		const tag = hold(q("q-1"));
		const r = await call({ action: "release", id: tag, note });
		expect(r.ok).toBe(false);
		expect(r.text).toContain("isn't plain words");
		expect(r.text).toContain(named);
		expect(hub.heldList().map((a) => a.id)).toEqual(["q-1"]);
	});

	it("refused: no note, a note over 600 characters, a recommendation with a path", async () => {
		const { call, hold, hub } = setup();
		const tag = hold(q("q-1"));
		expect((await call({ action: "release", id: tag })).text).toMatch(/needs a note/);
		expect((await call({ action: "release", id: tag, note: "word ".repeat(130) })).text).toMatch(
			/characters; at most 600/,
		);
		const rec = await call({
			action: "release",
			id: tag,
			note: "Plain note.",
			recommendation: "Edit src/app/main.ts first.",
		});
		expect(rec.ok).toBe(false);
		expect(rec.text).toContain("The recommendation isn't plain words");
		expect(hub.heldList()).toHaveLength(1);
	});

	it.each(["oq-deadbeef", "oq-12345678"])("refuses %s in a recommendation too", async (id) => {
		const { call, hold, hub } = setup();
		const tag = hold(q("q-1"));
		expect(
			await call({ action: "release", id: tag, note: "Plain words.", recommendation: `Check ${id} first.` }),
		).toMatchObject({ ok: false });
		expect(hub.heldList()).toHaveLength(1);
	});

	it("already answered, gone, released or unknown: said so, nothing sent", async () => {
		const { call, hold, hub } = setup();
		const a = hold(q("q-1"));
		const b = hold(q("q-2"));
		const c = hold(q("q-3"));
		await call({ action: "list" });
		hub.settle("q-1", { how: "answered", summary: "8080", from: "browser" });
		hub.settle("q-2", { how: "gone", reason: "the chat closed" });
		await call({ action: "release", id: c, note: "Plain note." });
		expect((await call({ action: "release", id: a, note: "Plain note." })).text).toBe(
			`${a} is already answered: nothing to do.`,
		);
		expect((await call({ action: "release", id: b, note: "Plain note." })).text).toContain(`${b} is gone`);
		expect((await call({ action: "release", id: c, note: "Plain note." })).text).toBe(
			`${c} is already with the owner: you let it through.`,
		);
		expect((await call({ action: "release", id: "oq-00000000", note: "Plain note." })).text).toContain(
			"Nothing held is called oq-00000000",
		);
	});
});

describe("hold", () => {
	it("until a time at most 2 hours away, recorded in the store, renewable", async () => {
		const { call, hold, holds, s } = setup();
		const tag = hold(q("q-1"));
		const r = await call({ action: "hold", id: tag, until: "45m", why: "asking Design what it already tried" });
		expect(r).toMatchObject({ ok: true, details: { until: T0 + 45 * MIN } });
		expect(r.text).toContain("held until 09:45");
		expect(holds.get(holdKeyOfAsk("q-1"))?.holdUntil).toBe(T0 + 45 * MIN);
		s.now = T0 + 40 * MIN;
		const again = await call({ action: "hold", id: tag, until: "2h", why: "still waiting on Design" });
		expect(again).toMatchObject({ ok: true, details: { until: T0 + 160 * MIN } });
		expect(holds.get(holdKeyOfAsk("q-1"))?.holdUntil).toBe(T0 + 160 * MIN);
	});

	it("refused: over 2 hours, a time passed, no reason, no time", async () => {
		const { call, hold, holds } = setup();
		const tag = hold(q("q-1"));
		const over = await call({ action: "hold", id: tag, until: "2h1m", why: "asking Design" });
		expect(over.ok).toBe(false);
		expect(over.text).toContain("more than 2 hours ahead");
		expect((await call({ action: "hold", id: tag, until: "08:00", why: "x" })).text).toContain(
			"more than 2 hours ahead",
		);
		expect((await call({ action: "hold", id: tag, until: "2026-11-01T08:00Z", why: "x" })).text).toContain("passed");
		expect((await call({ action: "hold", id: tag, until: "30m" })).text).toContain("Say why");
		expect((await call({ action: "hold", id: tag, until: "soon", why: "x" })).text).toContain("Say until when");
		expect(holds.get(holdKeyOfAsk("q-1"))?.holdUntil).toBeUndefined();
	});

	it("clock changes: skips nonexistent local times and uses the next repeated time", () => {
		const zone = "America/Los_Angeles";
		const spring = Date.parse("2026-03-08T09:00:00Z");
		expect(parseHoldUntil("02:30", spring, zone)).toBe(Date.parse("2026-03-09T09:30:00Z"));
		expect(parseHoldUntil("03:30", spring, zone)).toBe(Date.parse("2026-03-08T10:30:00Z"));
		expect(parseHoldUntil("01:30", Date.parse("2026-11-01T08:45:00Z"), zone)).toBe(Date.parse("2026-11-01T09:30:00Z"));
		expect(parseHoldUntil("01:30", Date.parse("2026-11-01T07:45:00Z"), zone)).toBe(Date.parse("2026-11-01T08:30:00Z"));
		expect(parseHoldUntil("1".repeat(100_000), T0, zone)).toBeUndefined();
	});

	it("parseHoldUntil: spans and clock times in his zone", () => {
		expect(parseHoldUntil("45m", T0)).toBe(T0 + 45 * MIN);
		expect(parseHoldUntil("in 45 minutes", T0)).toBe(T0 + 45 * MIN);
		expect(parseHoldUntil("1h30m", T0)).toBe(T0 + 90 * MIN);
		expect(parseHoldUntil("1 hour 30 minutes", T0)).toBe(T0 + 90 * MIN);
		expect(parseHoldUntil("2 hours", T0)).toBe(T0 + 120 * MIN);
		expect(parseHoldUntil("10:30", T0, "UTC")).toBe(T0 + 90 * MIN);
		expect(parseHoldUntil("10:30 am", T0, "UTC")).toBe(T0 + 90 * MIN);
		// 09:00 UTC is 01:00 in Los Angeles (PST after 2026-11-01's change); 2:15 am there is 75 minutes on.
		expect(parseHoldUntil("2:15 am", T0, "America/Los_Angeles")).toBe(T0 + 75 * MIN);
		expect(parseHoldUntil("08:00", T0, "UTC")).toBe(T0 + 23 * 60 * MIN);
		for (const bad of ["", "soon", "13:00 pm", "25:00", "0m", "later today"])
			expect(parseHoldUntil(bad, T0)).toBeUndefined();
	});
});

describe("return", () => {
	it("a question goes back to the chat that asked, as its own call", async () => {
		const { call, hold, hub, holds, s } = setup();
		const tag = hold(q("q-1"));
		const r = await call({ action: "return", id: tag, note: "Pick the port the other apps use; it is your call." });
		expect(r).toMatchObject({ ok: true });
		expect(r.text).toContain("went back to the chat that asked");
		expect(hub.heldList()).toHaveLength(0);
		expect(hub.list()).toHaveLength(0);
		expect(s.events).toContainEqual(expect.objectContaining({ type: "returned" }));
		expect(holds.get(holdKeyOfAsk("q-1"))?.state).toBe("returned");
		expect(s.answered).not.toHaveBeenCalled();
	});

	it("refused for a queued task's card, a pop-up and a tool approval; they stay held", async () => {
		const { call, hold, hub } = setup();
		const tags = [
			hold(stuck("st-1"), "queued-work"),
			hold(dialogAsk("d-2", { id: 2, kind: "confirm", title: "Run it?", args: [] }, {}, T0)),
			hold(approvalAsk("ap-3", { toolName: "bash", params: { command: "ls" } }, {}, T0)),
		];
		for (const tag of tags) {
			const r = await call({ action: "return", id: tag, note: "Yours." });
			expect(r.ok).toBe(false);
			expect(r.text).toContain("Only a question asked with ask_user_question can go back");
		}
		expect(hub.heldList().map((a) => a.id)).toEqual(["st-1", "d-2", "ap-3"]);
	});

	it("refused without a note", async () => {
		const { call, hold } = setup();
		const tag = hold(q("q-1"));
		expect((await call({ action: "return", id: tag })).text).toContain("Say what the chat that asked should do");
	});
});

describe("ownerTextProblem", () => {
	it("plain words pass; length and faults are named", () => {
		expect(ownerTextProblem("Design needs a port picked before it can finish.", "note")).toBeNull();
		expect(ownerTextProblem("x".repeat(601), "note")).toBe("The note is 601 characters; at most 600.");
		expect(ownerTextProblem("Commit 5e36933a broke it", "note")).toContain("an id (5e36933a)");
	});
});
