/**
 * Telegram answers (telegram-answers patch).
 *
 * Sends you, on Telegram, everything a chat is waiting on you for: questions with their choices,
 * add-on pop-ups, permission prompts, and queued tasks that need you. Tap a button (or reply to
 * the message to type an answer) and the chat gets the answer exactly as if you had answered in
 * the browser. Whichever place answers first wins; the other one updates.
 *
 * - Reads its own bot's messages by long polling: outgoing connections only, no webhook.
 * - Only the owner's private chat counts (setting "ownerId"); everyone else is ignored.
 * - The bot token lives only in this plugin's encrypted settings; errors never show it.
 *
 * The host uses the default export; the tests use the named exports.
 */

export const PLUGIN_ID = "telegram";
export const API_BASE_DEFAULT = "https://api.telegram.org";
/** Tests (and only tests) point the plugin at a fake Telegram with this. */
export const API_BASE_ENV = "PI_WEB_TELEGRAM_API_BASE";

// Short enough that a connection that died quietly is noticed within half a minute.
const POLL_TIMEOUT_S = 25;
const POLL_FETCH_TIMEOUT_MS = 35_000;
const CALL_TIMEOUT_MS = 10_000;
/** Telegram allows 4096 characters; stay a little under. */
export const TEXT_BUDGET = 3900;
const LABEL_MAX = 60;
const MAX_OPTIONS = 90;
const RESYNC_MS = 60_000;
/** A call Telegram fumbled (a 5xx, a dropped connection, no answer in time) is tried again after these. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

const KIND_ICON = {
	question: "\u2753",
	dialog: "\u{1F4AC}",
	approval: "\u{1F510}",
	stuck: "\u{1F4CC}",
};

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s) {
	return String(s ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Cut to at most `max` characters, ending with "…" when something was cut. */
