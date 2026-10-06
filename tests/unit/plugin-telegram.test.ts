/**
 * telegram-answers: the Telegram plugin against a fake Telegram (no network) and a fake list of
 * waiting asks. Checks what is sent, that taps and replies answer the chat, that answers made
 * elsewhere update the message, and that nobody but the owner counts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockHost } from "../../plugin-sdk/index.mjs";
import telegramPlugin, {
	BRIEF_WAIT_MS,
	NOW_ENV,
	ONLY_TEXT,
	QUOTE_OVER,
	TEXT_BUDGET,
	briefRequest,
	chatLink,
	clockFrom,
	codeBlock,
	createBridge,
	createChat,
	parseClock,
	roleName,
	splitReply,
	zoneClock,
	createPoller,
	createTelegramApi,
	htmlToPlain,
	leadOf,
	lineFromOldHead,
	plainText,
	renderAnswered,
	renderAsk,
	renderFooter,
	renderGone,
	renderHead,
	renderLine,
	stuckTask,
	toTelegramHtml,
	visibleLength,
} from "../../plugins/telegram/index.mjs";

const OWNER = "8778288252";
const STRANGER = "5550001111";
const TOKEN = "123456:SECRET-token-value";
const ADDRESS = "https://pi.example.ts.net:8787/";
const SESSION = "/home/x/.pi/agent/sessions/abc.jsonl";
const LINK = chatLink(ADDRESS, SESSION) as string;
/** The link that opens the chat, as it shows in a message. */
const OPEN = `<a href="${LINK.replace(/&/g, "&amp;")}">Open the chat</a>`;
/** The line over a question's listed choices, and the one over the footer. */
const CHOICES = `\u2500\u2500 CHOICES ${"\u2500".repeat(8)}`;
const RULE = "\u2500".repeat(18);
/** The one line an answered or gone question shrinks to (see the "finished messages" tests). */
const finalLine = (title: string, chat: string) =>
	`<a href="${LINK.replace(/&/g, "&amp;")}"><b>${title}</b></a> \u00B7 <i>${chat}</i>`;

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
		expect(p.link_preview_options).toEqual({ is_disabled: true });
		expect(p.text).toBe(
			[
				"\u2753 <b>Pick a colour</b> \u00B7 <i>from Throwaway</i>",
				"<b>Which colour?</b>",
				`${CHOICES}\n<b>1 \u00B7 Red</b>\nwarm\n\n<b>2 \u00B7 Blue</b>`,
			].join("\n\n") + `\n${RULE}\n<i>\u{1F4C1} ~/projects/demo</i> \u00B7 ${OPEN}`,
		);
		expect(buttons(sent[0]).map((b: Any) => b.text)).toEqual([
			"1 \u00B7 Red",
			"2 \u00B7 Blue",
			"\u270F\uFE0F Type an answer",
		]);
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
		expect(p.text).toContain("<blockquote expandable>echo xxx");
		expect(p.text).toContain("<i>(cut: open the chat for the rest)</i>");
		expect(p.text.endsWith(OPEN)).toBe(true);
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
		// A message sent before the one-line finals kept only its head: its line comes from that.
		expect(edit?.params.text).toBe("\u23F9 <b>Old</b>: no longer waiting (pi restarted)");
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
			.filter((c) => c.params.text === `\u2705 ${finalLine("Pick a colour", "Throwaway")}: Blue <i>(on Telegram)</i>`)
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
					text: "Type your answer to:\nWhich colour?",
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
		expect(final.text).toBe(`\u2705 ${finalLine("Pick a colour", "Throwaway")}: Blue <i>(on Telegram)</i>`);
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
		expect(prompt.params.text).toBe("Type your answer to:\n<b>Which colour?</b>");
		expect(prompt.params.parse_mode).toBe("HTML");
		expect(prompt.params.reply_markup.force_reply).toBe(true);
		expect(prompt.params.reply_parameters.message_id).toBe(msg.result.message_id);
		await send(say("Green", prompt.result.message_id));
		expect(asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: [], text: "Green" }] }]);
		expect(tg.of("deleteMessage").map((c) => c.params.message_id)).toContain(prompt.result.message_id);
		expect(tg.last("editMessageText")?.params.text).toContain(": Green <i>(on Telegram)</i>");
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
		expect(buttons(again).map((b: Any) => b.text)).toEqual([
			"1 \u00B7 Red",
			"2 \u00B7 Blue",
			"\u270F\uFE0F Type an answer",
		]);
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
		expect(edit.text).toBe(`\u2705 ${finalLine("Pick a colour", "Throwaway")}: Red <i>(in the browser)</i>`);
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
		expect(tg.last("editMessageText")?.params.text).toBe(
			`\u23F9 ${finalLine("Pick a colour", "Throwaway")}: no longer waiting (the chat was closed)`,
		);
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

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Why `html` isn't Telegram HTML we may send, or "" when it is: only Telegram's tags (b, i, u, s,
 * code, pre, a with an address, blockquote), balanced and properly nested, nothing inside code, no
 * link in a link, no quote in a quote, no tag inside itself; every <, > and & escaped.
 * `outer`: the tags it will sit inside.
 */
function htmlProblem(html: string, outer: string[] = []): string {
	const stack: string[] = [];
	const textProblem = (t: string) => {
		if (/[<>]/.test(t)) return `a bare < or > in ${JSON.stringify(t.slice(0, 60))}`;
		if (/&(?!(amp|lt|gt|quot);)/.test(t)) return `a bare & in ${JSON.stringify(t.slice(0, 60))}`;
		return "";
	};
	let last = 0;
	for (const m of html.matchAll(/<[^<>]*>/g)) {
		const bad = textProblem(html.slice(last, m.index));
		if (bad) return bad;
		last = (m.index ?? 0) + m[0].length;
		const tag = /^<(\/?)(b|i|u|s|code|pre|a|blockquote)( expandable| href="[^"<>]*")?>$/.exec(m[0]);
		if (!tag) return `a tag Telegram doesn't take: ${m[0]}`;
		const [, slash, name, attr = ""] = tag;
		if (slash) {
			if (attr) return `attributes on a closing tag: ${m[0]}`;
			const top = stack.pop();
			if (top !== name) return `</${name}> closes <${top ?? "nothing"}>`;
			continue;
		}
		if (attr.startsWith(" href") !== (name === "a")) return `a link without an address, or an address on <${name}>`;
		if (attr === " expandable" && name !== "blockquote") return `expandable on <${name}>`;
		if (/&(?!(amp|lt|gt|quot);)/.test(attr)) return `a bare & in ${m[0]}`;
		const inside = [...outer, ...stack];
		if (inside.some((t) => t === "code" || t === "pre")) return `<${name}> inside code`;
		if (name === "a" && inside.includes("a")) return "a link inside a link";
		if ((name === "code" || name === "pre") && inside.includes("a")) return "code inside a link";
		if (name === "blockquote" && inside.includes("blockquote")) return "a quote inside a quote";
		if (inside.includes(name)) return `<${name}> inside <${name}>`;
		stack.push(name);
	}
	return textProblem(html.slice(last)) || (stack.length ? `never closed: ${stack.join(", ")}` : "");
}

