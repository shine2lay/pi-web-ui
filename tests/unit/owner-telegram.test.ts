/**
 * owner-telegram (Ops #783): a script's Telegram message to the owner. The request's checks, reading the
 * telegram_send tool's answer (sent only when the tool says so; "may have been sent" whenever that can't be
 * ruled out), and the control socket's telegram_send: only with the app token, answered once the send has
 * ended, one tool call per request, never the token or the text in the journal.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAppToken } from "../../server/app-token.js";
import { controlPath, startControlServer } from "../../server/control-socket.js";
import {
	checkOwnerTelegram,
	sendOwnerTelegram,
	type OwnerTelegramNotice,
	type OwnerTelegramResult,
} from "../../server/owner-telegram.js";

const TEXT = "Deployed rollcall 1a2b3c4 (health check passed)";

describe("checkOwnerTelegram", () => {
	it("takes text with or without from, url and linkLabel, as the tool's parameters", () => {
		expect(checkOwnerTelegram({ cmd: "telegram_send", token: "t", text: TEXT })).toEqual({
			ok: true,
			notice: { text: TEXT },
		});
		expect(
			checkOwnerTelegram({ cmd: "telegram_send", text: TEXT, from: "RollCall CD", url: "/s/1", linkLabel: "Look" }),
		).toEqual({ ok: true, notice: { text: TEXT, from: "RollCall CD", url: "/s/1", linkLabel: "Look" } });
	});

	it("says what is wrong: no text, a field that isn't a string, a key it doesn't take", () => {
		expect(checkOwnerTelegram({ cmd: "telegram_send" })).toEqual({
			ok: false,
			error: "text is required (the message for the owner)",
		});
		expect(checkOwnerTelegram({ text: "  \n " })).toMatchObject({ ok: false, error: /^text is required/ });
		expect(checkOwnerTelegram({ text: 5 })).toMatchObject({ ok: false, error: /^text is required/ });
		for (const field of ["from", "url", "linkLabel"])
			expect(checkOwnerTelegram({ text: TEXT, [field]: 1 })).toEqual({ ok: false, error: `${field} must be a string` });
		expect(checkOwnerTelegram({ text: TEXT, chatId: "123" })).toEqual({
			ok: false,
			error: "telegram_send takes only cmd, token, text, from, url and linkLabel (not chatId)",
		});
	});
});

describe("sendOwnerTelegram", () => {
	const notice: OwnerTelegramNotice = { text: TEXT, from: "RollCall CD" };
	const toolAnswering = (answer: unknown) => ({ execute: vi.fn(async () => answer) });

	it("sent only when the tool says it sent: its message ids", async () => {
		const tool = toolAnswering({ details: { ok: true, messageId: 901, messageIds: [901, 902] } });
		expect(await sendOwnerTelegram(tool, notice, "c-1")).toEqual({ ok: true, messageIds: [901, 902] });
		expect(tool.execute).toHaveBeenCalledTimes(1);
		expect(tool.execute).toHaveBeenCalledWith("c-1", { text: TEXT, from: "RollCall CD" });
	});

	it("not loaded, or the tool refused before sending: not sent, and nothing may have gone out", async () => {
		expect(await sendOwnerTelegram(undefined, notice, "c")).toEqual({
			ok: false,
			error: "the Telegram plugin isn't loaded here (no telegram_send tool); nothing was sent",
		});
		const off = toolAnswering({ details: { ok: false, error: "Telegram is off in its settings" }, isError: true });
		expect(await sendOwnerTelegram(off, notice, "c")).toEqual({
			ok: false,
			error: "not sent: Telegram is off in its settings",
		});
	});

	it("may have been sent: a part went out, the tool threw, or an answer it can't read", async () => {
		const part = toolAnswering({ details: { ok: false, error: "Telegram refused it: 429", messageIds: [901] } });
		expect(await sendOwnerTelegram(part, notice, "c")).toEqual({
			ok: false,
			error: "not sent: Telegram refused it: 429 (part of it went out before that)",
			maybeSent: true,
		});
		const threw = { execute: vi.fn(async () => Promise.reject(new Error("boom\nat line 3"))) };
		expect(await sendOwnerTelegram(threw, notice, "c")).toEqual({
			ok: false,
			error: "the telegram_send tool failed: boom at line 3",
			maybeSent: true,
		});
		for (const odd of [undefined, null, {}, { details: { ok: true } }, { details: { ok: true, messageIds: [null] } }])
			expect(await sendOwnerTelegram(toolAnswering(odd), notice, "c")).toMatchObject({ ok: false, maybeSent: true });
	});
});

describe("the control socket's telegram_send", () => {
	let data: string;
	let journal: string[];
	beforeEach(() => {
		data = mkdtempSync(join(tmpdir(), "owner-tg-sock-"));
		journal = [];
		for (const level of ["log", "warn", "error", "info"] as const)
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				journal.push(args.map(String).join(" "));
			});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(data, { recursive: true, force: true });
	});

	const service = { serviceStatus: () => ({}) as never, quiesce: () => {}, unquiesce: () => {} };

	/** Write `lines` on one connection and collect `count` answers. */
	function askLines(sock: string, lines: Record<string, unknown>[], count = lines.length): Promise<unknown[]> {
		return new Promise((resolve, reject) => {
			const c = createConnection(sock);
			let buf = "";
			c.on("connect", () => c.write(lines.map((l) => `${JSON.stringify(l)}\n`).join("")));
			c.on("data", (d) => {
				buf += d.toString();
				const got = buf.split("\n").filter(Boolean);
				if (got.length >= count) {
					c.destroy();
					resolve(got.slice(0, count).map((l) => JSON.parse(l)));
				}
			});
			c.on("error", reject);
			c.on("close", () => reject(new Error(`closed after ${buf.split("\n").filter(Boolean).length} answers`)));
		});
	}
	const ask = async (sock: string, req: Record<string, unknown>) => (await askLines(sock, [req]))[0];
	async function listening(sock: string): Promise<void> {
		for (let i = 0; i < 250; i++) {
			try {
				statSync(sock);
				return;
			} catch {
				await new Promise((r) => setTimeout(r, 20));
			}
		}
		throw new Error("the control socket didn't start");
	}

	it("refuses without the app token or with bad fields, and never calls the plugin then", async () => {
		const token = ensureAppToken(data);
		const send = vi.fn(async (): Promise<OwnerTelegramResult> => ({ ok: true, messageIds: [1] }));
		const stop = startControlServer({ service, dataDir: data, port: 0, appToken: token, ownerTelegram: send });
		try {
			const sock = controlPath(data, 0);
			await listening(sock);
			const req = { cmd: "telegram_send", text: TEXT };
			const answers = [
				await ask(sock, req),
				await ask(sock, { ...req, token: "0".repeat(64) }),
				await ask(sock, { ...req, token, chatId: "1" }),
				await ask(sock, { cmd: "telegram_send", token, text: "" }),
				await ask(sock, { ...req, token, url: 3 }),
			];
			expect(answers).toEqual([
				{
					ok: false,
					error: "refused: only scripts on this machine with the app token may send Telegram messages (no app token)",
				},
				{
					ok: false,
					error:
						"refused: only scripts on this machine with the app token may send Telegram messages (a wrong app token)",
				},
				{ ok: false, error: "telegram_send takes only cmd, token, text, from, url and linkLabel (not chatId)" },
				{ ok: false, error: "text is required (the message for the owner)" },
				{ ok: false, error: "url must be a string" },
			]);
			expect(send).not.toHaveBeenCalled();
			expect(journal).toContain("[control] refused telegram_send: a wrong app token");
		} finally {
			stop();
		}
	});

	it("without a Telegram sender: says so", async () => {
		const token = ensureAppToken(data);
		const stop = startControlServer({ service, dataDir: data, port: 0, appToken: token });
		try {
			const sock = controlPath(data, 0);
			await listening(sock);
			expect(await ask(sock, { cmd: "telegram_send", token, text: TEXT })).toEqual({
				ok: false,
				error: "Telegram messages aren't supported here",
			});
		} finally {
			stop();
		}
	});

	it("answers once the send has ended (past the idle timeout), one call per request, in order; never logs token or text", async () => {
		const token = ensureAppToken(data);
		let release: (r: OwnerTelegramResult) => void = () => {};
		const send = vi.fn(
			(_notice: OwnerTelegramNotice) =>
				new Promise<OwnerTelegramResult>((resolve) => {
					release = resolve;
				}),
		);
		const stop = startControlServer({
			service,
			dataDir: data,
			port: 0,
			appToken: token,
			ownerTelegram: send,
			idleTimeoutMs: 100,
		});
		try {
			const sock = controlPath(data, 0);
			await listening(sock);
			const pending = askLines(sock, [
				{ cmd: "telegram_send", token, text: TEXT, from: "RollCall CD", url: "/s/1", linkLabel: "Look" },
				{ cmd: "no_such" },
			]);
			await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
			// Longer than the idle timeout: the connection stays open while the answer is pending.
			await new Promise((r) => setTimeout(r, 400));
			release({ ok: true, messageIds: [901] });
			expect(await pending).toEqual([
				{ ok: true, messageIds: [901] },
				{ ok: false, error: "unknown cmd: no_such" },
			]);
			expect(send).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledWith({ text: TEXT, from: "RollCall CD", url: "/s/1", linkLabel: "Look" });
			expect(journal).toContain("[control] telegram_send: sent to the owner as message 901");

			// An idle connection is still closed after the idle timeout.
			const idle = await new Promise<number>((resolve, reject) => {
				const c = createConnection(sock);
				const t0 = Date.now();
				c.on("close", () => resolve(Date.now() - t0));
				c.on("error", reject);
			});
			expect(idle).toBeLessThan(5_000);

			const text = journal.join("\n");
			expect(text).not.toContain(token);
			expect(text).not.toContain(TEXT);
		} finally {
			stop();
		}
	});

	it("a refusal passes on whether it may have gone out; a throw counts as may have", async () => {
		const token = ensureAppToken(data);
		const results: (OwnerTelegramResult | Error)[] = [
			{ ok: false, error: "not sent: Telegram is off in its settings" },
			{ ok: false, error: "not sent: Telegram refused it: 429 (part of it went out before that)", maybeSent: true },
			new Error("plugin gone"),
		];
		const send = vi.fn(async () => {
			const next = results.shift();
			if (next instanceof Error) throw next;
			return next as OwnerTelegramResult;
		});
		const stop = startControlServer({ service, dataDir: data, port: 0, appToken: token, ownerTelegram: send });
		try {
			const sock = controlPath(data, 0);
			await listening(sock);
			const req = { cmd: "telegram_send", token, text: TEXT };
			expect(await ask(sock, req)).toEqual({ ok: false, error: "not sent: Telegram is off in its settings" });
			expect(await ask(sock, req)).toEqual({
				ok: false,
				error: "not sent: Telegram refused it: 429 (part of it went out before that)",
				maybeSent: true,
			});
			expect(await ask(sock, req)).toEqual({ ok: false, error: "the send failed: plugin gone", maybeSent: true });
			expect(send).toHaveBeenCalledTimes(3);
			const text = journal.join("\n");
			expect(text).not.toContain(token);
			expect(text).not.toContain(TEXT);
		} finally {
			stop();
		}
	});
});
