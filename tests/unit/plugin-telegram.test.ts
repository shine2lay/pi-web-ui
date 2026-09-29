/**
 * telegram-answers: the Telegram plugin against a fake Telegram (no network) and a fake list of
 * waiting asks. Checks what is sent, that taps and replies answer the chat, that answers made
 * elsewhere update the message, and that nobody but the owner counts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import telegramPlugin, {
	TEXT_BUDGET,
	chatLink,
	createBridge,
	createPoller,
	createTelegramApi,
	visibleLength,
} from "../../plugins/telegram/index.mjs";

const OWNER = "8778288252";
const STRANGER = "5550001111";
const TOKEN = "123456:SECRET-token-value";
const ADDRESS = "https://pi.example.ts.net:8787/";
const SESSION = "/home/x/.pi/agent/sessions/abc.jsonl";

// biome-ignore lint/suspicious/noExplicitAny: test doubles
type Any = any;
type Call = { method: string; params: Any; result?: Any };

const okResponse = (result: unknown) =>
	new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { "content-type": "application/json" } });
const errResponse = (code: number, description: string, extra: Record<string, unknown> = {}) =>
	new Response(JSON.stringify({ ok: false, error_code: code, description, ...extra }), { status: code });

/** How a call can go wrong: Telegram's error answer, a failed connection, or "lost" (Telegram did
 *  it, but its answer never arrived). */
type Failure = Response | Error | "lost";

/** A fake Telegram: records every Bot API call and answers it. */
function fakeTelegram() {
	const calls: Call[] = [];
	let nextId = 500;
	const failures: Record<string, Failure[]> = {};
	const fetchImpl = async (url: string, init: Any) => {
		const method = String(url).split("/").pop() as string;
		const params = JSON.parse(init?.body ?? "{}");
		const call: Call = { method, params };
		calls.push(call);
		const fail = failures[method]?.shift();
		if (fail instanceof Response) return fail;
		if (fail instanceof Error) throw fail;
		if (method === "sendMessage") {
			call.result = { message_id: nextId++, chat: { id: Number(OWNER), type: "private" } };
		}
		if (fail === "lost") throw new Error("socket hang up");
		return okResponse(call.result ?? true);
	};
	return {
		calls,
		fetchImpl,
		api: createTelegramApi({ base: "http://fake-telegram", token: TOKEN, fetchImpl: fetchImpl as Any }),
		of: (method: string) => calls.filter((c) => c.method === method),
		last: (method: string) => calls.filter((c) => c.method === method).at(-1),
		failNext: (method: string, res: Failure, times = 1) => {
			// A Response's body can be read once: each failure gets its own copy.
			for (let i = 0; i < times; i++) (failures[method] ??= []).push(res instanceof Response ? res.clone() : res);
		},
	};
}