describe("telegram plugin: how messages look", () => {
	const st = (over: Any = {}) => ({ ref: 7, step: 0, answers: {}, ticks: [], link: LINK, ...over });
	const base = {
		id: "a1",
		createdAt: 1,
		conversationTitle: "tooling",
		cwd: `${process.env.HOME}/projects/pi-web-ui`,
		sessionFile: SESSION,
	};
	const footer = `<i>\u{1F4C1} ~/projects/pi-web-ui</i> \u00B7 ${OPEN}`;
	/** How every message ends: a line, then the footer right under it. */
	const end = `\n${RULE}\n${footer}`;
	const labels = (r: Any) => r.reply_markup.inline_keyboard.map((row: Any) => row[0].text);
	const yesNo = [
		{ value: "yes", label: "Yes" },
		{ value: "no", label: "No" },
	];

	it("a question: a one-line head, the question, its detail, its choices numbered like their buttons, a footer", () => {
		const ask = {
			...base,
			kind: "question",
			title: "Deploy",
			fields: [
				{
					id: "d",
					header: "Deploy",
					text: "Deploy **now** with `pi-web-deploy`?",
					detail: "It restarts _right away_.",
					options: [
						{ value: "Now", label: "Now", description: "Restart **right away**." },
						{ value: "Idle", label: "When idle", description: "Wait for idle chats (`--when-idle`)." },
						{ value: "Later", label: "Later", description: "Don't deploy yet." },
					],
					multi: false,
					allowText: true,
				},
			],
		};
		const { text, reply_markup } = renderAsk(ask, st());
		expect(text).toBe(
			[
				"\u2753 <b>Deploy</b> \u00B7 <i>from tooling</i>",
				// The question, the part you must read, in bold (so its own bold goes).
				"<b>Deploy now with <code>pi-web-deploy</code>?</b>",
				"<i>It restarts right away.</i>",
				// The choices under a "CHOICES" line, each numbered like its button, apart from each other.
				[
					`${CHOICES}\n<b>1 \u00B7 Now</b>\nRestart <b>right away</b>.`,
					"<b>2 \u00B7 When idle</b>\nWait for idle chats (<code>--when-idle</code>).",
					"<b>3 \u00B7 Later</b>\nDon't deploy yet.",
				].join("\n\n"),
			].join("\n\n") + end,
		);
		// One question: its header is the title, said once.
		expect(text.match(/Deploy<\/b>/g)).toHaveLength(1);
		expect(reply_markup.inline_keyboard.map((r: Any) => r[0].text)).toEqual([
			"1 \u00B7 Now",
			"2 \u00B7 When idle",
			"3 \u00B7 Later",
			"\u270F\uFE0F Type an answer",
		]);
	});

	it("several questions: each shows its header and where it is, then the answers so far", () => {
		const ask = {
			...base,
			kind: "question",
			title: "3 questions",
			fields: [
				{
					id: "c",
					header: "Colour",
					text: "Which colour?",
					options: [
						{ value: "Red", label: "Red", description: "Warm." },
						{ value: "Blue", label: "Blue" },
					],
					multi: false,
					allowText: true,
				},
				{
					id: "s",
					header: "Size",
					text: "Which size?",
					options: [
						{ value: "S", label: "S" },
						{ value: "L", label: "L" },
					],
					multi: false,
					allowText: true,
				},
				{ id: "n", header: "Note", text: "Anything else?", options: [], multi: false, allowText: true },
			],
		};
		const head = "\u2753 <b>3 questions</b> \u00B7 <i>from tooling</i>";
		const colour = renderAsk(ask, st());
		expect(colour.text).toBe(
			[
				head,
				"<i>Colour (1/3)</i>\n<b>Which colour?</b>",
				// One choice has a description: all of them are listed, so the numbers match the buttons.
				`${CHOICES}\n<b>1 \u00B7 Red</b>\nWarm.\n\n<b>2 \u00B7 Blue</b>`,
			].join("\n\n") + end,
		);
		expect(labels(colour)).toEqual(["1 \u00B7 Red", "2 \u00B7 Blue", "\u270F\uFE0F Type an answer"]);
		// Choices without descriptions show on their buttons alone, without numbers.
		const size = renderAsk(ask, st({ step: 1, answers: { c: { selected: ["Red"] } } }));
		expect(size.text).toBe(
			[head, "\u2714\uFE0F Colour: Red", "<i>Size (2/3)</i>\n<b>Which size?</b>"].join("\n\n") + end,
		);
		expect(labels(size)).toEqual(["S", "L", "\u270F\uFE0F Type an answer"]);
		const answers = { c: { selected: ["Red"] }, s: { selected: ["L"] } };
		expect(renderAsk(ask, st({ step: 2, answers })).text).toBe(
			[
				head,
				"\u2714\uFE0F Colour: Red\n\u2714\uFE0F Size: L",
				"<i>Note (3/3)</i>\n<b>Anything else?</b>",
				"<i>Reply to this message with your answer.</i>",
			].join("\n\n") + end,
		);
	});

	it("a stuck task: 'Task #N needs you' with the task's title under it, and no chat line", () => {
		const ask = {
			...base,
			conversationTitle: "Queue #26",
			kind: "stuck",
			title: "Task #26 needs you: Make *it* nice",
			task: { id: 26, title: "Make *it* nice" },
			fields: [
				{
					id: "answer",
					text: "The run failed because the model was busy (503 overloaded). Reply here to carry on.\n`503 overloaded_error`",
					options: [{ value: "Carry on", label: "Carry on" }],
					multi: false,
					allowText: true,
				},
			],
		};
		expect(renderAsk(ask, st()).text).toBe(
			[
				"\u{1F4CC} <b>Task #26 needs you</b>\n<i>Make it nice</i>",
				"<b>The run failed because the model was busy (503 overloaded).</b>\nReply here to carry on.\n<code>503 overloaded_error</code>",
			].join("\n\n") + end,
		);
		// From a server that doesn't say which task: the title does.
		const { task: _task, ...older } = ask;
		expect(stuckTask(older)).toEqual({ id: 26, title: "Make *it* nice" });
		expect(renderHead(older)).toBe("\u{1F4CC} <b>Task #26 needs you</b>\n<i>Make it nice</i>");
	});

	it("a permission prompt: the command as code (in a collapsed quote when long), and the reason once", () => {
		const approval = (command: string) => ({
			...base,
			kind: "approval",
			title: "Allow bash?",
			body: command,
			fields: [
				{
					id: "decision",
					text: "Allow bash? It pushes the branch.",
					options: [
						{ value: "approve", label: "Approve" },
						{ value: "category", label: "Allow this kind here", description: "git push" },
						{ value: "deny", label: "Deny" },
					],
					multi: false,
					allowText: false,
				},
			],
		});
		expect(renderAsk(approval("git push origin mine"), st()).text).toBe(
			[
				"\u{1F510} <b>Allow bash?</b> \u00B7 <i>from tooling</i>",
				"<pre>git push origin mine</pre>",
				"<b>It pushes the branch.</b>",
				`${CHOICES}\n<b>1 \u00B7 Approve</b>\n\n<b>2 \u00B7 Allow this kind here</b>\ngit push\n\n<b>3 \u00B7 Deny</b>`,
			].join("\n\n") + end,
		);
		expect(labels(renderAsk(approval("x"), st()))).toEqual([
			"1 \u00B7 Approve",
			"2 \u00B7 Allow this kind here",
			"3 \u00B7 Deny",
		]);
		const long = 'cd ~/projects/pi-web-ui && git push origin mine --force-with-lease && echo "<done>"';
		expect(long.length).toBeGreaterThan(QUOTE_OVER);
		expect(renderAsk(approval(long), st()).text).toContain(`\n\n<blockquote expandable>${esc(long)}</blockquote>\n\n`);
		expect(codeBlock("line 1\nline 2")).toBe("<blockquote expandable>line 1\nline 2</blockquote>");
	});

	it("an add-on's pop-up shows its text formatted: a heading, lists, code, a table, a quote", () => {
		const plan = [
			"## Plan",
			"",
			"1. Add a **converter**.",
			"2. Rework `renderAsk`:",
			"   - blank lines",
			"   - one footer",
			"",
			"| Step | Time |",
			"|---|---|",
			"| build | 2m |",
			"",
			"> <b>HTML</b> is <em>fine</em> too.",
		].join("\n");
		const ask = {
			...base,
			kind: "dialog",
			title: "Approve the plan?",
			body: plan,
			fields: [{ id: "value", text: "Approve the plan?", options: yesNo, multi: false, allowText: false }],
		};
		expect(renderAsk(ask, st()).text).toBe(
			[
				"\u{1F4AC} <b>Approve the plan?</b> \u00B7 <i>from tooling</i>",
				"<b>Plan</b>",
				"1. Add a <b>converter</b>.\n2. Rework <code>renderAsk</code>:\n   \u25E6 blank lines\n   \u25E6 one footer",
				"<pre>Step  | Time\n------+-----\nbuild | 2m</pre>",
				"<blockquote><b>HTML</b> is <i>fine</i> too.</blockquote>",
			].join("\n\n") + end,
		);
		expect(labels(renderAsk(ask, st()))).toEqual(["Yes", "No"]);
	});

	it("many described choices: the text lists 12 and says how many more; the buttons hold them all", () => {
		const ask = {
			...base,
			kind: "question",
			title: "Pick",
			fields: [
				{
					id: "p",
					text: "Which ones?",
					options: Array.from({ length: 15 }, (_, i) => ({
						value: `v${i}`,
						label: `C${i + 1}`,
						description: `d${i + 1}`,
					})),
					multi: true,
					allowText: false,
				},
			],
		};
		const r = renderAsk(ask, st({ ticks: ["v1"] }));
		expect(r.text).toContain(`${CHOICES}\n<b>1 \u00B7 C1</b>\nd1\n\n<b>2 \u00B7 C2</b>\nd2\n\n`);
		expect(r.text).toContain("<b>12 \u00B7 C12</b>\nd12\n\n<i>and 3 more on the buttons</i>");
		expect(r.text).not.toContain("C13");
		expect(r.text.endsWith(`<i>Tick all that fit, then tap Done.</i>${end}`)).toBe(true);
		const shown = labels(r);
		expect(shown).toHaveLength(16);
		expect(shown.slice(0, 2)).toEqual(["\u2610 1 \u00B7 C1", "\u2611 2 \u00B7 C2"]);
		expect(shown.slice(-2)).toEqual(["\u2610 15 \u00B7 C15", "\u2705 Done"]);
	});

	it("the head and the footer: markup in titles is dropped, the rest escaped", () => {
		expect(renderHead({ kind: "question", title: "**Big** `x` <b>y</b>", conversationTitle: "a\nb & <c>" })).toBe(
			"\u2753 <b>Big x y</b> \u00B7 <i>from a b &amp; &lt;c&gt;</i>",
		);
		expect(renderHead({ kind: "dialog", title: "" })).toBe("\u{1F4AC} <b>A chat needs you</b>");
		expect(renderFooter({ cwd: `${process.env.HOME}/x` }, LINK)).toBe(`<i>\u{1F4C1} ~/x</i> \u00B7 ${OPEN}`);
		expect(renderFooter({ cwd: "/srv/a&b" }, null)).toBe("<i>\u{1F4C1} /srv/a&amp;b</i>");
		expect(renderFooter({}, LINK)).toBe(OPEN);
		expect(renderFooter({}, null)).toBe("");
	});

	it("a head too long for a phone's line puts the chat on the next line, cut at a word", () => {
		const ask = {
			kind: "question",
			title: "Telegram look",
			conversationTitle: "Queue #26: Telegram messages easy to read",
		};
		expect(renderHead(ask)).toBe("\u2753 <b>Telegram look</b>\n<i>from Queue #26: Telegram messages\u2026</i>");
		expect(renderHead({ ...ask, conversationTitle: "tooling" })).toBe(
			"\u2753 <b>Telegram look</b> \u00B7 <i>from tooling</i>",
		);
		// A chat title in one long word is cut where it has to be.
		expect(renderHead({ ...ask, conversationTitle: "x".repeat(60) })).toBe(
			`\u2753 <b>Telegram look</b>\n<i>from ${"x".repeat(30)}\u2026</i>`,
		);
	});

	it("the part of a question you must read is in bold: up to its question mark, else its first sentence", () => {
		const lead = (s: string) => leadOf(s).lead;
		expect(leadOf("What now?\n\nMore text here.")).toEqual({ lead: "What now?", sep: "\n\n", rest: "More text here." });
		expect(leadOf("It failed. Retry? Or not.")).toEqual({ lead: "It failed. Retry?", sep: "\n", rest: "Or not." });
		expect(lead("The run failed (503 overloaded). Reply here.")).toBe("The run failed (503 overloaded).");
		expect(lead("Pick one:\n- a\n- b")).toBe("Pick one:");
		// Full stops that don't end a sentence.
		expect(lead("Use v3.5 and notes.md, e.g. the new one. Then go")).toBe("Use v3.5 and notes.md, e.g. the new one.");
		expect(lead("Ask Mr. Smith first. Then go")).toBe("Ask Mr. Smith first.");
		expect(lead("Open https://x.y/a?b=1 now? ok")).toBe("Open https://x.y/a?b=1 now?");
		expect(lead("See [the docs. here](https://x.y) (they say so. really). Next")).toBe(
			"See [the docs. here](https://x.y) (they say so. really).",
		);
		expect(lead("Run `a. B` now. Next")).toBe("Run `a. B` now.");
		expect(lead("**Why?** Because.")).toBe("**Why?**");
		// None to pick out: it would cut a piece of formatting, it starts with a block or HTML, it's too long.
		expect(lead("**Note. This matters** a lot")).toBe("");
		expect(lead("- a list? yes")).toBe("");
		expect(lead("> a quote? yes")).toBe("");
		expect(lead("## Plan? yes")).toBe("");
		expect(lead("```\ncode?\n```")).toBe("");
		expect(lead("<p>Why?</p>")).toBe("");
		expect(lead(`${"x ".repeat(120)}?`)).toBe("");
		expect(lead("")).toBe("");
		// Without one, the question shows as it was.
		const ask = { kind: "question", title: "Q", fields: [{ id: "q", text: "- one\n- two", options: [] }] };
		expect(renderAsk(ask, { ref: 1, step: 0, answers: {}, ticks: [] }).text).toBe(
			"\u2753 <b>Q</b>\n\n\u2022 one\n\u2022 two",
		);
	});

	it("finished messages are one line: what it was, which chat, and the answer or why it stopped", () => {
		const q = { ...base, kind: "question", title: "Deploy", fields: [] };
		const several = { ...base, kind: "question", title: "2 questions", fields: [] };
		const d = { ...base, kind: "dialog", title: "Approve the plan?", fields: [] };
		const p = { ...base, kind: "approval", title: "Allow bash?", fields: [] };
		const s = {
			...base,
			kind: "stuck",
			title: "Task #3 needs you: Ship it",
			task: { id: 3, title: "Ship it" },
			fields: [],
		};
		const line = (t: string, c: string) => `<a href="${LINK}"><b>${t}</b></a> \u00B7 <i>${c}</i>`;
		const finals = [
			[
				renderAnswered(renderLine(q, LINK), "Now", "telegram"),
				`\u2705 ${line("Deploy", "tooling")}: Now <i>(on Telegram)</i>`,
			],
			[
				renderAnswered(renderLine(several, LINK), "Colour: Red; Size: L", "browser"),
				`\u2705 ${line("2 questions", "tooling")}: Colour: Red; Size: L <i>(in the browser)</i>`,
			],
			[
				renderAnswered(renderLine(d, LINK), "Yes", undefined),
				`\u2705 ${line("Approve the plan?", "tooling")}: Yes <i>(in the browser)</i>`,
			],
			[
				renderAnswered(renderLine(p, LINK), "Approved <all>", "telegram"),
				`\u2705 ${line("Allow bash?", "tooling")}: Approved &lt;all&gt; <i>(on Telegram)</i>`,
			],
			[
				renderAnswered(renderLine(s, LINK), "Carry on,\nplease", "telegram"),
				`\u2705 ${line("Task #3", "Ship it")}: Carry on, please <i>(on Telegram)</i>`,
			],
			[
				renderGone(renderLine(q, LINK), "the chat was closed"),
				`\u23F9 ${line("Deploy", "tooling")}: no longer waiting (the chat was closed)`,
			],
			[
				renderGone(renderLine(s, null), ""),
				"\u23F9 <b>Task #3</b> \u00B7 <i>Ship it</i>: no longer waiting (it went away)",
			],
			// A message sent before this layout kept only its head: its line comes from that.
			[
				lineFromOldHead("\u2753 <b>Deploy</b>\nChat: tooling\nFolder: <code>~/x</code>", LINK),
				line("Deploy", "tooling"),
			],
			[
				lineFromOldHead("\u{1F4CC} <b>Task #3 needs you: Ship it</b>\nChat: Queue #3", null),
				"<b>Task #3</b> \u00B7 <i>Ship it</i>",
			],
		];
		for (const [got, want] of finals) {
			expect(got).toBe(want);
			expect(got).not.toContain("\n");
			expect(htmlProblem(got)).toBe("");
		}
	});

	it("a long text is cut to fit Telegram, keeping the question, the choices and the footer", () => {
		const plan = Array.from(
			{ length: 400 },
			(_, i) => `- step ${i}: **do** \`thing ${i}\` [see](https://x.y/${i}) & more`,
		).join("\n");
		const ask = {
			...base,
			kind: "dialog",
			title: "Approve?",
			body: plan,
			fields: [{ id: "value", text: "Approve?", options: yesNo, multi: false, allowText: false }],
		};
		const { text } = renderAsk(ask, st());
		expect(visibleLength(text)).toBeLessThanOrEqual(TEXT_BUDGET);
		expect(visibleLength(text)).toBeGreaterThan(TEXT_BUDGET - 500);
		expect(text).toContain(`\n\n<i>(cut: open the chat for the rest)</i>${end}`);
		expect(text.endsWith(end)).toBe(true);
		expect(htmlProblem(text)).toBe("");

		// Too much even without the text above: the question alone, then the footer.
		const crowded = {
			...base,
			kind: "question",
			title: "Q",
			fields: [
				{
					id: "q",
					// A table of empty cells gets longer as lined-up columns.
					text: "|||||||||||\n".repeat(600),
					options: Array.from({ length: 12 }, (_, i) => ({
						value: `o${i}`,
						label: `Choice ${i}`,
						description: "words ".repeat(40),
					})),
					multi: false,
					allowText: true,
				},
			],
		};
		const short = renderAsk(crowded, st()).text;
		expect(visibleLength(short)).toBeLessThanOrEqual(TEXT_BUDGET);
		expect(short).toContain("<i>(cut: open the chat for the rest)</i>");
		expect(short.endsWith(footer)).toBe(true);
		expect(htmlProblem(short)).toBe("");
	});
});

