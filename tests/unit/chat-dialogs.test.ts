/**
 * per-chat-dialogs：server/chat-dialogs.ts。一条对话的扩展弹窗存在它自己那里，最早的在前；
 * 按 id 回答；超时 / abort / 换会话 / 关对话时以「取消」结束；ctx.ui 的 select / confirm / input
 * 走它，其余照旧给窗口的 WebUIContext。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDialogs, chatUiContext } from "../../server/chat-dialogs.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("ChatDialogs", () => {
	it("keeps waiting pop-ups oldest first and shows the oldest", async () => {
		let changes = 0;
		const d = new ChatDialogs(() => changes++);
		expect(d.current).toBeNull();
		const a = d.open("confirm", "A", ["first"], "s1");
		const b = d.open("input", "B", [""], "s1");
		expect(d.size).toBe(2);
		expect(changes).toBe(2);
		const first = d.current;
		expect(first?.title).toBe("A");
		// the same object until it goes away (snapshot deltas compare by reference)
		expect(d.current).toBe(first);
		expect(d.answer(first!.id, true)).toBe(true);
		await expect(a).resolves.toBe(true);
		expect(d.current?.title).toBe("B");
		expect(d.answer(d.current!.id, "typed")).toBe(true);
		await expect(b).resolves.toBe("typed");
		expect(d.current).toBeNull();
		expect(changes).toBe(4);
	});

	it("answers by id: a later pop-up can be answered first, and an unknown id changes nothing", async () => {
		const d = new ChatDialogs();
		const a = d.open("confirm", "A", [""], "s1");
		const idA = d.current!.id;
		const b = d.open("confirm", "B", [""], "s1");
		const idB = idA + 1; // one process-wide counter, nothing else asked in between
		expect(d.answer(idB, false)).toBe(true);
		await expect(b).resolves.toBe(false);
		expect(d.current?.id).toBe(idA);
		expect(d.answer(99999, true)).toBe(false);
		expect(d.answer(idB, true)).toBe(false);
		expect(d.size).toBe(1);
		d.answer(idA, true);
		await expect(a).resolves.toBe(true);
	});

	it("gives every pop-up its own id, across chats", () => {
		const one = new ChatDialogs();
		const two = new ChatDialogs();
		void one.open("confirm", "A", [""], "s1");
		void two.open("confirm", "B", [""], "s2");
		expect(one.current!.id).not.toBe(two.current!.id);
		// an id from the other chat isn't this chat's to answer
		expect(one.answer(two.current!.id, true)).toBe(false);
		expect(two.size).toBe(1);
	});

	it("cancels on timeout", async () => {
		vi.useFakeTimers();
		const d = new ChatDialogs();
		const p = d.open("confirm", "A", [""], "s1", { timeout: 5000 });
		vi.advanceTimersByTime(4999);
		expect(d.size).toBe(1);
		vi.advanceTimersByTime(1);
		await expect(p).resolves.toBeNull();
		expect(d.size).toBe(0);
	});

	it("cancels on abort, and doesn't open at all when already aborted", async () => {
		const d = new ChatDialogs();
		const ac = new AbortController();
		const p = d.open("select", "A", [["x", "y"]], "s1", { signal: ac.signal });
		expect(d.size).toBe(1);
		ac.abort();
		await expect(p).resolves.toBeNull();
		expect(d.size).toBe(0);
		await expect(d.open("select", "B", [["x"]], "s1", { signal: ac.signal })).resolves.toBeNull();
		expect(d.size).toBe(0);
	});

	it("cancels what an older session asked, and everything when the chat closes", async () => {
		let changes = 0;
		const d = new ChatDialogs(() => changes++);
		const old = d.open("confirm", "old", [""], "s1");
		const cur = d.open("confirm", "current", [""], "s2");
		changes = 0;
		d.cancelExcept("s2");
		await expect(old).resolves.toBeNull();
		expect(d.current?.title).toBe("current");
		expect(changes).toBe(1);
		d.cancelExcept("s2"); // nothing left to cancel: no change pushed
		expect(changes).toBe(1);
		d.cancelAll();
		await expect(cur).resolves.toBeNull();
		expect(d.size).toBe(0);
		expect(changes).toBe(2);
	});

	it("a failing change hook doesn't break the extension's dialog", async () => {
		const d = new ChatDialogs(() => {
			throw new Error("push failed");
		});
		const p = d.open("confirm", "A", [""], "s1");
		expect(d.answer(d.current!.id, true)).toBe(true);
		await expect(p).resolves.toBe(true);
	});
});

describe("chatUiContext", () => {
	const makeBase = () => {
		const calls: string[] = [];
		const base = {
			label: "window",
			// pi's parameter lists: chatUiContext returns the base's type, so the calls below typecheck.
			select: async (_title: string, _options: string[], _opts?: unknown): Promise<string | undefined> => "from-window",
			confirm: async (_title: string, _message: string, _opts?: unknown): Promise<boolean> => true,
			input: async (_title: string, _placeholder?: string, _opts?: unknown): Promise<string | undefined> =>
				"from-window",
			notify(this: { label: string }, text: string) {
				calls.push(`${this.label}:${text}`);
			},
		};
		return { base, calls };
	};

	it("sends select / confirm / input to the chat and the rest to the window", async () => {
		const { base, calls } = makeBase();
		const d = new ChatDialogs();
		const ui = chatUiContext(base, d, "s1");
		ui.notify("hi");
		expect(calls).toEqual(["window:hi"]); // bound to the window's context
		const p = ui.confirm("Approve?", "the plan");
		expect(d.current).toMatchObject({ kind: "confirm", title: "Approve?", args: ["the plan"] });
		d.answer(d.current!.id, true);
		await expect(p).resolves.toBe(true);
	});

	it("returns what pi declares: select gives one of the options, confirm is yes only for true", async () => {
		const { base } = makeBase();
		const d = new ChatDialogs();
		const ui = chatUiContext(base, d, "s1");

		const s1 = ui.select("Pick", ["a", "b"]);
		d.answer(d.current!.id, "b");
		await expect(s1).resolves.toBe("b");
		const s2 = ui.select("Pick", ["a", "b"]);
		d.answer(d.current!.id, "not-an-option");
		await expect(s2).resolves.toBeUndefined();
		const s3 = ui.select("Pick", ["a"]);
		d.answer(d.current!.id, null);
		await expect(s3).resolves.toBeUndefined();

		const c1 = ui.confirm("Sure?", "");
		d.answer(d.current!.id, "true");
		await expect(c1).resolves.toBe(false);
		const c2 = ui.confirm("Sure?", "");
		d.answer(d.current!.id, null);
		await expect(c2).resolves.toBe(false);

		const i1 = ui.input("Name", "placeholder");
		expect(d.current?.args).toEqual(["placeholder"]);
		d.answer(d.current!.id, "Ada");
		await expect(i1).resolves.toBe("Ada");
		const i2 = ui.input("Name");
		expect(d.current?.args).toEqual([""]);
		d.answer(d.current!.id, null);
		await expect(i2).resolves.toBeUndefined();
	});

	it("passes pi's timeout / signal through", async () => {
		const { base } = makeBase();
		const d = new ChatDialogs();
		const ui = chatUiContext(base, d, "s1");
		const ac = new AbortController();
		const p = ui.select("Pick", ["a"], { signal: ac.signal });
		ac.abort();
		await expect(p).resolves.toBeUndefined();
		expect(d.size).toBe(0);
	});
});