/** A fake list of waiting asks, shaped like host.asks. */
function fakeAsks() {
	const live: Any[] = [];
	const handlers = new Set<(ev: Any) => void>();
	const answered: Any[] = [];
	let refuse: string | null = null;
	const emit = (ev: Any) => {
		for (const h of [...handlers]) h(ev);
	};
	const take = (id: string) => {
		const i = live.findIndex((a) => a.id === id);
		return i < 0 ? null : live.splice(i, 1)[0];
	};
	return {
		list: () => live.slice(),
		on: (h: (ev: Any) => void) => {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		answer: async (id: string, answers: Any[]) => {
			if (refuse) return { ok: false, error: refuse };
			const ask = take(id);
			if (!ask) return { ok: false, error: "no longer waiting" };
			answered.push({ id, answers });
			const summary = answers.map((a) => [...a.selected, ...(a.text ? [a.text] : [])].join(" + ")).join("; ");
			emit({ type: "answered", ask, summary, from: "telegram" });
			return { ok: true };
		},
		add(ask: Any) {
			live.push(ask);
			emit({ type: "appeared", ask });
			return ask;
		},
		answerInBrowser(id: string, summary: string) {
			const ask = take(id);
			if (ask) emit({ type: "answered", ask, summary, from: "browser" });
		},
		goAway(id: string, reason: string) {
			const ask = take(id);
			if (ask) emit({ type: "gone", ask, reason });
		},
		refuseWith(error: string | null) {
			refuse = error;
		},
		answered,
	};
}

function memStorage(init: Record<string, unknown> = {}) {
	const m: Record<string, unknown> = JSON.parse(JSON.stringify(init));
	return {
		get: (k: string, fb?: unknown) => (k in m ? m[k] : fb),
		set: (k: string, v: unknown) => {
			m[k] = JSON.parse(JSON.stringify(v));
		},
		delete: (k: string) => {
			delete m[k];
		},
		all: () => m,
	};
}

let seq = 0;
function question(over: Record<string, unknown> = {}) {
	seq++;
	return {
		id: `q-${seq}`,
		kind: "question",
		createdAt: 1000 + seq,
		conversationId: "c1",
		conversationTitle: "Throwaway",
		cwd: `${process.env.HOME}/projects/demo`,
		sessionFile: SESSION,
		title: "Pick a colour",
		fields: [
			{
				id: "colour",
				text: "Which colour?",
				options: [
					{ value: "Red", label: "Red", description: "warm" },
					{ value: "Blue", label: "Blue" },
				],
				multi: false,
				allowText: true,
			},
		],
		...over,
	};
}

let updateId = 0;
const tap = (data: string, messageId: number, from = OWNER) => ({
	update_id: ++updateId,
	callback_query: {
		id: `cb${updateId}`,
		from: { id: Number(from) },
		data,
		message: { message_id: messageId, chat: { id: Number(from), type: "private" } },
	},
});
const say = (text: string, replyTo?: number, from = OWNER, chat: Any = null) => ({
	update_id: ++updateId,
	message: {
		message_id: 900 + updateId,
		from: { id: Number(from) },
		chat: chat ?? { id: Number(from), type: "private" },
		text,
		...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
	},
});

function setup(storageInit: Record<string, unknown> = {}) {
	const tg = fakeTelegram();
	const asks = fakeAsks();
	const storage = memStorage(storageInit);
	const bridge = createBridge({
		api: tg.api,
		asks,
		storage,
		ownerId: OWNER,
		webAppAddress: ADDRESS,
		sleep: async () => {},
	});
	asks.on((ev) => bridge.onAskEvent(ev));
	/** Wait until everything queued (including what that queued) has run. */
	const settle = async () => {
		for (;;) {
			const tail = bridge.idle();
			await tail;
			if (tail === bridge.idle()) return;
		}
	};
	const send = async (update: Any) => {
		await bridge.handleUpdate(update);
		await settle();
	};
	return { tg, asks, storage, bridge, settle, send };
}

const buttons = (call: Call | undefined) =>
	(call?.params?.reply_markup?.inline_keyboard ?? []).map((row: Any[]) => row[0]);
const dataOf = (call: Call | undefined, label: string) =>
	buttons(call).find((b: Any) => b.text.includes(label))?.callback_data as string;

describe("telegram plugin: sending", () => {
	it("sends a waiting question to the owner, with its choices as buttons and a link to the chat", async () => {
		const { tg, asks, settle } = setup();
		asks.add(question());
		await settle();
		const sent = tg.of("sendMessage");
		expect(sent).toHaveLength(1);
		const p = sent[0].params;
		expect(p.chat_id).toBe(OWNER);
		expect(p.parse_mode).toBe("HTML");
		expect(p.text).toContain("<b>Pick a colour</b>");
		expect(p.text).toContain("Chat: Throwaway");
		expect(p.text).toContain("Folder: <code>~/projects/demo</code>");
		expect(p.text).toContain("Which colour?");
		expect(p.text).toContain("<b>Red</b>: warm");
		expect(p.text).toContain(`<a href="${chatLink(ADDRESS, SESSION)}">Open the chat</a>`);
		expect(buttons(sent[0]).map((b: Any) => b.text)).toEqual(["Red", "Blue", "\u270F\uFE0F Type an answer"]);
	});

	it("cuts a long permission prompt to fit Telegram, pointing to the chat for the rest", async () => {
		const { tg, asks, settle } = setup();
		asks.add(
			question({
				kind: "approval",
				title: "Run this command?",
				body: `echo ${"x".repeat(12000)}`,
				fields: [
					{
						id: "decision",
						text: "Allow it?",
						options: [
							{ value: "allow", label: "Allow" },
							{ value: "deny", label: "Deny" },
						],
						multi: false,
						allowText: false,
					},
				],
			}),
		);
		await settle();
		const p = tg.last("sendMessage")?.params;
		expect(visibleLength(p.text)).toBeLessThanOrEqual(TEXT_BUDGET);
		expect(p.text).toContain("<pre>echo xxx");
		expect(p.text).toContain("cut: open the chat for the rest");
		expect(buttons(tg.last("sendMessage")).map((b: Any) => b.text)).toEqual(["Allow", "Deny"]);
	});

	it("after a restart, old messages say they're no longer waiting and waiting asks get sent", async () => {
		const ask = question();
		const { tg, asks, bridge, settle } = setup({
			sent: {
				"old-1@5": {
					key: "old-1@5",
					ref: 7,
					askId: "old-1",
					createdAt: 5,
					messageId: 42,
					step: 0,
					answers: {},
					ticks: [],
					prompts: {},
					head: "<b>Old</b>",
				},
			},
			nextRef: 8,
		});
		// It was waiting before the plugin started: no "appeared" event reaches the bridge.
		asks.list = () => [ask];
		void bridge.resync("pi restarted");
		await settle();
		const edit = tg.of("editMessageText").find((c) => c.params.message_id === 42);
		expect(edit?.params.text).toContain("No longer waiting</b>: pi restarted");
		expect(edit?.params.reply_markup).toEqual({ inline_keyboard: [] });
		expect(tg.of("sendMessage")).toHaveLength(1);
		expect(buttons(tg.last("sendMessage"))[0].callback_data).toBe("8:0:o0");
		expect([...bridge.entries.keys()]).toEqual([`${ask.id}@${ask.createdAt}`]);
	});

	it("retries a send Telegram asked to slow down", async () => {
		const { tg, asks, bridge, settle } = setup();
		tg.failNext(
			"sendMessage",
			errResponse(429, "Too Many Requests: retry after 1", { parameters: { retry_after: 1 } }),
		);
		asks.add(question());
		await settle();
		expect(tg.of("sendMessage")).toHaveLength(2);
		expect(bridge.entries.size).toBe(1);
	});

	it("retries at once when Telegram has a hiccup or the connection fails", async () => {
		const { tg, asks, bridge, settle } = setup();
		tg.failNext("sendMessage", errResponse(502, "Bad Gateway"));
		tg.failNext("sendMessage", new Error("fetch failed"));
		const ask = asks.add(question());
		await settle();
		const sent = tg.of("sendMessage");
		expect(sent).toHaveLength(3);
		expect(bridge.entries.get(`${ask.id}@${ask.createdAt}`)?.messageId).toBe(sent[2].result.message_id);
	});

	it("doesn't retry what Telegram refused", async () => {
		const { tg, asks, settle } = setup();
		tg.failNext("sendMessage", errResponse(403, "Forbidden: bot was blocked by the user"));
		asks.add(question());
		await settle();
		expect(tg.of("sendMessage")).toHaveLength(1);
	});

	it("a send that keeps failing keeps its buttons: the next try sends the same ones", async () => {
		const { tg, asks, bridge, settle } = setup();
		tg.failNext("sendMessage", errResponse(502, "Bad Gateway"), 4);
		const ask = asks.add(question());
		await settle();
		const failed = tg.of("sendMessage");
		expect(failed).toHaveLength(4);
		const key = `${ask.id}@${ask.createdAt}`;
		expect(bridge.entries.get(key)?.messageId).toBe(0);
		void bridge.resync();
		await settle();
		const sent = tg.last("sendMessage") as Call;
		expect(tg.of("sendMessage")).toHaveLength(5);
		expect(dataOf(sent, "Blue")).toBe(dataOf(failed[0], "Blue"));
		expect(bridge.entries.get(key)?.messageId).toBe(sent.result.message_id);
	});

	it("button ids start from the clock, so a fresh start never reuses an old message's", async () => {
		const before = Math.floor(Date.now() / 1000);
		const { tg, asks, settle } = setup();
		asks.add(question());
		await settle();
		const ref = Number(dataOf(tg.last("sendMessage"), "Red").split(":")[0]);
		expect(ref).toBeGreaterThanOrEqual(before);
		expect(ref).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
	});
});

describe("telegram plugin: copies from a send whose answer was lost", () => {
	it("a tap on either copy answers the chat, and both get the final words", async () => {
		const { tg, asks, bridge, send, settle } = setup();
		tg.failNext("sendMessage", "lost");
		const ask = asks.add(question());
		await settle();
		const [lost, kept] = tg.of("sendMessage");
		expect(tg.of("sendMessage")).toHaveLength(2);
		expect(dataOf(lost, "Blue")).toBe(dataOf(kept, "Blue"));
		await send(tap(dataOf(lost, "Blue"), lost.result.message_id));
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: ["Blue"] }] }]);
		const finals = tg
			.of("editMessageText")
			.filter((c) => String(c.params.text).includes("Answered on Telegram</b>: Blue"))
			.map((c) => c.params.message_id);
		expect(finals.sort()).toEqual([lost.result.message_id, kept.result.message_id].sort());
		expect(bridge.entries.size).toBe(0);
	});

	it("ticks show on both copies", async () => {
		const { tg, asks, send, settle } = setup();
		tg.failNext("sendMessage", "lost");
		asks.add(
			question({
				fields: [
					{
						id: "langs",
						text: "Which languages?",
						options: ["Go", "Rust"].map((v) => ({ value: v, label: v })),
						multi: true,
						allowText: false,
					},
				],
			}),
		);
		await settle();
		const [lost, kept] = tg.of("sendMessage");
		await send(tap(dataOf(kept, "Go"), kept.result.message_id));
		await send(tap(dataOf(lost, "Rust"), lost.result.message_id));
		const last = tg.of("editMessageReplyMarkup").slice(-2);
		expect(last.map((c) => c.params.message_id).sort()).toEqual(
			[lost.result.message_id, kept.result.message_id].sort(),
		);
		for (const c of last) {
			expect(buttons(c).map((b: Any) => b.text)).toEqual(["\u2611 Go", "\u2611 Rust", "\u2705 Done"]);
		}
	});

	it("a typed reply to a copy we never met answers the question its buttons belong to", async () => {
		const { tg, asks, send, settle } = setup();
		tg.failNext("sendMessage", "lost");
		const ask = asks.add(question());
		await settle();
		const [lost] = tg.of("sendMessage");
		await send({
			update_id: ++updateId,
			message: {
				message_id: 990,
				from: { id: Number(OWNER) },
				chat: { id: Number(OWNER), type: "private" },
				text: "Green",
				reply_to_message: {
					message_id: lost.result.message_id,
					from: { id: 123456, is_bot: true },
					text: "Pick a colour",
					reply_markup: lost.params.reply_markup,
				},
			},
		});
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: [], text: "Green" }] }]);
	});

	it("a reply to a copy of the 'type your answer' prompt counts when just one question waits for it", async () => {
		const { tg, asks, send, settle } = setup();
		const ask = asks.add(question());
		await settle();
		const msg = tg.last("sendMessage") as Call;
		tg.failNext("sendMessage", "lost");
		await send(tap(dataOf(msg, "Type"), msg.result.message_id));
		const [lostPrompt] = tg.of("sendMessage").slice(1);
		expect(tg.of("sendMessage")).toHaveLength(3);
		await send({
			update_id: ++updateId,
			message: {
				message_id: 991,
				from: { id: Number(OWNER) },
				chat: { id: Number(OWNER), type: "private" },
				text: "Teal",
				reply_to_message: {
					message_id: lostPrompt.result.message_id,
					from: { id: 123456, is_bot: true },
					text: "Type your answer to: Which colour?",
				},
			},
		});
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: [], text: "Teal" }] }]);
		const deleted = tg.of("deleteMessage").map((c) => c.params.message_id);
		expect(deleted).toContain(lostPrompt.result.message_id);
	});
});