describe("telegram plugin: a chat's text as Telegram HTML", () => {
	it.each([
		[
			"**bold** and *it* and _it_ and __b__ and ~~s~~",
			"<b>bold</b> and <i>it</i> and <i>it</i> and <b>b</b> and <s>s</s>",
		],
		["snake_case_name and 2 * 3 * 4 stay", "snake_case_name and 2 * 3 * 4 stay"],
		["`a < b && c` and `**not bold**`", "<code>a &lt; b &amp;&amp; c</code> and <code>**not bold**</code>"],
		["**`code` in bold**", "<b><code>code</code> in bold</b>"],
		[
			"[the docs](https://example.com/a_b?x=1&y=2) and [bad](javascript:alert(1))",
			'<a href="https://example.com/a_b?x=1&amp;y=2">the docs</a> and bad',
		],
		["[`code` in a link](https://x.y)", '<a href="https://x.y">code in a link</a>'],
		["see https://example.com/x_y_z. and <https://a.b/c>", "see https://example.com/x_y_z. and https://a.b/c"],
		[
			"- one\n* two\n  - nested\n- [ ] todo\n- [x] done\n1. first\n2) second",
			"\u2022 one\n\u2022 two\n   \u25E6 nested\n\u2610 todo\n\u2611 done\n1. first\n2. second",
		],
		["# Title\n\nText under it", "<b>Title</b>\n\nText under it"],
		["| a | b |\n|---|---|\n| 1 | 2 |", "<pre>a | b\n--+--\n1 | 2</pre>"],
		["```js\nconst x = 1 < 2;\n```", "<pre>const x = 1 &lt; 2;</pre>"],
		["> quoted **text**\n> more", "<blockquote>quoted <b>text</b>\nmore</blockquote>"],
		["\\*not italic\\*", "*not italic*"],
		["a\n\n\n\nb", "a\n\nb"],
		// HTML
		[
			"<p>Hello <strong>you</strong><br>there</p><ul><li>one</li><li>two</li></ul>",
			"Hello <b>you</b>\nthere\n\n\u2022 one\n\u2022 two",
		],
		["<h2>Plan</h2><p>Do <em>it</em></p><ol><li>a</li><li>b</li></ol>", "<b>Plan</b>\n\nDo <i>it</i>\n\n1. a\n2. b"],
		["<p>one<p>two", "one\n\ntwo"],
		['<div class="x"><span>kept</span> <script>alert(1)</script></div>', "kept alert(1)"],
		// A <word> that isn't HTML is text ("<sha>"), and so is one that could be but isn't closed.
		[
			"Use <sha> and <folder>, or <label> and <time>",
			"Use &lt;sha&gt; and &lt;folder&gt;, or &lt;label&gt; and &lt;time&gt;",
		],
		['<label>Name</label> <time datetime="x">now</time>', "Name now"],
		["&amp; &lt;b&gt; &#39; &mdash; &unknown; & <", "&amp; &lt;b&gt; ' \u2014 &amp;unknown; &amp; &lt;"],
		// Unbalanced or tangled: always balanced after.
		["**bold without end and <b>open never closed", "**bold without end and <b>open never closed</b>"],
		["</i>stray close", "stray close"],
		["<b><i>x</b></i>", "<b><i>x</i></b>"],
		['<a href="https://a">x <a href="https://b">y</a></a>', '<a href="https://a">x y</a>'],
		["<b>line1\nline2</b>", "<b>line1</b>\n<b>line2</b>"],
		["\uE000bold\uE004 and \uE00A0\uE00B", "bold and 0"],
		// Long technical text: a collapsed quote.
		[
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded, please try again later"}}',
			`<blockquote expandable>${esc('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded, please try again later"}}')}</blockquote>`,
		],
		[`Run \`${"x".repeat(90)}\` now`, `Run\n<blockquote expandable>${"x".repeat(90)}</blockquote>\nnow`],
	])("%j", (src, want) => {
		expect(toTelegramHtml(src)).toBe(want);
		expect(htmlProblem(want)).toBe("");
	});

	it("plain text for buttons and titles, and Telegram HTML back to plain text", () => {
		expect(plainText("**Bold** label with `code` and [link](https://x.y) <b>x</b>\n& more")).toBe(
			"Bold label with code and link x & more",
		);
		expect(htmlToPlain('<b>x</b> <a href="https://a.b">site</a> &amp; <a href="https://c.d">https://c.d</a>')).toBe(
			"x site (https://a.b) & https://c.d",
		);
	});

	it("no input makes tags Telegram can't take, unbalanced ones, or a bare < > &", () => {
		const pieces = [
			"**",
			"*",
			"_",
			"__",
			"~~",
			"`",
			"``",
			"```",
			"\n```\n",
			"~~~",
			"[",
			"]",
			"(",
			")",
			"](",
			"](https://ex.am/p_q?a=1&b=2)",
			"](javascript:x)",
			"![",
			"<b>",
			"</b>",
			"<i>",
			"</i>",
			"<em>",
			"</strong>",
			"<u>",
			"<s>",
			"<del>",
			'<a href="https://a.b/c?x=1&y=2">',
			"<a href='tg://x'>",
			'<a href="javascript:x">',
			"<a>",
			"</a>",
			"<pre>",
			"</pre>",
			"<code>",
			"</code>",
			"<blockquote>",
			"</blockquote>",
			"<script>",
			"</script>",
			"<br>",
			"<br/>",
			"<p>",
			"</p>",
			"<ul>",
			"<li>",
			"</li>",
			"<ol>",
			"</ol>",
			"<h2>",
			"</h2>",
			"<hr>",
			"<table><tr><td>",
			"</td></tr></table>",
			"<sha>",
			"<label>",
			"</label>",
			'<div class="x">',
			"</div>",
			"<!--",
			"-->",
			"<",
			">",
			"&",
			"&amp;",
			"&lt;",
			"&#0;",
			"&#x1F600;",
			"&#xE000;",
			"&bogus;",
			'"',
			"'",
			"\n",
			"\n\n",
			"\n> ",
			"\n>> ",
			"\n- ",
			"\n  * ",
			"\n1. ",
			"\n# ",
			"\n## ",
			"|",
			"\n| a | b |\n|---|---|\n| 1 | 2 |\n",
			"\n---\n",
			"\\",
			"\\*",
			"\\`",
			'{"k":[1,2,{"v":"x"}]}',
			"https://example.com/a_b",
			"<https://x.y/z>",
			"mailto:a@b.c",
			"\uE000",
			"\uE004",
			"\uE008",
			"\uE00A0\uE00B",
			"\uE00A",
			"\uE00B",
			"\uF8FF",
			"\uD83D\uDE00",
			"\uD83D",
			"  ",
			"\t",
			"word",
			"snake_case",
			"x".repeat(90),
			"- [ ] ",
			"- [x] ",
			// Where a question's part in bold ends.
			"?",
			"? ",
			". ",
			"! ",
			"e.g. ",
			"Why? ",
			"Done. Next",
		];
		// A small seeded random generator, so a failure can be run again.
		let seed = 20260917;
		const rand = () => {
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const gen = (max: number) =>
			Array.from({ length: 1 + Math.floor(rand() * max) }, () => pieces[Math.floor(rand() * pieces.length)]).join(
				rand() < 0.5 ? "" : " ",
			);
		const bad: Any[] = [];
		const expectFine = (what: string, input: Any, html: string, outer: string[] = []) => {
			const problem = htmlProblem(html, outer);
			if (problem && bad.length < 5) bad.push({ what, problem, input, html });
		};
		// The characters the converter marks formatting with never get out (a text's own are dropped).
		const marks = /[\uE000-\uF8FF]/;
		for (let n = 0; n < 3000; n++) {
			const src = gen(30);
			const html = toTelegramHtml(src);
			expectFine("text", src, html);
			expectFine("in italics", src, toTelegramHtml(src, { outer: ["i"] }), ["i"]);
			expectFine("in bold", src, toTelegramHtml(src, { outer: ["b"] }), ["b"]);
			const plain = plainText(src);
			if (marks.test(html) || marks.test(plain) || plain.includes("\n")) bad.push({ what: "marks", input: src });
		}
		// Whole messages made of such texts: fine, and within the length Telegram takes.
		const kinds = ["question", "dialog", "approval", "stuck"];
		for (let n = 0; n < 400; n++) {
			const kind = kinds[n % kinds.length];
			const ask = {
				id: `r${n}`,
				kind,
				createdAt: n,
				conversationTitle: gen(8),
				cwd: `/tmp/${gen(3)}`,
				title: kind === "stuck" ? `Task #${n} needs you: ${gen(6)}` : gen(6),
				...(kind === "stuck" ? { task: { id: n, title: gen(6) } } : {}),
				...(n % 3 ? { body: gen(n % 5 === 0 ? 3000 : 60) } : {}),
				fields: [0, 1].slice(0, 1 + (n % 2)).map((i) => ({
					id: `f${i}`,
					header: gen(4),
					text: gen(n % 7 === 0 ? 800 : 30),
					detail: gen(10),
					options: Array.from({ length: n % 6 }, (_, k) => ({
						value: `v${k}`,
						label: gen(4),
						...(k % 2 ? { description: gen(20) } : {}),
					})),
					multi: n % 4 === 1,
					allowText: n % 2 === 0,
				})),
			};
			const { text, reply_markup } = renderAsk(ask, { ref: 1, step: 0, answers: {}, ticks: [], link: LINK });
			expectFine(`${kind} message`, ask, text);
			if (visibleLength(text) > TEXT_BUDGET) bad.push({ what: "too long", input: ask, length: visibleLength(text) });
			for (const row of reply_markup.inline_keyboard) {
				if (!row[0].text.trim() || Buffer.byteLength(row[0].callback_data) > 64) bad.push({ what: "button", row });
			}
			const line = renderLine(ask, LINK);
			for (const final of [renderAnswered(line, gen(10), "telegram"), renderGone(line, gen(5))]) {
				expectFine(`${kind} final words`, ask, final);
				if (final.includes("\n")) bad.push({ what: "final words on more than one line", final });
			}
		}
		expect(bad).toEqual([]);
	});
});

describe("telegram plugin: formatting Telegram can't read", () => {
	const cantParse = () =>
		errResponse(400, 'Bad Request: can\'t parse entities: Unsupported start tag "x" at byte offset 12');

	it("a message goes again as plain text, so it's never lost; so do its final words", async () => {
		const { tg, asks, bridge, settle } = setup();
		tg.failNext("sendMessage", cantParse());
		const ask = asks.add(question());
		await settle();
		const [html, plain] = tg.of("sendMessage");
		expect(tg.of("sendMessage")).toHaveLength(2);
		expect(html.params.parse_mode).toBe("HTML");
		expect(plain.params.parse_mode).toBeUndefined();
		expect(plain.params.text).toBe(
			[
				"\u2753 Pick a colour \u00B7 from Throwaway",
				"Which colour?",
				`${CHOICES}\n1 \u00B7 Red\nwarm\n\n2 \u00B7 Blue`,
			].join("\n\n") + `\n${RULE}\n\u{1F4C1} ~/projects/demo \u00B7 Open the chat (${LINK})`,
		);
		expect(plain.params.reply_markup).toEqual(html.params.reply_markup);
		expect(plain.params.link_preview_options).toEqual({ is_disabled: true });
		expect(bridge.entries.get(`${ask.id}@${ask.createdAt}`)?.messageId).toBe(plain.result.message_id);

		tg.failNext("editMessageText", cantParse());
		asks.answerInBrowser(ask.id, "Red");
		await settle();
		const [editHtml, editPlain] = tg.of("editMessageText");
		expect(tg.of("editMessageText")).toHaveLength(2);
		expect(editHtml.params.parse_mode).toBe("HTML");
		expect(editPlain.params.parse_mode).toBeUndefined();
		expect(editPlain.params.text).toBe(`\u2705 Pick a colour (${LINK}) \u00B7 Throwaway: Red (in the browser)`);
		expect(editPlain.params.message_id).toBe(plain.result.message_id);
		expect(editPlain.params.reply_markup).toEqual({ inline_keyboard: [] });
	});

	it("any other refusal isn't sent again as plain text", async () => {
		const { tg, asks, settle } = setup();
		tg.failNext("sendMessage", errResponse(400, "Bad Request: message is too long"));
		asks.add(question());
		await settle();
		expect(tg.of("sendMessage")).toHaveLength(1);
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
		// Chatting off: the bot as it was before telegram-coo (the chat's own test is below).
		const host = hostWith({ botToken: TOKEN, ownerId: OWNER, routeTo: "" }, statuses);
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

	it("by default messages go to the COO with a brief at 06:30; an empty setting turns chatting off", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init: Any) =>
					new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
			),
		);
		// Outside the brief's hours, so nothing is asked.
		process.env[NOW_ENV] = "2026-10-06T03:00:00-07:00";
		try {
			const statuses: string[] = [];
			const host = hostWith({ botToken: TOKEN, ownerId: OWNER }, statuses);
			const off = telegramPlugin.activate(host);
			expect(statuses.at(-1)).toContain(" \u00B7 messages go to coo \u00B7 brief at 06:30");
			expect(host.mock.handlers["roles.onReply"]).toHaveLength(1);
			off?.();
			expect(host.mock.handlers["roles.onReply"]).toHaveLength(0);

			const quiet: string[] = [];
			const host2 = hostWith({ botToken: TOKEN, ownerId: OWNER, routeTo: "" }, quiet);
			const off2 = telegramPlugin.activate(host2);
			expect(quiet.at(-1)).not.toContain("messages go to");
			expect(host2.mock.handlers["roles.onReply"] ?? []).toHaveLength(0);
			off2?.();

			const odd: string[] = [];
			const host3 = hostWith({ botToken: TOKEN, ownerId: OWNER, briefAt: "half six" }, odd);
			const off3 = telegramPlugin.activate(host3);
			expect(odd.at(-1)).toContain("messages go to coo \u00B7 no brief: its time isn't HH:MM");
			off3?.();
		} finally {
			delete process.env[NOW_ENV];
		}
	});
});