export function cut(s, max) {
	const t = String(s ?? "");
	return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

/** How long Telegram counts our own HTML (tags don't count, entities count as one). */
export function visibleLength(html) {
	return String(html ?? "")
		.replace(/<[^>]*>/g, "")
		.replace(/&(amp|lt|gt|quot);/g, "_").length;
}

function shortPath(p) {
	const home = process.env.HOME;
	const s = String(p ?? "");
	return home && (s === home || s.startsWith(`${home}/`)) ? `~${s.slice(home.length)}` : s;
}

/** The web app link that opens one chat (`?chat=<saved chat file>`), or null. */
export function chatLink(webAppAddress, sessionFile) {
	if (!webAppAddress || !sessionFile) return null;
	try {
		const url = new URL(String(webAppAddress));
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		url.searchParams.set("chat", String(sessionFile));
		return url.toString();
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Telegram Bot API client
// ---------------------------------------------------------------------------

export class TelegramError extends Error {
	constructor(method, code, description, retryAfter = 0) {
		super(`Telegram ${method} failed${code ? ` (${code})` : ""}: ${description}`);
		this.name = "TelegramError";
		this.method = method;
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/** call(method, params, {signal, timeoutMs}) -> result. Errors never contain the token. */
export function createTelegramApi({ base = API_BASE_DEFAULT, token, fetchImpl = globalThis.fetch }) {
	const secret = String(token ?? "");
	const root = `${String(base).replace(/\/+$/, "")}/bot${secret}/`;
	const scrub = (s) =>
		secret
			? String(s ?? "")
					.split(secret)
					.join("<token>")
			: String(s ?? "");
	async function call(method, params = {}, { signal, timeoutMs = CALL_TIMEOUT_MS } = {}) {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		const onAbort = () => ctl.abort();
		if (signal) {
			if (signal.aborted) ctl.abort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		try {
			let res;
			try {
				res = await fetchImpl(root + method, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(params),
					signal: ctl.signal,
				});
			} catch (err) {
				const why = ctl.signal.aborted && !signal?.aborted ? "timed out" : (err?.message ?? err);
				throw new TelegramError(method, 0, scrub(why));
			}
			let data = null;
			try {
				data = await res.json();
			} catch {
				data = null;
			}
			if (!data || data.ok !== true) {
				const code = Number(data?.error_code ?? res.status) || 0;
				throw new TelegramError(
					method,
					code,
					scrub(data?.description ?? `HTTP ${res.status}`),
					Number(data?.parameters?.retry_after) || 0,
				);
			}
			return data.result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
		}
	}
	return { call };
}

// ---------------------------------------------------------------------------
// Which part of a question to show (mirrors the browser's question dialog)
// ---------------------------------------------------------------------------

function answerValues(a) {
	if (!a) return [];
	return [...(Array.isArray(a.selected) ? a.selected : []), ...(a.text ? [a.text] : [])].map(String);
}

/** A field shows when it depends on nothing, or on an earlier answer that matches. */
export function visibleField(ask, index, answers) {
	const f = ask?.fields?.[index];
	if (!f) return false;
	const dep = f.dependsOn;
	if (!dep || !dep.questionId) return true;
	const picked = answerValues(answers?.[dep.questionId]);
	if (!picked.length) return false;
	if (dep.value === undefined || dep.value === null) return true;
	const want = (Array.isArray(dep.value) ? dep.value : [dep.value]).map(String);
	return picked.some((v) => want.includes(v));
}

/** The choices of a field (they can depend on an earlier answer). */
export function fieldOptions(ask, index, answers) {
	const f = ask?.fields?.[index];
	if (!f) return [];
	if (f.optionsMap && f.dependsOn?.questionId) {
		for (const v of answerValues(answers?.[f.dependsOn.questionId])) {
			const list = f.optionsMap[v];
			if (Array.isArray(list) && list.length) return list.slice(0, MAX_OPTIONS);
		}
	}
	return (Array.isArray(f.options) ? f.options : []).slice(0, MAX_OPTIONS);
}

/** The first field that shows and has no answer yet, or -1 when all are answered. */
export function nextStep(ask, answers) {
	const fields = ask?.fields ?? [];
	for (let i = 0; i < fields.length; i++) {
		if (visibleField(ask, i, answers) && !answers?.[fields[i].id]) return i;
	}
	return -1;
}

/** The answers to send, in field order (only fields that show). */
export function collectAnswers(ask, answers) {
	const out = [];
	(ask?.fields ?? []).forEach((f, i) => {
		const a = answers?.[f.id];
		if (!a || !visibleField(ask, i, answers)) return;
		out.push({ id: f.id, selected: [...(a.selected ?? [])], ...(a.text ? { text: a.text } : {}) });
	});
	return out;
}

function describeAnswer(ask, index, answers) {
	const f = ask.fields[index];
	const a = answers?.[f.id];
	if (!a) return "";
	const opts = fieldOptions(ask, index, answers);
	const labels = (a.selected ?? []).map((v) => opts.find((o) => o.value === v)?.label ?? v);
	if (a.text) labels.push(`\u201C${a.text}\u201D`);
	return labels.join(", ");
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The top of every message: what it is, which chat, which folder. */
export function renderHead(ask) {
	const icon = KIND_ICON[ask?.kind] ?? KIND_ICON.question;
	const lines = [`${icon} <b>${escapeHtml(cut(ask?.title || "A chat needs you", 200))}</b>`];
	if (ask?.conversationTitle) lines.push(`Chat: ${escapeHtml(cut(ask.conversationTitle, 100))}`);
	if (ask?.cwd) lines.push(`Folder: <code>${escapeHtml(cut(shortPath(ask.cwd), 150))}</code>`);
	return lines.join("\n");
}

function linkLine(link) {
	return link ? `<a href="${escapeHtml(link)}">Open the chat</a>` : "";
}

/** The buttons for the current part of a question. */
export function renderButtons(ask, st) {
	const i = st?.step ?? 0;
	const f = ask?.fields?.[i];
	if (!f || st?.sending) return { inline_keyboard: [] };
	const opts = fieldOptions(ask, i, st.answers);
	const ticks = st.ticks ?? [];
	const rows = opts.map((o, n) => {
		const label = cut(o.label || o.value, LABEL_MAX);
		const text = f.multi ? `${ticks.includes(o.value) ? "\u2611" : "\u2610"} ${label}` : label;
		return [{ text, callback_data: `${st.ref}:${i}:o${n}` }];
	});
	if (f.multi && opts.length) rows.push([{ text: "\u2705 Done", callback_data: `${st.ref}:${i}:d` }]);
	if (f.allowText) rows.push([{ text: "\u270F\uFE0F Type an answer", callback_data: `${st.ref}:${i}:t` }]);
	return { inline_keyboard: rows };
}

/**
 * The whole message for a waiting question: { text, reply_markup }.
 * st = { ref, step, answers, ticks, sending, link }. extra = { warning, note }.
 */
export function renderAsk(ask, st, extra = {}) {
	const answers = st?.answers ?? {};
	const step = st?.step ?? 0;
	const f = ask?.fields?.[step];
	const head = renderHead(ask);
	const approval = ask?.kind === "approval";

	const done = [];
	(ask?.fields ?? []).forEach((field, i) => {
		if (!answers[field.id] || !visibleField(ask, i, answers)) return;
		const q = cut(field.header || field.text || field.id, 80);
		done.push(`\u2714\uFE0F ${escapeHtml(q)}: ${escapeHtml(cut(describeAnswer(ask, i, answers), 150))}`);
	});

	const fieldPart = [];
	if (f && !st?.sending) {
		const shown = (ask.fields ?? []).map((_, i) => i).filter((i) => visibleField(ask, i, answers));
		const pos = shown.indexOf(step) + 1;
		const count = shown.length > 1 && pos > 0 ? ` (${pos}/${shown.length})` : "";
		if (f.header) fieldPart.push(`<b>${escapeHtml(cut(f.header, 100))}</b>${count}`);
		else if (count) fieldPart.push(`<b>Part${count}</b>`);
		if (f.text && f.text !== ask.title) fieldPart.push(escapeHtml(cut(f.text, 1000)));
		if (f.detail) fieldPart.push(`<i>${escapeHtml(cut(f.detail, 500))}</i>`);
		const opts = fieldOptions(ask, step, answers);
		const described = opts.filter((o) => o.description);
		if (described.length) {
			fieldPart.push(
				described
					.slice(0, 12)
					.map(
						(o) =>
							`\u2022 <b>${escapeHtml(cut(o.label || o.value, LABEL_MAX))}</b>: ${escapeHtml(cut(o.description, 200))}`,
					)
					.join("\n"),
			);
		}
		if (f.multi && opts.length) fieldPart.push("<i>Tick all that fit, then tap Done.</i>");
		else if (f.allowText && !opts.length) fieldPart.push("<i>Reply to this message with your answer.</i>");
	}

	const tail = [];
	if (extra.warning) tail.push(`\u26A0\uFE0F ${escapeHtml(cut(extra.warning, 300))}`);
	if (st?.sending) tail.push(`<i>${escapeHtml(extra.note || "Sending your answer\u2026")}</i>`);
	const link = linkLine(st?.link);
	if (link) tail.push(link);

	const renderBody = (raw) => {
		if (!raw) return "";
		return approval ? `<pre>${escapeHtml(raw)}</pre>` : escapeHtml(raw);
	};
	const build = (bodyRaw) =>
		[head, renderBody(bodyRaw), done.join("\n"), fieldPart.join("\n"), tail.join("\n")].filter(Boolean).join("\n\n");

	let bodyRaw = ask?.body ? String(ask.body) : "";
	let text = build(bodyRaw);
	const over = visibleLength(text) - TEXT_BUDGET;
	if (over > 0 && bodyRaw) {
		const note = "\n\u2026 (cut: open the chat for the rest)";
		const keep = bodyRaw.length - over - note.length - 20;
		bodyRaw = keep > 200 ? bodyRaw.slice(0, keep) + note : "(Too long for Telegram: open the chat to read it.)";
		text = build(bodyRaw);
	}
	if (visibleLength(text) > TEXT_BUDGET) {
		// Still too long (a huge question): the short form.
		text = [
			head,
			f ? escapeHtml(cut(f.text || f.header || "", 1500)) : "",
			"(Cut: open the chat for the rest.)",
			tail.join("\n"),
		]
			.filter(Boolean)
			.join("\n\n");
	}
	return { text, reply_markup: renderButtons(ask, st) };
}

export function renderAnswered(head, summary, from, link) {
	const where = from === PLUGIN_ID ? "on Telegram" : from === "browser" || !from ? "in the browser" : `by ${from}`;
	return [
		head,
		`\u2705 <b>Answered ${escapeHtml(where)}</b>: ${escapeHtml(cut(summary || "done", 1500))}`,
		linkLine(link),
	]
		.filter(Boolean)
		.join("\n\n");
}

export function renderGone(head, reason, link) {
	return [head, `\u23F9 <b>No longer waiting</b>: ${escapeHtml(cut(reason || "it went away", 300))}`, linkLine(link)]
		.filter(Boolean)
		.join("\n\n");
}

// ---------------------------------------------------------------------------
// Only the owner, only in a private chat
// ---------------------------------------------------------------------------

export function isOwnerMessage(msg, ownerId) {
	const owner = String(ownerId ?? "");
	return (
		/^\d+$/.test(owner) &&
		String(msg?.from?.id ?? "") === owner &&
		msg?.chat?.type === "private" &&
		String(msg?.chat?.id ?? "") === owner
	);
}

export function isOwnerCallback(cq, ownerId) {
	const owner = String(ownerId ?? "");
	return (
		/^\d+$/.test(owner) &&
		String(cq?.from?.id ?? "") === owner &&
		isOwnerMessage({ ...cq?.message, from: cq?.from }, owner)
	);
}

// ---------------------------------------------------------------------------
// The bridge between host.asks and the bot
// ---------------------------------------------------------------------------

const keyOf = (ask) => `${ask.id}@${ask.createdAt}`;
/** A no-op for optional callbacks (takes any arguments, so callers' signatures check). */
const ignore = (..._args) => {};
const notModified = (err) => /not modified/i.test(String(err?.description ?? err?.message ?? ""));
/** Worth another try: Telegram asked us to slow down (429), had a hiccup (5xx), or the connection
 *  failed or got no answer in time (code 0). */
const retryable = (err) => err?.code === 429 || err?.code === 0 || (err?.code >= 500 && err?.code <= 599);

/** The ref our buttons carry ("<ref>:<part>:<action>"), read off a message Telegram shows us. */
function refOfButtons(message) {
	for (const row of message?.reply_markup?.inline_keyboard ?? []) {
		for (const b of row ?? []) {
			const m = /^(\d+):/.exec(String(b?.callback_data ?? ""));
			if (m) return m[1];
		}
	}
	return null;
}

/**
 * Keeps one Telegram message per waiting ask. Everything that talks to Telegram runs one at a
 * time, in order, so an edit never overtakes the message it edits.
 *
 * A message is sent with its ref in every button, and the ref is kept when a send fails: when
 * Telegram got a send whose answer was lost, and the next try sends it again, both copies carry
 * the same ref and a tap on either one counts. Refs start from the clock (seconds), so they never
 * repeat even if the storage is lost; a tap on an old message can't hit a newer question.
 *
 * storage keys: "sent" (key -> message state), "nextRef" (button ids).
 */
export function createBridge({
	api,
	asks,
	storage,
	ownerId,
	webAppAddress = "",
	selfId = PLUGIN_ID,
	log = ignore,
	sleep,
}) {
	const owner = String(ownerId);
	const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
	const entries = new Map(Object.entries(storage.get("sent", {}) ?? {}));
	let nextRef = Number(storage.get("nextRef", 0)) || Math.floor(Date.now() / 1000);
	const pendingSends = new Set();
	let chain = Promise.resolve();
	let closed = false;

	const save = () => storage.set("sent", Object.fromEntries(entries));
	const byRef = (ref) => {
		for (const e of entries.values()) if (String(e.ref) === String(ref)) return e;
		return null;
	};
	const liveAsk = (e) => asks.list().find((a) => a.id === e.askId && a.createdAt === e.createdAt) ?? null;

	function enqueue(job) {
		const run = chain
			.then(() => (closed ? undefined : job()))
			.catch((err) => {
				log("warn", `telegram: ${err?.message ?? err}`);
			});
		chain = run;
		return run;
	}

	async function call(method, params) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await api.call(method, params);
			} catch (err) {
				if (!retryable(err) || attempt >= RETRY_DELAYS_MS.length || closed) throw err;
				await wait(
					err.code === 429
						? Math.min(60, Math.max(1, err.retryAfter || 1)) * 1000
						: RETRY_DELAYS_MS[attempt],
				);
			}
		}
	}

	const send = (text, extra = {}) =>
		call("sendMessage", {
			chat_id: owner,
			text,
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
			...extra,
		});

	/** Every message that shows e: the one we sent, and copies found since (see noteCopy). */
	const messagesOf = (e) => [e.messageId, ...(e.copies ?? [])].filter((id) => Number(id) > 0);

	/** A tap or reply came from message msgId, which carries e's ref: it shows e too. */
	function noteCopy(e, msgId) {
		if (!msgId || messagesOf(e).includes(msgId)) return;
		// A send whose answer was lost did arrive: when no later try got through, that's the message.
		if (!e.messageId) e.messageId = msgId;
		else e.copies = [...(e.copies ?? []), msgId];
		save();
	}

	/** One edit on every message that shows e. A copy that can't be edited (deleted) doesn't matter. */
	async function editAll(e, method, params) {
		let failed = null;
		for (const id of messagesOf(e)) {
			try {
				await call(method, { chat_id: owner, message_id: id, ...params });
			} catch (err) {
				if (!notModified(err) && id === e.messageId) failed ??= err;
			}
		}
		if (failed) throw failed;
	}

	const edit = (e, text, reply_markup = { inline_keyboard: [] }) =>
		editAll(e, "editMessageText", {
			text,
			parse_mode: "HTML",
			link_preview_options: { is_disabled: true },
			reply_markup,
		});

	async function removePrompts(e, onlyField) {
		for (const [pid, fi] of Object.entries(e.prompts ?? {})) {
			if (onlyField !== undefined && fi !== onlyField) continue;
			delete e.prompts[pid];
			await call("deleteMessage", { chat_id: owner, message_id: Number(pid) }).catch(ignore);
		}
	}

	/** Forget a message, and edit it to its final words. */
	async function finish(e, text) {
		if (entries.get(e.key) === e) {
			entries.delete(e.key);
			save();
		}
		await edit(e, text).catch((err) => log("warn", `telegram: ${err?.message ?? err}`));
		await removePrompts(e);
	}

	async function rerender(e, ask, extra) {
		const { text, reply_markup } = renderAsk(ask, e, extra);
		await edit(e, text, reply_markup);
	}

	/** Send ask's message, unless it has one. The entry is kept before sending, so a failed send
	 *  keeps its ref: the next try (the next resync) sends the same buttons. */
	function sendAsk(ask) {
		const key = keyOf(ask);
		if (entries.get(key)?.messageId || pendingSends.has(key)) return;
		pendingSends.add(key);
		enqueue(async () => {
			try {
				const live = asks.list().find((a) => keyOf(a) === key);
				if (!live) return;
				let e = entries.get(key);
				if (e?.messageId) return;
				if (!e) {
					e = {
						key,
						ref: nextRef++,
						askId: live.id,
						createdAt: live.createdAt,
						messageId: 0,
						step: 0,
						answers: {},
						ticks: [],
						prompts: {},
						sending: false,
						link: chatLink(webAppAddress, live.sessionFile),
						head: renderHead(live),
					};
					storage.set("nextRef", nextRef);
					e.step = Math.max(0, nextStep(live, e.answers));
					entries.set(key, e);
					save();
				}
				const { text, reply_markup } = renderAsk(live, e);
				const msg = await send(text, { reply_markup });
				e.messageId = Number(msg?.message_id) || 0;
				save();
				log("info", `telegram: sent ${live.kind === "approval" ? "permission prompt" : "question"} ${live.id} as message ${e.messageId}`);
			} finally {
				pendingSends.delete(key);
			}
		});
	}

	function onAskEvent(ev) {
		if (closed || !ev?.ask) return;
		if (ev.type === "appeared") {
			sendAsk(ev.ask);
			return;
		}
		const key = keyOf(ev.ask);
		const head = renderHead(ev.ask);
		enqueue(async () => {
			const e = entries.get(key);
			if (!e) return;
			const text =
				ev.type === "answered"
					? renderAnswered(head, ev.summary, ev.from, e.link)
					: renderGone(head, ev.reason, e.link);
			await finish(e, text);
		});
	}

	/** All fields answered: answer the chat. */
	async function submit(e, ask) {
		e.sending = true;
		save();
		await rerender(e, ask).catch(ignore);
		let res;
		try {
			res = await asks.answer(ask.id, collectAnswers(ask, e.answers));
		} catch (err) {
			res = { ok: false, error: String(err?.message ?? err) };
		}
		if (res?.ok) {
			log("info", `telegram: answered ${ask.id} from Telegram`);
			// The "answered" event writes the final words (it may already be queued).
			return;
		}
		if (/no longer waiting/i.test(String(res?.error ?? ""))) {
			await finish(e, renderGone(e.head, "it was answered or went away", e.link));
			return;
		}
		e.sending = false;
		e.answers = {};
		e.ticks = [];
		e.step = Math.max(0, nextStep(ask, e.answers));
		save();
		await rerender(e, ask, { warning: `${res?.error || "That didn't work"}. Please answer again.` });
	}

	async function advance(e, ask) {
		const next = nextStep(ask, e.answers);
		if (next < 0) return submit(e, ask);
		e.step = next;
		e.ticks = [];
		save();
		await rerender(e, ask);
	}

	async function onCallback(cq) {
		const reply = (text) =>
			call("answerCallbackQuery", { callback_query_id: cq.id, ...(text ? { text: cut(text, 190) } : {}) }).catch(
				ignore,
			);
		const m = /^(\d+):(\d+):(o\d+|d|t)$/.exec(String(cq.data ?? ""));
		const msgId = Number(cq.message?.message_id) || 0;
		const e = m ? byRef(m[1]) : null;
		if (!e) {
			await reply("No longer waiting.");
			if (msgId) {
				await call("editMessageReplyMarkup", {
					chat_id: owner,
					message_id: msgId,
					reply_markup: { inline_keyboard: [] },
				}).catch(ignore);
			}
			return;
		}
		// Another message with this ref (a copy Telegram got twice) counts like the one we know.
		noteCopy(e, msgId);
		const ask = liveAsk(e);
		if (!ask) {
			await reply("No longer waiting.");
			await finish(e, renderGone(e.head, "it went away", e.link));
			return;
		}
		if (e.sending) {
			await reply("Your answer is on its way.");
			return;
		}
		const fi = Number(m[2]);
		const field = ask.fields[fi];
		if (fi !== e.step || !field) {
			await reply("That part is already answered.");
			return;
		}
		const act = m[3];
		if (act === "t") {
			if (!field.allowText) {
				await reply("This one needs a button.");
				return;
			}
			await reply();
			const p = await send(escapeHtml(`Type your answer to: ${cut(field.text || field.header || ask.title, 300)}`), {
				reply_parameters: { message_id: e.messageId, allow_sending_without_reply: true },
				reply_markup: { force_reply: true, input_field_placeholder: "Your answer" },
			});
			if (p?.message_id) {
				e.prompts[p.message_id] = fi;
				save();
			}
			return;
		}
		if (act === "d") {
			if (!field.multi) {
				await reply();
				return;
			}
			if (!e.ticks.length) {
				await reply("Tick at least one choice first.");
				return;
			}
			e.answers[field.id] = { selected: [...e.ticks] };
			e.ticks = [];
			await reply();
			await removePrompts(e, fi);
			await advance(e, ask);
			return;
		}
		const opt = fieldOptions(ask, fi, e.answers)[Number(act.slice(1))];
		if (!opt) {
			await reply("That choice changed; look again.");
			await rerender(e, ask);
			return;
		}
		if (field.multi) {
			e.ticks = e.ticks.includes(opt.value) ? e.ticks.filter((v) => v !== opt.value) : [...e.ticks, opt.value];
			save();
			await reply();
			await editAll(e, "editMessageReplyMarkup", { reply_markup: renderButtons(ask, e) });
			return;
		}
		e.answers[field.id] = { selected: [opt.value] };
		await reply(`Chosen: ${opt.label || opt.value}`);
		await removePrompts(e, fi);
		await advance(e, ask);
	}

	async function typedAnswer(e, fi, text, say) {
		const ask = liveAsk(e);
		if (!ask) {
			await say("That question is no longer waiting.");
			await finish(e, renderGone(e.head, "it went away", e.link));
			return;
		}
		if (e.sending) {
			await say("Your answer is already on its way.");
			return;
		}
		const field = ask.fields[fi];
		if (fi !== e.step || !field) {
			await say("That part is already answered.");
			return;
		}
		if (!field.allowText) {
			await say("This one needs a button: tap one of the choices on the question.");
			return;
		}
		if (!text) {
			await say("Please answer with text.");
			return;
		}
		e.answers[field.id] = { selected: field.multi ? [...e.ticks] : [], text };
		e.ticks = [];
		save();
		await removePrompts(e, fi);
		await advance(e, ask);
	}

	/** Questions waiting for a typed answer to their current part (each once). */
	function openPrompts() {
		const open = new Set();
		for (const e of entries.values()) {
			for (const fi of Object.values(e.prompts ?? {})) if (Number(fi) === e.step && !e.sending) open.add(e);
		}
		return [...open];
	}

	async function onMessage(msg) {
		const text = typeof msg.text === "string" ? msg.text.trim() : "";
		const say = (t) =>
			send(escapeHtml(t), {
				reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
			}).catch(ignore);
		const replyTo = Number(msg.reply_to_message?.message_id) || 0;
		if (replyTo) {
			for (const e of entries.values()) {
				const fi = e.prompts?.[replyTo];
				if (fi !== undefined) return typedAnswer(e, Number(fi), text, say);
				if (messagesOf(e).includes(replyTo)) return typedAnswer(e, e.step, text, say);
			}
			// A copy we haven't met yet: its buttons carry the question's ref.
			const copyOf = byRef(refOfButtons(msg.reply_to_message));
			if (copyOf) {
				noteCopy(copyOf, replyTo);
				return typedAnswer(copyOf, copyOf.step, text, say);
			}
			// A "Type your answer" prompt we don't know (one sent twice when an answer got lost):
			// when just one question waits for a typed answer, it's that one.
			const to = msg.reply_to_message;
			if (to?.from?.is_bot && String(to.text ?? "").startsWith("Type your answer to:")) {
				const open = openPrompts();
				if (open.length === 1) {
					// Remember it, so it's cleared away with the prompt we know.
					open[0].prompts = { ...open[0].prompts, [replyTo]: open[0].step };
					save();
					return typedAnswer(open[0], open[0].step, text, say);
				}
			}
			await say("That question is no longer waiting.");
			return;
		}
		if (/^\/start(\s|@|$)/.test(text)) {
			const n = asks.list().length;
			await say(
				"Hi! pi sends you its questions and permission prompts here. Tap a button to answer, or reply to a question's message to type an answer." +
					(n ? `\n\nWaiting now: ${n}.` : ""),
			);
			resync("it went away");
			return;
		}
		const open = openPrompts();
		if (open.length === 1 && text) return typedAnswer(open[0], open[0].step, text, say);
		await say("To answer a question, tap one of its buttons, or reply to its message to type an answer.");
	}

	function handleUpdate(update) {
		if (closed) return Promise.resolve();
		const cq = update?.callback_query;
		if (cq) {
			if (!isOwnerCallback(cq, owner)) return Promise.resolve();
			log("info", `telegram: the owner tapped ${cut(cq.data, 40)} on message ${cq.message?.message_id ?? "?"}`);
			return enqueue(() => onCallback(cq));
		}
		const msg = update?.message;
		if (msg) {
			if (!isOwnerMessage(msg, owner)) return Promise.resolve();
			const to = Number(msg.reply_to_message?.message_id) || 0;
			// Never the text itself: it can be anything.
			log("info", `telegram: a message from the owner${to ? ` replying to message ${to}` : ""}`);
			return enqueue(() => onMessage(msg));
		}
		return Promise.resolve();
	}

	/** Old messages whose ask is gone get their final words; waiting asks without a message get one. */
	function resync(reason = "it went away") {
		return enqueue(async () => {
			const live = asks.list();
			const liveKeys = new Set(live.map(keyOf));
			for (const e of [...entries.values()]) {
				if (liveKeys.has(e.key)) continue;
				await finish(
					e,
					e.sending
						? renderAnswered(e.head, "your answer was sent", selfId, e.link)
						: renderGone(e.head, reason, e.link),
				);
			}
			for (const a of live) if (!entries.get(keyOf(a))?.messageId) sendAsk(a);
		});
	}

	return {
		onAskEvent,
		handleUpdate,
		resync,
		/** Resolves when everything queued so far has run (tests). */
		idle: () => chain,
		close() {
			closed = true;
		},
		/** For tests. */
		entries,
	};
}

// ---------------------------------------------------------------------------
// Long polling
// ---------------------------------------------------------------------------

export function createPoller({
	api,
	storage,
	offsetKey = "offset",
	onUpdate,
	onStatus = ignore,
	onFatal = ignore,
	log = ignore,
}) {
	const ctl = new AbortController();
	let started = false;
	const sleep = (ms) =>
		new Promise((resolve) => {
			if (ctl.signal.aborted) return resolve();
			const t = setTimeout(resolve, ms);
			ctl.signal.addEventListener(
				"abort",
				() => {
					clearTimeout(t);
					resolve();
				},
				{ once: true },
			);
		});

	async function loop() {
		let offset = Number(storage.get(offsetKey, 0)) || 0;
		let backoff = BACKOFF_MIN_MS;
		while (!ctl.signal.aborted) {
			try {
				const updates = await api.call(
					"getUpdates",
					{ offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message", "callback_query"] },
					{ signal: ctl.signal, timeoutMs: POLL_FETCH_TIMEOUT_MS },
				);
				if (ctl.signal.aborted) break;
				backoff = BACKOFF_MIN_MS;
				onStatus("listening");
				for (const u of Array.isArray(updates) ? updates : []) {
					const id = Number(u?.update_id);
					if (Number.isFinite(id) && id >= offset) {
						offset = id + 1;
						storage.set(offsetKey, offset);
					}
					try {
						await onUpdate(u);
					} catch (err) {
						log("warn", `telegram: an update failed: ${err?.message ?? err}`);
					}
				}
			} catch (err) {
				if (ctl.signal.aborted) break;
				const code = err?.code;
				if (code === 401 || code === 404) {
					onStatus("the bot token was refused: check it in the settings");
					onFatal(err);
					break;
				}
				if (code === 409) {
					onStatus("another program is reading this bot's messages");
					await sleep(BACKOFF_MAX_MS);
					continue;
				}
				if (code === 429) {
					await sleep(Math.max(1, err.retryAfter || 5) * 1000);
					continue;
				}
				onStatus(`can't reach Telegram, retrying (${cut(err?.description ?? err?.message ?? err, 120)})`);
				log("warn", `telegram: ${err?.message ?? err}`);
				await sleep(backoff);
				backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
			}
		}
	}

	return {
		start() {
			if (started) return;
			started = true;
			void loop();
		},
		stop() {
			ctl.abort();
		},
	};
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export default {
	activate(host) {
		let current = null;
		const task = host.registerBackgroundTask({
			id: "telegram-bot",
			label: "\u{1F4E8} Telegram",
			status: "starting",
			stop: () => {
				stopAll();
				setStatus("stopped (save the settings to start again)");
			},
		});
		let lastStatus = "";
		function setStatus(status) {
			if (status === lastStatus) return;
			lastStatus = status;
			try {
				task.update({ status });
			} catch {
				/* ignore */
			}
		}
		const log = (level, ...args) => {
			try {
				host.log(level, ...args);
			} catch {
				/* ignore */
			}
		};

		function stopAll() {
			const c = current;
			current = null;
			if (!c) return;
			try {
				c.offAsks?.();
			} catch {
				/* ignore */
			}
			clearInterval(c.timer);
			c.poller?.stop();
			c.bridge?.close();
		}

		function start() {
			stopAll();
			let s = {};
			try {
				s = host.getSettings?.() ?? {};
			} catch {
				s = {};
			}
			if (s.enabled === false) {
				setStatus("off");
				return;
			}
			const token = String(s.botToken ?? "").trim();
			const ownerId = String(s.ownerId ?? "").trim();
			if (!token || !/^\d+$/.test(ownerId)) {
				const missing = [!token && "the bot token", !/^\d+$/.test(ownerId) && "your Telegram id"].filter(Boolean);
				setStatus(`not set up: add ${missing.join(" and ")} in the settings`);
				return;
			}
			// A new bot starts over: its update numbers and messages have nothing to do with the old one's.
			const botId = token.split(":")[0];
			if (host.storage.get("bot") !== botId) {
				host.storage.set("bot", botId);
				host.storage.delete("offset");
				host.storage.delete("sent");
			}
			const api = createTelegramApi({ base: process.env[API_BASE_ENV] || API_BASE_DEFAULT, token });
			const bridge = createBridge({
				api,
				asks: host.asks,
				storage: host.storage,
				ownerId,
				webAppAddress: String(s.webAppAddress ?? "").trim(),
				log,
			});
			const c = { bridge };
			current = c;
			// While we listen, a chat with no browser open waits for an answer instead of refusing.
			c.offAsks = host.asks.on((ev) => bridge.onAskEvent(ev));
			c.poller = createPoller({
				api,
				storage: host.storage,
				onUpdate: (u) => bridge.handleUpdate(u),
				onStatus: (st) => {
					if (current === c) setStatus(st);
				},
				onFatal: () => {
					// The token is refused: stop listening, so chats don't wait on a bot that can't reach you.
					if (current !== c) return;
					try {
						c.offAsks?.();
					} catch {
						/* ignore */
					}
					c.offAsks = null;
					clearInterval(c.timer);
				},
				log,
			});
			c.poller.start();
			void bridge.resync("pi restarted");
			c.timer = setInterval(() => void bridge.resync("it went away"), RESYNC_MS);
			c.timer.unref?.();
			setStatus("connecting");
		}

		start();
		const offSettings = host.onSettingsChanged?.(() => start());
		return () => {
			try {
				offSettings?.();
			} catch {
				/* ignore */
			}
			stopAll();
			try {
				task.unregister();
			} catch {
				/* ignore */
			}
		};
	},
};