describe("telegram plugin: answering from Telegram", () => {
	it("a tap answers the chat, and the message says it was answered on Telegram", async () => {
		const { tg, asks, send, settle } = setup();
		const ask = asks.add(question());
		await settle();
		const msg = tg.last("sendMessage") as Call;
		await send(tap(dataOf(msg, "Blue"), msg.result.message_id));
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: ["Blue"] }] }]);
		expect(tg.last("answerCallbackQuery")?.params.text).toBe("Chosen: Blue");
		const final = tg.last("editMessageText")?.params;
		expect(final.message_id).toBe(msg.result.message_id);
		expect(final.text).toContain("Answered on Telegram</b>: Blue");
		expect(final.reply_markup).toEqual({ inline_keyboard: [] });
	});

	it("several choices: tap to tick, then Done", async () => {
		const { tg, asks, send, settle } = setup();
		const ask = asks.add(
			question({
				fields: [
					{
						id: "langs",
						text: "Which languages?",
						options: ["Go", "Rust", "Zig"].map((v) => ({ value: v, label: v })),
						multi: true,
						allowText: false,
					},
				],
			}),
		);
		await settle();
		const msg = tg.last("sendMessage") as Call;
		const id = msg.result.message_id;
		expect(buttons(msg).map((b: Any) => b.text)).toEqual(["\u2610 Go", "\u2610 Rust", "\u2610 Zig", "\u2705 Done"]);
		await send(tap(dataOf(msg, "Done"), id));
		expect(tg.last("answerCallbackQuery")?.params.text).toBe("Tick at least one choice first.");
		await send(tap(dataOf(msg, "Go"), id));
		await send(tap(dataOf(msg, "Zig"), id));
		expect(buttons(tg.last("editMessageReplyMarkup")).map((b: Any) => b.text)).toEqual([
			"\u2611 Go",
			"\u2610 Rust",
			"\u2611 Zig",
			"\u2705 Done",
		]);
		expect(asks.answered).toEqual([]);
		await send(tap(dataOf(msg, "Done"), id));
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "langs", selected: ["Go", "Zig"] }] }]);
	});

	it("a question in parts shows the next part (and its choices) after each answer", async () => {
		const { tg, asks, send, settle } = setup();
		const ask = asks.add(
			question({
				fields: [
					{
						id: "kind",
						text: "Fruit or veg?",
						options: [
							{ value: "Fruit", label: "Fruit" },
							{ value: "Veg", label: "Veg" },
						],
						multi: false,
						allowText: false,
					},
					{
						id: "item",
						text: "Which one?",
						options: [],
						optionsMap: {
							Fruit: [
								{ value: "Apple", label: "Apple" },
								{ value: "Pear", label: "Pear" },
							],
							Veg: [{ value: "Leek", label: "Leek" }],
						},
						dependsOn: { questionId: "kind" },
						multi: false,
						allowText: false,
					},
					{
						id: "why",
						text: "Why veg?",
						options: [{ value: "Health", label: "Health" }],
						dependsOn: { questionId: "kind", value: "Veg" },
						multi: false,
						allowText: false,
					},
				],
			}),
		);
		await settle();
		const msg = tg.last("sendMessage") as Call;
		await send(tap(dataOf(msg, "Fruit"), msg.result.message_id));
		const part2 = tg.last("editMessageText") as Call;
		expect(part2.params.text).toContain("Which one?");
		expect(part2.params.text).toContain("Fruit or veg?: Fruit");
		expect(buttons(part2).map((b: Any) => b.text)).toEqual(["Apple", "Pear"]);
		await send(tap(dataOf(part2, "Pear"), msg.result.message_id));
		expect(asks.answered).toEqual([
			{
				id: ask.id,
				answers: [
					{ id: "kind", selected: ["Fruit"] },
					{ id: "item", selected: ["Pear"] },
				],
			},
		]);
	});

	it("'Type an answer' asks for a reply, and the reply answers the chat", async () => {
		const { tg, asks, send, settle } = setup();
		const ask = asks.add(question());
		await settle();
		const msg = tg.last("sendMessage") as Call;
		await send(tap(dataOf(msg, "Type an answer"), msg.result.message_id));
		const prompt = tg.last("sendMessage") as Call;
		expect(prompt.params.text).toContain("Type your answer to: Which colour?");
		expect(prompt.params.reply_markup.force_reply).toBe(true);
		expect(prompt.params.reply_parameters.message_id).toBe(msg.result.message_id);
		await send(say("Green", prompt.result.message_id));
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: [], text: "Green" }] }]);
		expect(tg.of("deleteMessage").map((c) => c.params.message_id)).toContain(prompt.result.message_id);
		expect(tg.last("editMessageText")?.params.text).toContain("Answered on Telegram</b>: Green");
	});

	it("a reply to the question itself is a typed answer; a question that needs a button says so", async () => {
		const { tg, asks, send, settle } = setup();
		const typed = asks.add(
			question({
				kind: "dialog",
				title: "Name the branch",
				fields: [{ id: "value", text: "Branch name?", options: [], multi: false, allowText: true }],
			}),
		);
		await settle();
		const m1 = tg.last("sendMessage") as Call;
		expect(m1.params.text).toContain("Reply to this message with your answer.");
		await send(say("feature/x", m1.result.message_id));
		expect(asks.answered).toEqual([{ id: typed.id, answers: [{ id: "value", selected: [], text: "feature/x" }] }]);

		asks.add(
			question({
				fields: [{ id: "ok", text: "OK?", options: [{ value: "yes", label: "Yes" }], multi: false, allowText: false }],
			}),
		);
		await settle();
		const m2 = tg.last("sendMessage") as Call;
		await send(say("yes please", m2.result.message_id));
		expect(tg.last("sendMessage")?.params.text).toContain("This one needs a button");
		expect(asks.answered).toHaveLength(1);
	});

	it("an answer the chat refuses brings the question back with the reason", async () => {
		const { tg, asks, send, settle } = setup();
		asks.add(question());
		await settle();
		const msg = tg.last("sendMessage") as Call;
		asks.refuseWith("that answer doesn't fit");
		await send(tap(dataOf(msg, "Red"), msg.result.message_id));
		const again = tg.last("editMessageText") as Call;
		expect(again.params.text).toContain("that answer doesn't fit");
		expect(again.params.text).toContain("Please answer again.");
		expect(buttons(again).map((b: Any) => b.text)).toEqual(["Red", "Blue", "\u270F\uFE0F Type an answer"]);
	});
});