// ---------------------------------------------------------------------------
// telegram-coo: chatting with a role, and its morning brief
// ---------------------------------------------------------------------------

const COO_FILE = "/home/x/.pi/agent/sessions/coo.jsonl";
const COO_LINK = (chatLink(ADDRESS, COO_FILE) as string).replace(/&/g, "&amp;");
const OPEN_COO = ` <a href="${COO_LINK}">Open the chat</a>`;

/** A fake host.roles.send: records each send; "busy" holds it (after onQueued) until release(). */
function fakeRoles() {
	const sent: Any[] = [];
	const held: (() => void)[] = [];
	let next = 1;
	const state = {
		mode: "ok" as "ok" | "busy" | "error" | "throw",
		error: "no home chat for coo",
		beforeAck: undefined as ((id: string) => void) | undefined,
	};
	return {
		sent,
		state,
		send: async (role: string, text: string, opts: Any) => {
			const id = `s${next++}`;
			sent.push({ role, text, via: opts?.via, id });
			if (state.mode === "throw") throw new Error(state.error);
			if (state.mode === "error") return { ok: false, error: state.error };
			if (state.mode === "busy") {
				opts?.onQueued?.();
				await new Promise<void>((r) => held.push(r));
			}
			state.beforeAck?.(id);
			return { ok: true, id };
		},
		release: () => {
			for (const r of held.splice(0)) r();
		},
	};
}

