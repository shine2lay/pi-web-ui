// Ops #108: metadata-only accepted-input → sender → persisted/delivered chain → render → transport.
// No server, provider, model or real transport is started. Fixtures contain synthetic metadata only.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import { RoleMessages, type RoleMessageSendInput } from "../../server/role-messages.js";
import {
	browserRoleInput,
	collectRoleInput,
	mergeOwnerAnswer,
	newTurnRecord,
	ownerTurnOf,
	roleReplyOf,
	type RoleTurnRecord,
} from "../../server/role-replies.js";
import { planQuietRuns, quietSince, quietUnder, ownerFacing } from "../../server/quiet-turns.js";
import { createChat, replyMayGoToTelegram } from "../../plugins/telegram/index.mjs";

const now = Date.parse("2026-10-11T12:00:00Z");
const sendId = "rs-00000000-0000-4000-8000-000000000001";
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "owner-routing-"));
	const ids = ["coo", "beta", "gamma"];
	const files = Object.fromEntries(ids.map((id) => [id, join(dir, `${id}.jsonl`)]));
	for (const file of Object.values(files)) writeFileSync(file, "");
	const roles = ids.map((id) => ({ id, title: id, homeChat: files[id] }) as IdentityDef);
	const delivered: Array<{ file: string; text: string; turn: RoleTurnRecord }> = [];
	const storeFile = join(dir, "role-messages.json");
	let service: RoleMessages;
	const host = {
		roles: () => roles,
		chatState: () => "idle" as const,
		log: () => {},
		deliver: async (file: string, text: string) => {
			const turn = newTurnRecord();
			const owner = service.ownerContextFor(file, text);
			collectRoleInput(turn, { cause: "role", ...(owner ? { forOwner: owner } : {}) });
			// Synthetic transcript receipt: the real store verifies target and hash before inheritance.
			appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`);
			delivered.push({ file, text, turn });
			return { ok: true as const };
		},
		note: async () => ({ ok: true as const }),
	};
	service = new RoleMessages(storeFile, host, () => now);
	cleanups.push(() => {
		service.stop();
		rmSync(dir, { recursive: true, force: true });
	});
	const send = (role: string, turn: RoleTurnRecord, input: RoleMessageSendInput) => {
		const owner = ownerTurnOf(turn);
		const result = service.send(
			{ role, title: role, file: files[role], chat: "home chat", handling: 0, ...(owner ? { forOwner: owner } : {}) },
			input,
		);
		if (!result.ok) throw new Error(result.error);
		return result.record;
	};
	const take = async (id: string) => {
		await service.tick();
		const item = delivered.find((d) => d.text.includes(id));
		if (!item) throw new Error("synthetic delivery missing");
		return item;
	};
	return {
		files,
		roles,
		delivered,
		storeFile,
		service,
		send,
		take,
		reload: () => {
			service.stop();
			service = new RoleMessages(storeFile, host, () => now);
			return service;
		},
	};
}

function visible(f: ReturnType<typeof fixture>, item: { file: string; text: string }) {
	const stamp = f.service.stampFor(item.file, item.text);
	return !quietSince(
		[
			{ role: "user", text: item.text, stamp },
			{ role: "assistant", text: "Synthetic answer", stopReason: "stop" },
		],
		0,
		{ queueWakes: true, stallPokes: true, scheduledWakes: true },
	);
}

describe("stage 1: trusted accepted sources", () => {
	it("browser admission stamps owner provenance; raw causes and pseudo/helper clients cannot", () => {
		const rec = newTurnRecord();
		collectRoleInput(rec, browserRoleInput(true, false));
		expect(ownerTurnOf(rec)).toMatchObject({ ownerChannel: "browser", ownerIds: [] });
		for (const input of [
			browserRoleInput(false, false),
			browserRoleInput(true, true),
			{ cause: "browser" as const },
			{ cause: "telegram" as const },
		]) {
			const untrusted = newTurnRecord();
			collectRoleInput(untrusted, input);
			expect(ownerTurnOf(untrusted)).toBeNull();
		}
	});
	it("binds the helpers to real admission, preflight, sender, delivery and plugin producer boundaries", () => {
		const src = (p: string) => readFileSync(new URL(`../../server/${p}`, import.meta.url), "utf8");
		expect(src("index.ts")).toContain('typeof req.headers.origin === "string" && originAllowed(req)');
		expect(src("index.ts")).toContain(
			'browserRoleInput(acceptedBrowser, AgentService.isPseudoClientId(clientId ?? ""))',
		);
		const agent = src("agent-service.ts");
		expect(agent).toContain('if (disposition !== "handled") noteTurnCause(conv, flow, disposition === "queued")');
		expect(agent).toContain("collectRoleInput(rec, flow)");
		expect(agent).toContain("const owner = isHome ? ownerTurnOf(conv.turnRecord) : null");
		expect(agent).toContain("this.roleMessages.ownerContextFor(file, text)");
		expect(src("plugins.ts")).toContain('info.id === "telegram" && opts?.via === "telegram"');
	});
	it("mixed or unknown ownership keeps visibility but fails closed for transport", () => {
		const a = mergeOwnerAnswer(undefined, { ownerChannel: "browser" });
		const mixed = mergeOwnerAnswer(a, { ownerChannel: "telegram", ownerIds: [sendId] });
		expect(mixed.ownerChannel).toBeUndefined();
		expect(mergeOwnerAnswer(mixed, { ownerChannel: "telegram" }).ownerChannel).toBeUndefined();
	});
});

describe("stage 2: trusted store and nested inheritance", () => {
	it("ignores tool-supplied ownership; target/hash mismatches cannot inherit", async () => {
		const f = fixture();
		const rec = newTurnRecord();
		const input = {
			to: "beta",
			kind: "question",
			text: "Synthetic question",
			forOwner: true,
			ownerChannel: "telegram",
		};
		const result = f.service.send(
			{ role: "coo", title: "coo", file: f.files.coo, chat: "home chat", handling: 0 },
			input,
		);
		expect(result.ok && result.record.forOwner).toBeUndefined();
		collectRoleInput(rec, browserRoleInput(true, false));
		const q = f.send("coo", rec, { to: "beta", kind: "question", text: "Synthetic question" });
		const item = await f.take(q.id);
		expect(ownerTurnOf(item.turn)?.ownerChannel).toBe("browser");
		expect(f.service.ownerContextFor(f.files.gamma, item.text)).toBeNull();
		expect(f.service.ownerContextFor(item.file, `${item.text} changed`)).toBeNull();
		const reloaded = f.reload();
		expect(reloaded.ownerContextFor(item.file, item.text)?.ownerChannel).toBe("browser");
	});
	it("legacy Telegram needs exact stored ownership and server send ids; unknown new records stay unknown", async () => {
		const f = fixture();
		const rec = newTurnRecord();
		collectRoleInput(rec, { cause: "telegram", sendId, ownerChannel: "telegram" });
		const q = f.send("coo", rec, { to: "beta", kind: "question", text: "Synthetic legacy question" });
		const item = await f.take(q.id);
		delete q.ownerChannel; // fixed synthetic pre-upgrade store
		expect(f.service.ownerContextFor(item.file, item.text)?.ownerChannel).toBe("telegram");
		q.ownerChannel = null;
		expect(f.service.ownerContextFor(item.file, item.text)?.ownerChannel).toBeUndefined();
		q.forOwner = "yes" as unknown as boolean;
		expect(f.service.ownerContextFor(item.file, item.text)).toBeNull();
	});
});

describe("stage 3: chat classifier and protected owner items", () => {
	it("real persisted owner callbacks are full, ordinary callbacks still fold", async () => {
		const f = fixture();
		for (const owner of [true, false]) {
			const root = newTurnRecord();
			if (owner) collectRoleInput(root, browserRoleInput(true, false));
			const q = f.send("coo", root, { to: "beta", kind: "question", text: "Synthetic question" });
			const reply = f.send("beta", newTurnRecord(), {
				to: "coo",
				kind: "reply",
				replyTo: q.id,
				text: "Synthetic reply",
			});
			const item = await f.take(reply.id);
			expect(visible(f, item)).toBe(owner);
		}
	});
	it("quiet switches, dialogs, Needs-you, report and plugin/brief exceptions are unchanged", () => {
		for (const kind of ["queue-wake", "stall-poke", "scheduled"] as const) {
			expect(quietUnder({ kinds: [kind] }, {})).toBe(false);
			expect(quietUnder({ kinds: [kind] }, { queueWakes: true, stallPokes: true, scheduledWakes: true })).toBe(true);
		}
		for (const name of ["ask_user_question", "queue_stuck"]) expect(ownerFacing({ id: "synthetic", name })).toBe(true);
		expect(ownerFacing({ id: "synthetic", name: "tldr", args: { needs_you: true } })).toBe(true);
		expect(
			planQuietRuns([{ role: "user", text: "[Role message synthetic]", stamp: { kind: "report" } }])[0].visible,
		).toBe(true);
		expect(planQuietRuns([{ role: "user", text: "Synthetic plugin brief" }])[0].visible).toBe(true);
	});
});

describe("stage 4: normal Telegram pre-send decision", () => {
	it("only verified Telegram chains or the existing brief exception can send", () => {
		const callback = { cause: "role", forOwner: true, ownerChannel: "telegram" };
		expect(replyMayGoToTelegram(callback, { knownOwner: true })).toBe(true);
		expect(replyMayGoToTelegram(callback, { knownOwner: false })).toBe(false);
		for (const ownerChannel of ["browser", null, "unknown"])
			expect(replyMayGoToTelegram({ ...callback, ownerChannel }, { knownOwner: true })).toBe(false);
		expect(replyMayGoToTelegram({ cause: "role", forOwner: false }, { knownOwner: true })).toBe(false);
		expect(replyMayGoToTelegram({ cause: "telegram" }, { knownOwner: false })).toBe(false);
		expect(replyMayGoToTelegram({ cause: "role", forOwner: true }, { knownOwner: true })).toBe(true); // verified legacy Telegram thread
		expect(replyMayGoToTelegram({ cause: "plugin" }, { brief: true })).toBe(true);
		expect(replyMayGoToTelegram({ cause: "plugin" }, { brief: false })).toBe(false);
	});
});

describe("integration: sealed metadata full chain", () => {
	it.each(["browser", "telegram", "peer", "untrusted"] as const)(
		"%s → question → nested question → nested callback → owner callback",
		async (channel) => {
			const f = fixture();
			const root = newTurnRecord();
			const sends: Array<{ recipient: string; thread: number }> = [];
			const storage = new Map();
			const chat = createChat({
				ownerId: "4242",
				routeTo: "coo",
				now: () => now,
				storage: { get: (k: string) => storage.get(k), set: (k: string, v: unknown) => storage.set(k, v) },
				api: {
					call: async (method: string, params: { chat_id?: string; reply_parameters?: { message_id: number } }) => {
						if (method === "sendMessage")
							sends.push({ recipient: String(params.chat_id), thread: params.reply_parameters?.message_id ?? 0 });
						return { message_id: 123 };
					},
				},
				roles: {
					send: async (_role: string, _text: string, opts: { via: string }) => {
						collectRoleInput(root, {
							cause: opts.via === "telegram" ? "telegram" : "plugin",
							ownerChannel: opts.via === "telegram" ? "telegram" : undefined,
							sendId,
						});
						return { ok: true, id: sendId };
					},
				},
				setTimer: () => setTimeout(() => {}, 0),
				clearTimer: clearTimeout,
				sleep: async () => {},
			});
			if (channel === "telegram") {
				chat.fromOwner({ message_id: 77 }, "Synthetic owner input");
				await new Promise<void>((resolve) => setImmediate(resolve));
				await chat.idle();
			}
			if (channel === "browser") collectRoleInput(root, browserRoleInput(true, false));
			if (channel === "untrusted") collectRoleInput(root, browserRoleInput(false, false));
			const q = f.send("coo", root, { to: "beta", kind: "question", text: "Synthetic question" });
			const beta = await f.take(q.id);
			const nested = f.send("beta", beta.turn, { to: "gamma", kind: "question", text: "Synthetic nested question" });
			const gamma = await f.take(nested.id);
			const inner = f.send("gamma", gamma.turn, {
				to: "beta",
				kind: "reply",
				replyTo: nested.id,
				text: "Synthetic nested reply",
			});
			const innerCallback = await f.take(inner.id);
			const reply = f.send("beta", innerCallback.turn, {
				to: "coo",
				kind: "reply",
				replyTo: q.id,
				text: "Synthetic reply",
			});
			const callback = await f.take(reply.id);
			const isOwner = channel === "browser" || channel === "telegram";
			expect(visible(f, innerCallback)).toBe(isOwner);
			expect(visible(f, callback)).toBe(isOwner);
			expect(q.forOwner === true).toBe(isOwner);
			expect(nested.forOwner === true).toBe(isOwner);
			expect(ownerTurnOf(callback.turn)?.ownerChannel).toBe(isOwner ? channel : undefined);
			callback.turn.text = "Synthetic final";
			chat.onReply(roleReplyOf(f.files.coo, callback.turn, f.roles, now));
			await chat.idle();
			expect(sends).toEqual(channel === "telegram" ? [{ recipient: "4242", thread: 77 }] : []);
			chat.close();
		},
	);
});