describe("telegram plugin: answered elsewhere, gone, strangers", () => {
	it("an answer in the browser updates the message, and its old buttons only say it's no longer waiting", async () => {
		const { tg, asks, bridge, send, settle } = setup();
		const ask = asks.add(question());
		await settle();
		const msg = tg.last("sendMessage") as Call;
		asks.answerInBrowser(ask.id, "Red");
		await settle();
		const edit = tg.last("editMessageText")?.params;
		expect(edit.text).toContain("Answered in the browser</b>: Red");
		expect(edit.reply_markup).toEqual({ inline_keyboard: [] });
		expect(bridge.entries.size).toBe(0);

		await send(tap(dataOf(msg, "Blue"), msg.result.message_id));
		expect(tg.last("answerCallbackQuery")?.params.text).toBe("No longer waiting.");
		expect(tg.last("editMessageReplyMarkup")?.params).toMatchObject({
			message_id: msg.result.message_id,
			reply_markup: { inline_keyboard: [] },
		});
		expect(asks.answered).toEqual([]);
	});

	it("a question that goes away says why", async () => {
		const { tg, asks, settle } = setup();
		const ask = asks.add(question());
		await settle();
		asks.goAway(ask.id, "the chat was closed");
		await settle();
		expect(tg.last("editMessageText")?.params.text).toContain("No longer waiting</b>: the chat was closed");
	});

	it("ignores everyone but the owner, and the owner outside the private chat", async () => {
		const { tg, asks, send, settle } = setup();
		asks.add(question());
		await settle();
		const msg = tg.last("sendMessage") as Call;
		const before = tg.calls.length;
		await send(tap(dataOf(msg, "Red"), msg.result.message_id, STRANGER));
		await send(say("Red", msg.result.message_id, STRANGER));
		await send(say("/start", undefined, STRANGER));
		await send(say("Red", msg.result.message_id, OWNER, { id: -100123, type: "supergroup" }));
		expect(tg.calls.length).toBe(before);
		expect(asks.answered).toEqual([]);
	});

	it("/start from the owner says hello and how many are waiting", async () => {
		const { tg, asks, send, settle } = setup();
		asks.add(question());
		await settle();
		await send(say("/start"));
		const hello = tg.of("sendMessage").find((c) => String(c.params.text).startsWith("Hi!"));
		expect(hello?.params.text).toContain("Waiting now: 1.");
	});
});