type Timer = { fn: () => void; ms: number; live: boolean };

function chatSetup({
	routeTo = "coo",
	briefAt = "06:30",
	at = "2026-10-06T08:00:00-07:00",
	storageInit = {} as Record<string, unknown>,
} = {}) {
	const tg = fakeTelegram();
	const asks = fakeAsks();
	const roles = fakeRoles();
	const storage = memStorage(storageInit);
	const logs: string[] = [];
	const log = (_level: string, m: string) => {
		logs.push(m);
	};
	const clock = { t: Date.parse(at) };
	const timers: Timer[] = [];
	const chat = createChat({
		api: tg.api,
		roles,
		storage,
		ownerId: OWNER,
		routeTo,
		briefAt,
		webAppAddress: ADDRESS,
		log,
		now: () => clock.t,
		sleep: async () => {},
		setTimer: ((fn: () => void, ms: number) => {
			const t = { fn, ms, live: true };
			timers.push(t);
			return t;
		}) as Any,
		clearTimer: (t: Timer) => {
			t.live = false;
		},
	});
	const bridge = createBridge({
		api: tg.api,
		asks,
		storage,
		ownerId: OWNER,
		webAppAddress: ADDRESS,
		sleep: async () => {},
		log,
		chat: chat as Any,
	});
	asks.on((ev) => bridge.onAskEvent(ev));
	const settle = async () => {
		for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
		await bridge.idle();
		await chat.idle();
	};
	const send = async (update: Any) => {
		await bridge.handleUpdate(update);
		await settle();
		return update.message?.message_id as number;
	};
	const reply = async (r: Record<string, unknown>) => {
		chat.onReply({ role: "coo", file: COO_FILE, at: clock.t, text: "", cause: "telegram", ids: [], ...r });
		await settle();
	};
	const tick = async (advanceMs = 0) => {
		clock.t += advanceMs;
		chat.tick();
		await settle();
	};
	const sends = () => tg.of("sendMessage");
	const typingOn = () => timers.filter((t) => t.live && t.ms === 4500).length;
	return { tg, asks, roles, storage, logs, clock, timers, chat, bridge, settle, send, reply, tick, sends, typingOn };
}

/** A reply to a given message (Telegram puts the whole message in reply_to_message). */
const sayTo = (text: string, to: Any) => {
	const u = say(text) as Any;
	u.message.reply_to_message = to;
	return u;
};
/** A photo with no caption. */
const photo = () => {
	const u = say("") as Any;
	delete u.message.text;
	u.message.photo = [{ file_id: "f1", width: 90, height: 90 }];
	return u;
};

