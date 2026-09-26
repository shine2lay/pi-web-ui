/**
 * tldr-panel：会话分支条目 → 右栏 TL;DR 行（server/tldr-lines.ts）。
 * 条目格式是和 pi-tldr 扩展的约定：{ type: "custom", customType: "tldr", data: { v, text, needsYou, ts } }。
 */
import { describe, expect, it } from "vitest";
import {
	isTldrReply,
	latestAwaitingReply,
	latestUnseenTldr,
	TLDR_COLLAPSE_TYPE,
	TLDR_MAX_LINES,
	tldrCollapseData,
	tldrLinesFromEntries,
	type TldrEntryLike,
} from "../../server/tldr-lines.js";

const line = (id: string, text: string, extra: Record<string, unknown> = {}): TldrEntryLike => ({
	type: "custom",
	id,
	customType: "tldr",
	data: { v: 1, text, needsYou: false, ts: 1000 + Number(id.replace(/\D/g, "") || 0), ...extra },
	timestamp: "2026-09-24T12:00:00.000Z",
});

describe("tldrLinesFromEntries", () => {
	it("keeps only tldr custom entries, in branch order", () => {
		const entries: TldrEntryLike[] = [
			{ type: "message", id: "m1" },
			line("t1", "Looking into why the page loads twice"),
			{ type: "custom", id: "c1", customType: "manual-retry", data: { text: "not a tldr" } },
			{ type: "compaction", id: "k1" },
			line("t2", "Found it: two version numbers never match", { needsYou: true }),
		];
		expect(tldrLinesFromEntries(entries)).toEqual([
			{ id: "t1", text: "Looking into why the page loads twice", needsYou: false, ts: 1001 },
			{ id: "t2", text: "Found it: two version numbers never match", needsYou: true, ts: 1002 },
		]);
	});

	it("skips bad data instead of throwing", () => {
		const entries: TldrEntryLike[] = [
			{ type: "custom", id: "a", customType: "tldr" },
			{ type: "custom", id: "b", customType: "tldr", data: { text: "   " } },
			{ type: "custom", id: "c", customType: "tldr", data: { text: 42 } },
			{ type: "custom", customType: "tldr", data: { text: "no id" } },
			{ type: "custom", id: "d", customType: "tldr", data: "just a string" },
			line("t9", "  ok  ", { needsYou: "yes" }),
		];
		expect(tldrLinesFromEntries(entries)).toEqual([{ id: "t9", text: "ok", needsYou: false, ts: 1009 }]);
	});

	it("falls back to the entry timestamp when data.ts is missing", () => {
		const [l] = tldrLinesFromEntries([
			{ type: "custom", id: "x", customType: "tldr", data: { text: "hi" }, timestamp: "2026-09-24T12:00:00.000Z" },
		]);
		expect(l.ts).toBe(Date.parse("2026-09-24T12:00:00.000Z"));
	});

	it("keeps the newest lines when over the cap, and trims runaway text", () => {
		const many = Array.from({ length: TLDR_MAX_LINES + 3 }, (_, i) => line(`t${i}`, `line ${i}`));
		const out = tldrLinesFromEntries(many);
		expect(out).toHaveLength(TLDR_MAX_LINES);
		expect(out[0].text).toBe("line 3");
		expect(out.at(-1)?.text).toBe(`line ${TLDR_MAX_LINES + 2}`);

		const [long] = tldrLinesFromEntries([line("t1", "x".repeat(1000))]);
		expect(long.text.length).toBe(401);
		expect(long.text.endsWith("…")).toBe(true);
	});
});

/** tldr-collapse：pi-web-ui 自己写的折叠条目。 */
const fold = (id: string, ids: unknown, collapsed: unknown): TldrEntryLike => ({
	type: "custom",
	id,
	customType: TLDR_COLLAPSE_TYPE,
	data: { v: 1, ids, collapsed },
});