describe("telegram plugin: API client and polling", () => {
	it("errors never show the bot token", async () => {
		const fetchImpl = vi.fn(async (url: string) => {
			if (String(url).endsWith("/getMe")) throw new Error(`connect failed for ${url}`);
			return errResponse(400, `Bad Request: token ${TOKEN} is odd`);
		});
		const api = createTelegramApi({ base: "http://fake-telegram", token: TOKEN, fetchImpl: fetchImpl as Any });
		const e1 = await api.call("sendMessage", {}).catch((e: Error) => e);
		const e2 = await api.call("getMe", {}).catch((e: Error) => e);
		for (const e of [e1, e2]) {
			expect(String((e as Error).message)).not.toContain("SECRET");
			expect(String((e as Error).message)).toContain("<token>");
		}
		expect((e1 as Any).code).toBe(400);
	});

	it("polls for updates, remembers where it got to, and stops when the token is refused", async () => {
		const pages: Response[] = [
			okResponse([
				{ update_id: 70, message: { text: "a" } },
				{ update_id: 71, message: { text: "b" } },
			]),
			errResponse(401, "Unauthorized"),
		];
		const offsets: number[] = [];
		const fetchImpl = async (_url: string, init: Any) => {
			offsets.push(JSON.parse(init.body).offset);
			return pages.shift() ?? errResponse(401, "Unauthorized");
		};
		const api = createTelegramApi({ base: "http://fake-telegram", token: TOKEN, fetchImpl: fetchImpl as Any });
		const storage = memStorage({ offset: 70 });
		const seen: Any[] = [];
		const statuses: string[] = [];
		const fatal = new Promise<void>((resolve) => {
			createPoller({
				api,
				storage,
				onUpdate: async (u: Any) => {
					seen.push(u.update_id);
				},
				onStatus: (s: string) => statuses.push(s),
				onFatal: () => resolve(),
			}).start();
		});
		await fatal;
		expect(seen).toEqual([70, 71]);
		expect(offsets).toEqual([70, 72]);
		expect(storage.get("offset")).toBe(72);
		expect(statuses.at(-1)).toContain("token was refused");
	});

	it("chat links point at the web app with ?chat=", () => {
		expect(chatLink("", SESSION)).toBeNull();
		expect(chatLink(ADDRESS, "")).toBeNull();
		expect(chatLink("javascript:alert(1)", SESSION)).toBeNull();
		const url = new URL(chatLink(ADDRESS, SESSION) as string);
		expect(url.origin).toBe("https://pi.example.ts.net:8787");
		expect(url.searchParams.get("chat")).toBe(SESSION);
	});
});