describe("telegram plugin: chatting with the COO", () => {
	it("a plain message goes to the COO as the owner's, with \u{1F4F1}; its answer comes back under it", async () => {
		const c = chatSetup();
		const mid = await c.send(say("How is temper doing?"));
		expect(c.roles.sent).toEqual([{ role: "coo", text: "\u{1F4F1} How is temper doing?", via: "telegram", id: "s1" }]);
		expect(c.sends()).toHaveLength(0);
		expect(c.tg.of("sendChatAction").at(-1)?.params).toEqual({ chat_id: OWNER, action: "typing" });
		expect(c.typingOn()).toBe(1);
		expect(c.chat.store.pending).toEqual({ s1: { to: mid, at: c.clock.t } });

		await c.reply({ text: "All **good**: 3 runs passed.", ids: ["s1"] });
		const out = c.tg.last("sendMessage") as Call;
		expect(out.params.text).toBe("All <b>good</b>: 3 runs passed.");
		expect(out.params.parse_mode).toBe("HTML");
		expect(out.params.reply_parameters).toEqual({ message_id: mid, allow_sending_without_reply: true });
		expect(c.typingOn()).toBe(0);
		expect(c.chat.store.pending).toEqual({});
		expect(c.chat.owns(out.result.message_id)).toBe(true);
		expect((c.storage.get("chat") as Any).ids).toContain(out.result.message_id);
	});

	it("a turn that finishes before the send receipt is still threaded under the owner's message", async () => {
		const c = chatSetup();
		c.roles.state.beforeAck = (id) =>
			c.chat.onReply({
				role: "coo",
				file: COO_FILE,
				at: c.clock.t,
				text: "Fast answer.",
				cause: "telegram",
				ids: [id],
			});
		const mid = await c.send(say("Quick one"));
		expect(c.sends()).toHaveLength(1);
		expect(c.tg.last("sendMessage")?.params.reply_parameters.message_id).toBe(mid);
		expect(c.chat.store.pending).toEqual({});
		expect(c.typingOn()).toBe(0);
	});

	it("/start stays a bot command even when replying to the COO", async () => {
		const c = chatSetup({ storageInit: { chat: { ids: [77] } } });
		await c.send(sayTo("/start", { message_id: 77, from: { id: 1, is_bot: true } }));
		expect(c.roles.sent).toHaveLength(0);
		expect(c.tg.last("sendMessage")?.params.text).toContain("Hi! Write here to talk to the COO");
	});

	it("a reply to the COO's message or to his own goes to it; a reply to an old bot message doesn't", async () => {
		const c = chatSetup();
		await c.send(say("First"));
		await c.reply({ text: "Answer one", ids: ["s1"] });
		const ours = c.tg.last("sendMessage") as Call;
		await c.send(
			sayTo("And rollcall?", { message_id: ours.result.message_id, from: { id: 1, is_bot: true }, text: "Answer one" }),
		);
		expect(c.roles.sent.at(-1).text).toBe("\u{1F4F1} And rollcall?");
		await c.send(sayTo("Again", { message_id: 4100, from: { id: Number(OWNER), is_bot: false }, text: "First" }));
		expect(c.roles.sent.at(-1).text).toBe("\u{1F4F1} Again");
		const before = c.roles.sent.length;
		await c.send(sayTo("Hm", { message_id: 4200, from: { id: 1, is_bot: true }, text: "Pick a colour" }));
		expect(c.roles.sent).toHaveLength(before);
		expect(c.tg.last("sendMessage")?.params.text).toBe("That question is no longer waiting.");
	});

	it("/start, 'Type an answer' and a reply to a question still answer as before", async () => {
		const c = chatSetup();
		await c.send(say("/start"));
		const hi = c.tg.last("sendMessage")?.params.text as string;
		expect(hi).toContain(
			"Hi! Write here to talk to the COO: your message goes to its chat, and its answer comes back here.",
		);
		expect(hi).toContain("Every morning at 06:30 (Pacific time) it sends you a short brief.");
		expect(hi).toContain("pi also sends you its questions and permission prompts here.");

		const ask = c.asks.add(question());
		await c.settle();
		const msg = c.tg.last("sendMessage") as Call;
		await c.send(tap(dataOf(msg, "Type an answer"), msg.result.message_id));
		await c.send(say("Green"));
		expect(c.asks.answered).toEqual([{ id: ask.id, answers: [{ id: "colour", selected: [], text: "Green" }] }]);

		const ask2 = c.asks.add(question());
		await c.settle();
		const msg2 = c.tg.last("sendMessage") as Call;
		await c.send(say("Blue", msg2.result.message_id));
		expect(c.asks.answered.at(-1).id).toBe(ask2.id);
		expect(c.roles.sent).toHaveLength(0);

		await c.send(say("Now a real message"));
		expect(c.roles.sent.map((s) => s.text)).toEqual(["\u{1F4F1} Now a real message"]);
	});

	it("a photo, voice note or file gets 'Only text messages for now.'", async () => {
		const c = chatSetup();
		const mid = await c.send(photo());
		expect(c.roles.sent).toHaveLength(0);
		const out = c.tg.last("sendMessage") as Call;
		expect(out.params.text).toBe(ONLY_TEXT);
		expect(out.params.reply_parameters.message_id).toBe(mid);
	});

	it("a busy COO: the bot says so once, and the message goes in after its turn", async () => {
		const c = chatSetup();
		c.roles.state.mode = "busy";
		const mid = await c.send(say("Are you there?"));
		const note = c.tg.last("sendMessage") as Call;
		expect(note.params.text).toBe("The COO is busy right now: your message goes in right after its current turn.");
		expect(note.params.reply_parameters.message_id).toBe(mid);
		expect(Object.keys(c.chat.store.waiting)).toEqual([String(mid)]);
		expect(c.typingOn()).toBe(1);

		c.roles.release();
		await c.settle();
		expect(c.chat.store.waiting).toEqual({});
		expect(c.chat.store.pending.s1.to).toBe(mid);
		expect(c.sends()).toHaveLength(1);
		await c.reply({ text: "Yes.", ids: ["s1"] });
		expect(c.tg.last("sendMessage")?.params.reply_parameters.message_id).toBe(mid);
	});

	it("a message that can't reach the COO says why", async () => {
		for (const mode of ["error", "throw"] as const) {
			const c = chatSetup();
			c.roles.state.mode = mode;
			const mid = await c.send(say("Hello?"));
			const out = c.tg.last("sendMessage") as Call;
			expect(out.params.text).toBe("Couldn't send it to the COO: no home chat for coo.");
			expect(out.params.reply_parameters.message_id).toBe(mid);
			expect(c.typingOn()).toBe(0);
			expect(c.chat.store.waiting).toEqual({});
		}
	});

	it("a long answer comes in at most 3 messages, the last pointing to the chat", async () => {
		const c = chatSetup();
		const mid = await c.send(say("Tell me everything"));
		const para = (i: number) => `Part ${i}: ${"word ".repeat(TEXT_BUDGET / 9)}`.trim();
		await c.reply({ text: Array.from({ length: 8 }, (_, i) => para(i)).join("\n\n"), ids: ["s1"] });
		const out = c.sends();
		expect(out).toHaveLength(3);
		expect(out[0].params.reply_parameters.message_id).toBe(mid);
		expect(out[1].params.reply_parameters).toBeUndefined();
		expect(out[0].params.text.startsWith("Part 0:")).toBe(true);
		expect(out[2].params.text.endsWith(`\n\n<i>The rest is in the chat: <a href="${COO_LINK}">open it</a></i>`)).toBe(
			true,
		);
		for (const m of out) expect(visibleLength(m.params.text)).toBeLessThanOrEqual(4096);
		for (const m of out) expect(c.chat.owns(m.result.message_id)).toBe(true);
	});

	it("a reply cut by the server still points to the rest even if the formatted text fits", async () => {
		const c = chatSetup();
		await c.send(say("Show me"));
		await c.reply({ text: "Short after formatting", cut: true, ids: ["s1"] });
		expect(c.tg.last("sendMessage")?.params.text).toContain("The rest is in the chat");
	});

	it("a failed turn sends one line saying why; an empty one says so", async () => {
		const c = chatSetup();
		const mid = await c.send(say("Do it"));
		await c.reply({ error: "model overloaded", ids: ["s1"] });
		const out = c.tg.last("sendMessage") as Call;
		expect(out.params.text).toBe(`The COO couldn't finish: model overloaded.${OPEN_COO}`);
		expect(out.params.reply_parameters.message_id).toBe(mid);
		expect(c.typingOn()).toBe(0);

		await c.send(say("Again"));
		await c.reply({ text: "  ", ids: ["s2"] });
		expect(c.tg.last("sendMessage")?.params.text).toBe(`The COO finished without writing an answer.${OPEN_COO}`);
	});

	it("only turns from Telegram or the brief come back; browser, app and other roles' turns stay in the chat", async () => {
		const c = chatSetup();
		await c.reply({ text: "typed in the browser", cause: "browser" });
		await c.reply({ text: "the app's own", cause: "other" });
		await c.reply({ text: "another plugin's", cause: "plugin", ids: ["x9"] });
		await c.reply({ text: "someone else's", role: "rollcall", cause: "telegram" });
		await c.reply({ text: "After asking temper: all good.", cause: "role" });
		expect(c.sends()).toHaveLength(0);
		expect(c.logs).toContain("telegram: coo answered another role's message (not sent, 30 characters)");
	});

	it("never logs what he or the COO wrote", async () => {
		const c = chatSetup();
		c.roles.state.mode = "busy";
		await c.send(say("secret-question-text"));
		c.roles.release();
		await c.settle();
		await c.reply({ text: "secret-answer-text", ids: ["s1"] });
		await c.send(say("/start"));
		expect(c.logs.length).toBeGreaterThan(2);
		const all = c.logs.join("\n");
		expect(all).not.toContain("secret");
		expect(all).toContain("telegram: coo answered (telegram, 18 characters)");
	});

	it("with chatting off (empty setting) the bot only answers questions, as before", async () => {
		const c = chatSetup({ routeTo: "" });
		expect(c.chat.on).toBe(false);
		await c.send(say("Hello"));
		expect(c.roles.sent).toHaveLength(0);
		expect(c.tg.last("sendMessage")?.params.text).toBe(
			"To answer a question, tap one of its buttons, or reply to its message to type an answer.",
		);
		await c.send(say("/start"));
		expect(c.tg.last("sendMessage")?.params.text).toBe(
			"Hi! pi sends you its questions and permission prompts here. Tap a button to answer, or reply to a question's message to type an answer.",
		);
		c.chat.start({ restarted: true });
		expect(c.timers).toHaveLength(0);
	});

	it("after a restart, messages left on their way get a note under them", async () => {
		const t = Date.parse("2026-10-06T08:00:00-07:00");
		const c = chatSetup({
			storageInit: {
				chat: { ids: [5], waiting: { "77": t - 1000 }, pending: { s9: { to: 78, at: t - 1000 } }, file: COO_FILE },
			},
		});
		c.chat.start({ restarted: true });
		await c.settle();
		const out = c.sends().map((m) => [m.params.reply_parameters?.message_id, m.params.text]);
		expect(out).toEqual([
			[77, "pi restarted before your message reached the COO: please send it again."],
			[78, `pi restarted while the COO was on your message: its answer will be in the chat, not here.${OPEN_COO}`],
		]);
		expect(c.storage.get("chat")).toMatchObject({ waiting: {}, pending: {} });
		expect(c.chat.owns(5)).toBe(true);
	});
});