describe("tldr-collapse", () => {
	it("marks the lines folded by collapse entries, replayed in branch order", () => {
		const out = tldrLinesFromEntries([
			line("t1", "one"),
			line("t2", "two"),
			fold("f1", ["t1", "t2"], true),
			line("t3", "three"),
			fold("f2", ["t2"], false),
		]);
		expect(out.map((l) => [l.id, l.collapsed])).toEqual([
			["t1", true],
			["t2", undefined],
			["t3", undefined],
		]);
		// 没折叠的行不带这个字段
		expect("collapsed" in out[1]).toBe(false);
	});

	it("ignores unknown ids and bad collapse data", () => {
		const out = tldrLinesFromEntries([
			line("t1", "one"),
			fold("f1", ["nope"], true),
			fold("f2", "t1", true),
			fold("f3", ["t1"], "yes"),
			{ type: "custom", id: "f4", customType: TLDR_COLLAPSE_TYPE },
		]);
		expect(out).toEqual([{ id: "t1", text: "one", needsYou: false, ts: 1001 }]);
	});

	it("a line folded on an abandoned branch is open on the current one", () => {
		// 分支上只有当前路径的条目：别的分支上的折叠条目根本不在 entries 里。
		expect(tldrLinesFromEntries([line("t1", "one")])[0].collapsed).toBeUndefined();
	});

	it("tldrCollapseData cleans what the client sent", () => {
		expect(tldrCollapseData(["a", "a", 3, "", "x".repeat(65), "b"], true)).toEqual({
			v: 1,
			ids: ["a", "b"],
			collapsed: true,
		});
		expect(tldrCollapseData([], true)).toBeNull();
		expect(tldrCollapseData(["a"], 1)).toBeNull();
		expect(tldrCollapseData("a", false)).toBeNull();
		const many = Array.from({ length: TLDR_MAX_LINES + 5 }, (_, i) => `i${i}`);
		expect(tldrCollapseData(many, false)?.ids).toHaveLength(TLDR_MAX_LINES);
	});
});

describe("tldr-sidebar: latestUnseenTldr", () => {
	const collapse = (id: string, ids: string[], collapsed: boolean): TldrEntryLike => ({
		type: "custom",
		id,
		customType: TLDR_COLLAPSE_TYPE,
		data: { v: 1, ids, collapsed },
	});
	const pick = (entries: TldrEntryLike[]) => latestUnseenTldr(tldrLinesFromEntries(entries));

	it("only the newest line counts", () => {
		expect(pick([line("t1", "Need your OK", { needsYou: true }), line("t2", "Fixed it, running the tests")])).toEqual({
			text: "Fixed it, running the tests",
			needsYou: false,
		});
	});

	it("a folded newest line gives none, even when older lines are still open", () => {
		expect(pick([line("t1", "one"), line("t2", "two"), collapse("f1", ["t2"], true)])).toBeUndefined();
	});

	it("folding an older line does not matter", () => {
		expect(pick([line("t1", "one"), line("t2", "two"), collapse("f1", ["t1"], true)])?.text).toBe("two");
	});

	it("opening the newest line again brings it back", () => {
		expect(pick([line("t1", "one"), collapse("f1", ["t1"], true), collapse("f2", ["t1"], false)])?.text).toBe("one");
	});

	it("a new line after a folded one shows", () => {
		expect(pick([line("t1", "one"), collapse("f1", ["t1"], true), line("t2", "two")])?.text).toBe("two");
	});

	it("needs-you carries through", () => {
		expect(pick([line("t1", "one"), line("t2", "Need your OK to delete the branch", { needsYou: true })])).toEqual({
			text: "Need your OK to delete the branch",
			needsYou: true,
		});
	});

	it("no lines gives none", () => {
		expect(latestUnseenTldr([])).toBeUndefined();
		expect(
			pick([
				{ type: "message", id: "m1" },
				{ type: "compaction", id: "k1" },
			]),
		).toBeUndefined();
	});
});