describe("telegram plugin: activate", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function hostWith(settings: Record<string, unknown>, statuses: string[]) {
		return createMockHost({
			settings,
			asks: { list: () => [], answer: async () => ({ ok: false, error: "none" }) },
			registerBackgroundTask: (t: Any) => {
				statuses.push(t.status);
				return { update: (n: Any) => n.status && statuses.push(n.status), unregister: () => {} };
			},
		}) as Any;
	}

	it("does nothing until it has a token and your id, and says which is missing", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ botToken: "", ownerId: OWNER }, "not set up: add the bot token in the settings"],
			[{ botToken: TOKEN, ownerId: "" }, "not set up: add your Telegram id in the settings"],
			[{ botToken: "", ownerId: "" }, "not set up: add the bot token and your Telegram id in the settings"],
		];
		for (const [settings, want] of cases) {
			const statuses: string[] = [];
			const host = hostWith(settings, statuses);
			const off = telegramPlugin.activate(host);
			expect(statuses.at(-1)).toBe(want);
			expect(host.mock.handlers["asks.on"] ?? []).toHaveLength(0);
			off?.();
		}
	});

	it("once set up it listens and polls its own bot; a new bot starts over; unloading stops both", async () => {
		const urls: string[] = [];
		const bodies: Any[] = [];
		let aborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string, init: Any) => {
				urls.push(String(url));
				bodies.push(JSON.parse(init.body));
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					});
				});
			}),
		);
		const statuses: string[] = [];
		const host = hostWith({ botToken: TOKEN, ownerId: OWNER }, statuses);
		host.storage.set("bot", "999");
		host.storage.set("offset", 77);
		const off = telegramPlugin.activate(host);
		expect(host.mock.handlers["asks.on"]).toHaveLength(1);
		await vi.waitFor(() => expect(urls.some((u) => u.endsWith("/getUpdates"))).toBe(true));
		expect(urls[0]).toContain("/bot123456:SECRET-token-value/");
		expect(bodies[urls.findIndex((u) => u.endsWith("/getUpdates"))].offset).toBe(0);
		expect(host.storage.get("bot")).toBe("123456");
		off?.();
		expect(host.mock.handlers["asks.on"]).toHaveLength(0);
		await vi.waitFor(() => expect(aborted).toBe(true));
	});
});