describe("telegram plugin: turns another role's message started (owner 2026-10-06: none reach him)", () => {
	const DAY = "2026-10-06";

	it("a role-started turn sends nothing, not even a failure line; his own exchange and the brief still do", async () => {
		const c = chatSetup({ at: `${DAY}T06:29:00-07:00` });
		c.chat.start();
		await c.settle();

		// Another role's message started these turns in the COO's chat: an answer, a failed turn, an empty one.
		await c.reply({ text: "Temper answered: the runs are fine. Nothing for the owner.", cause: "role" });
		await c.reply({ error: "model overloaded", cause: "role" });
		await c.reply({ text: "  ", cause: "role" });
		expect(c.sends()).toHaveLength(0);

		// His own message: while it waits for its answer, a role-started turn ends; it neither goes out nor
		// takes his message's place, and his answer still comes back under his message.
		const mid = await c.send(say("How is temper doing?"));
		await c.reply({ text: "An fyi from ops, noted.", cause: "role" });
		expect(c.sends()).toHaveLength(0);
		expect(c.chat.store.pending).toEqual({ s1: { to: mid, at: c.clock.t } });
		expect(c.typingOn()).toBe(1);
		await c.reply({ text: "Temper is fine: 3 runs passed.", ids: ["s1"] });
		expect(c.sends().map((m) => [m.params.reply_parameters?.message_id, m.params.text])).toEqual([
			[mid, "Temper is fine: 3 runs passed."],
		]);
		expect(c.sends()[0].params.disable_notification).toBeUndefined();

		// The morning brief.
		await c.tick(60_000);
		expect(c.roles.sent.at(-1)).toEqual({ role: "coo", text: briefRequest(DAY), via: "plugin", id: "s2" });
		await c.reply({ text: "After a request from temper: done.", cause: "role" });
		await c.reply({ text: `Morning brief, ${DAY}\n\nAll quiet.`, cause: "plugin", ids: ["s2"] });
		expect(c.sends().map((m) => m.params.text)).toEqual([
			"Temper is fine: 3 runs passed.",
			`Morning brief, ${DAY}\n\nAll quiet.`,
		]);
		expect((c.storage.get("brief") as Any).state).toBe("done");
	});
});