/** tldr-answered：needs-you 行之后用户回过话，就不再高亮。 */
describe("tldr-answered", () => {
	const msg = (id: string, message: unknown): TldrEntryLike => ({ type: "message", id, message });
	const user = (id: string, text: string) => msg(id, { role: "user", content: [{ type: "text", text }] });
	const ask = (id: string, isError = false, toolName = "ask_user_question") =>
		msg(id, { role: "toolResult", toolName, isError, content: [{ type: "text", text: "answer" }] });
	const assistant = (id: string) => msg(id, { role: "assistant", content: [{ type: "text", text: "ok" }] });
	const need = (id: string) => line(id, "Need your OK to delete the branch", { needsYou: true });

	it("isTldrReply: the user's own messages and answered dialogs count; automated ones don't", () => {
		expect(isTldrReply({ role: "user", content: [{ type: "text", text: "yes, go ahead" }] })).toBe(true);
		expect(isTldrReply({ role: "user", content: "ok" })).toBe(true);
		expect(isTldrReply({ role: "user", content: [{ type: "image", data: "…", mimeType: "image/png" }] })).toBe(true);
		// 定时任务唤醒、无头执行、pi-queue 交任务 / 催办、pi-web-ui 的系统提醒
		for (const text of [
			"[定时任务 check bets] look at the runs",
			"[定时任务] look at the runs",
			"[Queue] Task #3: tidy up",
			"[Queue] Continue task #3: tidy up",
			"（系统：你之前在终端 t1 后台运行的命令已结束）",
			"（系统自动提醒：你启动的终端已连续 15 秒没有任何新输出。）",
		]) {
			expect(isTldrReply({ role: "user", content: [{ type: "text", text }] }), text).toBe(false);
		}
		expect(isTldrReply({ role: "toolResult", toolName: "ask_user_question", isError: false })).toBe(true);
		expect(isTldrReply({ role: "toolResult", toolName: "queue_add", isError: false })).toBe(true);
		expect(isTldrReply({ role: "toolResult", toolName: "ask_user_question", isError: true }), "cancelled").toBe(false);
		expect(isTldrReply({ role: "toolResult", toolName: "bash", isError: false })).toBe(false);
		expect(isTldrReply({ role: "assistant", content: [] })).toBe(false);
		expect(isTldrReply({ role: "custom", customType: "parallel-work-reminder" })).toBe(false);
		expect(isTldrReply(undefined)).toBe(false);
	});

	it("a reply after a needs-you line marks it answered; the sidebar and the awaiting check drop it", () => {
		const before = [line("t1", "Looking into it"), need("t2"), assistant("a1")];
		const open = tldrLinesFromEntries(before);
		expect(open[1]).toEqual({ id: "t2", text: "Need your OK to delete the branch", needsYou: true, ts: 1002 });
		expect(latestAwaitingReply(open)).toBe(true);

		const after = tldrLinesFromEntries([...before, user("u1", "yes, delete it")]);
		expect(after[1]).toEqual({
			id: "t2",
			text: "Need your OK to delete the branch",
			needsYou: true,
			ts: 1002,
			answered: true,
		});
		expect(after[0]).not.toHaveProperty("answered");
		expect(latestUnseenTldr(after)).toEqual({ text: "Need your OK to delete the branch", needsYou: false });
		expect(latestAwaitingReply(after)).toBe(false);
	});

	it("answering a question dialog counts; a cancelled one does not", () => {
		expect(tldrLinesFromEntries([need("t1"), ask("r1")])[0].answered).toBe(true);
		expect(tldrLinesFromEntries([need("t1"), ask("r1", false, "queue_add")])[0].answered).toBe(true);
		expect(tldrLinesFromEntries([need("t1"), ask("r1", true)])[0].answered).toBeUndefined();
	});

	it("automated prompts and messages before the line don't answer it", () => {
		const lines = tldrLinesFromEntries([
			user("u0", "please do it"),
			need("t1"),
			user("u1", "[定时任务 hourly] check the runs"),
			user("u2", "[Queue] Task #2: next thing"),
			{ type: "custom_message", id: "cm1", customType: "parallel-work-reminder" },
		]);
		expect(lines[0].answered).toBeUndefined();
		expect(latestAwaitingReply(lines)).toBe(true);
	});

	it("a reply answers every needs-you line before it, not the ones after", () => {
		const lines = tldrLinesFromEntries([need("t1"), need("t2"), user("u1", "yes to both"), need("t3")]);
		expect(lines.map((l) => l.answered === true)).toEqual([true, true, false]);
		expect(latestAwaitingReply(lines)).toBe(true);
	});

	it("a folded newest line is not awaiting, answered or not", () => {
		const lines = tldrLinesFromEntries([
			need("t1"),
			{ type: "custom", id: "f1", customType: TLDR_COLLAPSE_TYPE, data: { v: 1, ids: ["t1"], collapsed: true } },
		]);
		expect(latestAwaitingReply(lines)).toBe(false);
	});
});