describe('telegram plugin: answers to his own questions (owner 2026-10-06: "Yes, answers to my questions")', () => {
	const LEAD = "<i>The COO, after the temper role answered:</i>\n\n";

	it("a role turn that answers a question asked for him comes back in full, under his message, with a notification", async () => {
		const c = chatSetup();
		const mid = await c.send(say("What does temper think?"));
		await c.reply({ text: "I asked temper, back soon.", ids: ["s1"] });
		// His message is still known after its own answer came back.
		expect(c.chat.store.pending).toEqual({});
		expect(c.chat.store.asked).toEqual({ s1: { to: mid, at: c.clock.t } });
		expect((c.storage.get("chat") as Any).asked).toEqual({ s1: { to: mid, at: c.clock.t } });
		const text = "Temper says **all good**.";
		await c.reply({ text, cause: "role", forOwner: true, answeredBy: ["temper"], ownerIds: ["s1"] });
		expect(c.sends().map((m) => [m.params.reply_parameters?.message_id, m.params.text])).toEqual([
			[mid, "I asked temper, back soon."],
			[mid, `${LEAD}Temper says <b>all good</b>.`],
		]);
		expect(c.sends()[1].params.parse_mode).toBe("HTML");
		expect(c.sends()[1].params.disable_notification).toBeUndefined();
		expect(c.logs).toContain(`telegram: coo answered (for the owner, after temper, ${text.length} characters)`);
		expect(c.logs.join("\n")).not.toContain("all good");
	});

	it("names every role that answered; unthreaded when his message isn't known; a failed or empty turn says so", async () => {
		const c = chatSetup();
		await c.reply({
			text: "Both agree.",
			cause: "role",
			forOwner: true,
			answeredBy: ["temper", "qa"],
			ownerIds: ["gone"],
		});
		await c.reply({ error: "model overloaded", cause: "role", forOwner: true, answeredBy: ["temper"], ownerIds: [] });
		await c.reply({ text: " ", cause: "role", forOwner: true, answeredBy: [] });
		const out = c.sends().map((m) => [m.params.reply_parameters?.message_id, m.params.text]);
		expect(out[0]).toEqual([undefined, "<i>The COO, after the temper role and the QA answered:</i>\n\nBoth agree."]);
		expect(out[1][0]).toBeUndefined();
		expect(out[1][1]).toMatch(/^The COO couldn't finish after the temper role answered: model overloaded\./);
		expect(out[2][1]).toMatch(/^The COO finished without writing an answer after another role answered\./);
		expect(out).toHaveLength(3);
	});

	it("forOwner counts only on a role turn, and only when true", async () => {
		const c = chatSetup();
		await c.reply({ text: "from the browser", cause: "browser", forOwner: true, answeredBy: ["temper"] });
		await c.reply({ text: "the app's own", cause: "other", forOwner: true });
		await c.reply({ text: "not his", cause: "role", forOwner: false, answeredBy: ["temper"] });
		await c.reply({ text: "not his either", cause: "role", forOwner: "yes" });
		await c.reply({ text: "someone else's", role: "rollcall", cause: "role", forOwner: true });
		expect(c.sends()).toHaveLength(0);
	});

	it("his messages are kept a week across restarts, then forgotten", async () => {
		const t = Date.parse("2026-10-06T08:00:00-07:00");
		const c = chatSetup({
			at: "2026-10-06T08:00:00-07:00",
			storageInit: {
				chat: {
					ids: [],
					waiting: {},
					pending: {},
					asked: { s5: { to: 55, at: t - 6 * 86_400_000 }, s6: { to: 66, at: t - 8 * 86_400_000 } },
					file: COO_FILE,
				},
			},
		});
		c.chat.start({ restarted: true });
		await c.settle();
		await c.reply({ text: "Old one.", cause: "role", forOwner: true, answeredBy: ["temper"], ownerIds: ["s6"] });
		await c.reply({ text: "Recent one.", cause: "role", forOwner: true, answeredBy: ["temper"], ownerIds: ["s5"] });
		expect(c.sends().map((m) => [m.params.reply_parameters?.message_id, m.params.text])).toEqual([
			[undefined, `${LEAD}Old one.`],
			[55, `${LEAD}Recent one.`],
		]);
		expect(Object.keys((c.storage.get("chat") as Any).asked)).toEqual(["s5"]);
	});
});

describe("telegram plugin: the morning brief", () => {
	const DAY = "2026-10-06";

	it("asks the COO at 06:30 Pacific, once, and sends its answer", async () => {
		const c = chatSetup({ at: `${DAY}T06:29:00-07:00` });
		c.chat.start();
		await c.settle();
		expect(c.timers.filter((t) => t.ms === 10_000)).toHaveLength(1);
		expect(c.roles.sent).toHaveLength(0);
		await c.tick(60_000);
		expect(c.roles.sent).toEqual([{ role: "coo", text: briefRequest(DAY), via: "plugin", id: "s1" }]);
		await c.tick(10_000);
		expect(c.roles.sent).toHaveLength(1);
		expect(c.storage.get("brief")).toMatchObject({ date: DAY, ids: ["s1"], state: "asked" });

		await c.reply({ text: `Morning brief, ${DAY}\n\nAll quiet.`, cause: "plugin", ids: ["s1"] });
		const out = c.tg.last("sendMessage") as Call;
		expect(out.params.text).toBe(`Morning brief, ${DAY}\n\nAll quiet.`);
		expect(out.params.reply_parameters).toBeUndefined();
		expect((c.storage.get("brief") as Any).state).toBe("done");
		await c.tick(BRIEF_WAIT_MS);
		expect(c.sends()).toHaveLength(1);

		// The next day, again.
		c.clock.t = Date.parse("2026-10-07T06:30:05-07:00");
		await c.tick();
		expect(c.roles.sent.at(-1).text).toBe(briefRequest("2026-10-07"));
	});

	it("a very fast brief is correlated before the send receipt comes back", async () => {
		const c = chatSetup({ at: `${DAY}T06:30:00-07:00` });
		c.roles.state.beforeAck = (id) =>
			c.chat.onReply({
				role: "coo",
				file: COO_FILE,
				at: c.clock.t,
				text: "Morning brief: all quiet.",
				cause: "plugin",
				ids: [id],
			});
		c.chat.start();
		await c.settle();
		expect(c.tg.last("sendMessage")?.params.text).toBe("Morning brief: all quiet.");
		expect(c.storage.get("brief")).toMatchObject({ state: "done", alerted: true });
	});

	it("an empty brief gets the no-brief line once, not a success record", async () => {
		const c = chatSetup({ at: `${DAY}T06:30:00-07:00` });
		c.chat.start();
		await c.settle();
		await c.reply({ text: "  ", cause: "plugin", ids: ["s1"] });
		expect(c.sends().map((m) => m.params.text)).toEqual([
			"No morning brief today: the COO finished without writing a brief.",
		]);
		expect(c.storage.get("brief")).toMatchObject({ state: "failed", alerted: true });
		await c.tick(BRIEF_WAIT_MS);
		expect(c.sends()).toHaveLength(1);
	});

	it("the request asks for the direction, what needs him, a line per busy role, the quiet ones, ~300 words", () => {
		const r = briefRequest(DAY);
		expect(r).toContain("roles_overview");
		expect(r).toContain("The overall direction, in one or two sentences.");
		expect(r).toContain("Anything that needs the owner, first.");
		expect(r).toContain("One line for each role that did something");
		expect(r).toContain("The quiet roles together, in one line.");
		expect(r).toContain("under about 300 words");
	});

	it("if pi was down at 06:30 it asks at start-up, until noon; never twice a day", async () => {
		const late = chatSetup({ at: `${DAY}T09:15:00-07:00` });
		late.chat.start({ restarted: true });
		await late.settle();
		expect(late.roles.sent.map((s) => s.via)).toEqual(["plugin"]);

		const noon = chatSetup({ at: `${DAY}T12:00:00-07:00` });
		noon.chat.start({ restarted: true });
		await noon.settle();
		expect(noon.roles.sent).toHaveLength(0);

		const early = chatSetup({ at: `${DAY}T06:00:00-07:00` });
		early.chat.start({ restarted: true });
		await early.settle();
		expect(early.roles.sent).toHaveLength(0);

		const done = chatSetup({ at: `${DAY}T09:15:00-07:00`, storageInit: { brief: { date: DAY, state: "done" } } });
		done.chat.start({ restarted: true });
		await done.settle();
		expect(done.roles.sent).toHaveLength(0);
	});

	it("no answer 45 minutes after asking: one 'No morning brief today' line; a late brief still comes", async () => {
		const c = chatSetup({ at: `${DAY}T06:30:00-07:00` });
		c.chat.start();
		await c.settle();
		await c.tick(BRIEF_WAIT_MS - 1000);
		expect(c.sends()).toHaveLength(0);
		await c.tick(1000);
		expect(c.sends().map((m) => m.params.text)).toEqual([
			"No morning brief today: the COO hasn't answered in 45 minutes.",
		]);
		await c.tick(60_000);
		expect(c.sends()).toHaveLength(1);
		await c.reply({ text: "Morning brief, late", cause: "plugin", ids: ["s1"] });
		expect(c.tg.last("sendMessage")?.params.text).toBe("Morning brief, late");
	});

	it("says why when the COO's chat stays busy, the request can't go, or its turn fails", async () => {
		const busy = chatSetup({ at: `${DAY}T06:30:00-07:00` });
		busy.roles.state.mode = "busy";
		busy.chat.start();
		await busy.settle();
		await busy.tick(BRIEF_WAIT_MS);
		expect(busy.sends().map((m) => m.params.text)).toEqual([
			"No morning brief today: the COO's chat stayed busy for 45 minutes.",
		]);

		const cant = chatSetup({ at: `${DAY}T06:30:00-07:00` });
		cant.roles.state.mode = "error";
		cant.chat.start();
		await cant.settle();
		expect(cant.sends().map((m) => m.params.text)).toEqual(["No morning brief today: no home chat for coo."]);
		await cant.tick(BRIEF_WAIT_MS);
		expect(cant.sends()).toHaveLength(1);

		const failed = chatSetup({ at: `${DAY}T06:30:00-07:00` });
		failed.chat.start();
		await failed.settle();
		await failed.reply({ error: "model overloaded", cause: "plugin", ids: ["s1"] });
		expect(failed.sends().map((m) => m.params.text)).toEqual([
			"No morning brief today: the COO's turn failed (model overloaded).",
		]);
		await failed.tick(BRIEF_WAIT_MS);
		expect(failed.sends()).toHaveLength(1);
	});

	it("an empty or odd brief time turns the brief off", async () => {
		for (const briefAt of ["", "half six", "25:00"]) {
			const c = chatSetup({ briefAt, at: `${DAY}T06:30:00-07:00` });
			expect(c.chat.briefAt).toBe("");
			c.chat.start();
			await c.settle();
			expect(c.timers).toHaveLength(0);
			expect(c.roles.sent).toHaveLength(0);
		}
	});
});

describe("telegram plugin: chat helpers", () => {
	it("reads HH:MM, the Pacific date and time, a forced clock and the role's name", () => {
		expect(parseClock("06:30")).toBe(390);
		expect(parseClock("6:30")).toBe(390);
		expect(parseClock("")).toBeNull();
		expect(parseClock("24:00")).toBeNaN();
		expect(zoneClock(Date.parse("2026-10-06T13:30:00Z"))).toEqual({ date: "2026-10-06", minutes: 390 });
		expect(zoneClock(Date.parse("2026-12-01T14:30:00Z"))).toEqual({ date: "2026-12-01", minutes: 390 });
		expect(zoneClock(Date.parse("2026-10-07T03:00:00Z"))).toEqual({ date: "2026-10-06", minutes: 20 * 60 });
		let real = 1000;
		const now = clockFrom("2026-10-06T06:30:00-07:00", () => real);
		expect(now()).toBe(Date.parse("2026-10-06T13:30:00Z"));
		real += 5000;
		expect(now()).toBe(Date.parse("2026-10-06T13:30:05Z"));
		const realNow = () => 42;
		expect(clockFrom("", realNow)).toBe(realNow);
		expect(clockFrom("not a date", realNow)).toBe(realNow);
		expect(roleName("coo")).toBe("the COO");
		expect(roleName("rollcall")).toBe("the rollcall role");
	});

	it("splits an answer between blocks, keeps a code block's fences in each piece, and caps the parts", () => {
		expect(splitReply("Short **one**.")).toEqual({ parts: ["Short <b>one</b>."], more: false });
		const code = [
			"```js",
			...Array.from({ length: 400 }, (_, i) => `const line${i} = ${i}; // filler text`),
			"```",
		].join("\n");
		const { parts, more } = splitReply(code, { maxParts: 10 });
		expect(parts.length).toBeGreaterThan(1);
		expect(more).toBe(false);
		// Each piece is code on its own (a long one shows as a collapsed quote), and no line is lost.
		const open = /^<(pre|blockquote expandable)>/.exec(parts[0])?.[0] as string;
		expect(open).toBeTruthy();
		const close = open.startsWith("<pre") ? "</pre>" : "</blockquote>";
		for (const p of parts) {
			expect(p.startsWith(open)).toBe(true);
			expect(p.endsWith(close)).toBe(true);
			expect(visibleLength(p)).toBeLessThanOrEqual(TEXT_BUDGET);
		}
		const all = parts.join("\n");
		for (const i of [0, 113, 114, 399]) expect(all).toContain(`const line${i} = ${i};`);
		expect(all).not.toContain("```");
		const oneLong = splitReply("x".repeat(TEXT_BUDGET * 2 + 10), { maxParts: 5 });
		expect(oneLong.parts).toHaveLength(3);
		const capped = splitReply("x".repeat(TEXT_BUDGET * 5), { maxParts: 3 });
		expect(capped.parts).toHaveLength(3);
		expect(capped.more).toBe(true);
	});
});
