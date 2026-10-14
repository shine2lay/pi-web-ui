// #175 H-LEASE-1: real timers carry Node's async context; promise barriers fix the race.
// Only synthetic files and fake chat delivery. Never starts a chat or calls a model.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IdentityDef } from "../../server/identities.js";
import {
	GuardLease,
	RoleMessageGuardHost,
	type GuardDecisionEvent,
	type RoleMessageGuardSendResult,
} from "../../server/role-message-guard-host.js";
import type { GuardStoreState } from "../../server/role-message-guard-contract.js";
import type {
	GuardFileBoundary,
	GuardFileStore,
	GuardFileStoreOptions,
	GuardLegacyFile,
} from "../../server/role-message-guard-store.js";
import { RoleMessages, type RoleMessageRecord, type RoleMessageSender } from "../../server/role-messages.js";

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

// Test-only access to existing native/store seams; no production fault-injection switch.
type TestStoreOptions = { -readonly [K in keyof GuardFileStoreOptions]: GuardFileStoreOptions[K] };
interface Internals {
	lease: GuardLease;
	store: GuardFileStore;
	appendDecision(event: GuardDecisionEvent): void;
	saveQuestions(): void;
	rotate(force: boolean): Promise<void>;
}
async function world() {
	const dir = mkdtempSync(join(tmpdir(), "guard-lease-175-"));
	const now = Date.parse("2026-10-13T12:00:00Z");
	const files = Object.fromEntries(
		["alpha", "beta", "coo"].map((role) => {
			const file = join(dir, `${role}.jsonl`);
			writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: role, cwd: dir })}\n`);
			return [role, file];
		}),
	);
	const roles = Object.entries(files).map(
		([id, homeChat]) => ({ id, title: id, homeChat, pastHomeChats: [], raw: {} }) as unknown as IdentityDef,
	);
	const delivered = deferred();
	const notified = deferred();
	const w = {
		dir,
		files,
		turn: undefined as (() => Promise<void>) | undefined,
		change: undefined as (() => void) | undefined,
		sent: undefined as ((record: RoleMessageRecord) => void) | undefined,
		got: [] as Array<{ file: string; via: "deliver" | "note" }>,
		call: 0,
	};
	const rm = new RoleMessages(
		join(dir, "role-messages.json"),
		{
			roles: () => roles,
			chatState: () => "working", // #156 still admits mail; the fake host supplies the run boundary.
			deliver: async (file, text) => {
				w.got.push({ file, via: "deliver" });
				appendFileSync(file, `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`);
				delivered.resolve();
				await w.turn?.();
				return { ok: true };
			},
			note: async (file) => {
				w.got.push({ file, via: "note" });
				return { ok: true };
			},
			changed: () => {
				notified.resolve();
				w.change?.();
			},
			sent: (record) => w.sent?.(record),
			log: () => {},
		},
		() => now,
	);
	const host = new RoleMessageGuardHost({
		dir: join(dir, "guard"),
		roleMessages: () => rm,
		identities: () => roles,
		now: () => now,
		rotateBytes: Number.MAX_SAFE_INTEGER,
		log: () => {},
	});
	cleanups.push(
		() => rmSync(dir, { recursive: true, force: true }),
		() => host.stop(),
		() => rm.stop(),
	);
	await host.start();
	expect(host.state.status).toBe("ready");
	const internals = host as unknown as Internals;
	const options = Reflect.get(internals.store, "options") as TestStoreOptions;
	const sender = (role: string): RoleMessageSender => ({
		role,
		title: role,
		chat: "synthetic home",
		file: files[role],
		handling: 0,
		guard: { bindingId: files[role], isHome: true, lastUserText: "" },
	});
	const send = (from: string, to = "coo", kind: "request" | "fyi" = "fyi") =>
		host.send(sender(from), { to, kind, text: "synthetic fixture" }, `call-${++w.call}`);
	const copies = () => {
		const journal = JSON.parse(readFileSync(options.journalPath, "utf8")) as {
			state: GuardStoreState;
			legacy: GuardLegacyFile;
		};
		const accepted = JSON.parse(readFileSync(options.legacyPath, "utf8")) as GuardLegacyFile;
		return { journal, accepted };
	};
	return { ...w, rm, host, internals, options, sender, send, copies, delivered, notified, hooks: w };
}

async function race(point: GuardFileBoundary, source: "delivery" | "changed" = "delivery") {
	const w = await world();
	const startB = deferred();
	const resultB = deferred<RoleMessageGuardSendResult>();
	const attemptedB = deferred();
	const pausedA = deferred();
	const releaseA = deferred();
	let paused = false;
	let crossed = false;
	const turn = async () => {
		await startB.promise;
		try {
			resultB.resolve(await w.send("beta"));
		} catch (error) {
			resultB.reject(error);
		}
	};
	if (source === "delivery") w.hooks.turn = turn;
	else {
		w.hooks.change = () => {
			w.hooks.change = undefined;
			void turn();
		};
	}
	expect(await w.send("alpha", "beta", "request")).toMatchObject({ ok: true });
	if (source === "delivery") await w.delivered.promise;
	else await w.notified.promise;

	let armed = true;
	w.options.boundary = async (at) => {
		if (!armed || at !== point) return;
		armed = false;
		paused = true;
		pausedA.resolve();
		await releaseA.promise;
		paused = false;
	};
	const resultA = w.send("alpha");
	await pausedA.promise;
	const exclusive = w.options.withExclusive;
	w.options.withExclusive = (work) => {
		const result = exclusive(async () => {
			if (paused) crossed = true;
			return work();
		});
		attemptedB.resolve(); // synchronous: whether the work entered is already known here.
		return result;
	};
	startB.resolve();
	await attemptedB.promise;
	let early: RoleMessageGuardSendResult | undefined;
	try {
		// Negative control: let the bypassing writer finish while A remains paused. The fixed writer
		// cannot enter, so we must release A before awaiting B (no timer-based pending assertion).
		if (crossed) early = await resultB.promise;
	} finally {
		releaseA.resolve();
	}
	const [a, b] = await Promise.all([resultA, resultB.promise]);
	const { journal, accepted } = w.copies();
	const ids = [a, b].flatMap((r) => (r.ok ? [r.record.id] : []));
	console.log(
		`H-LEASE-1 ${point}/${source}: crossed=${crossed}, A=${a.ok}, B=${b.ok}, journal=${journal.legacy.messages.length}, accepted=${accepted.messages.length}${early && !early.ok ? `, refusal=${early.error}` : ""}`,
	);
	expect.soft(crossed, "B must queue, never enter during A's transaction").toBe(false);
	expect.soft(a).toMatchObject({ ok: true });
	expect.soft(b).toMatchObject({ ok: true });
	expect.soft(journal.legacy.messages).toHaveLength(3); // seed plus A and B
	expect.soft(accepted.messages).toHaveLength(3);
	expect.soft(journal.state.usage).toHaveLength(3);
	expect.soft(journal.state.outbox).toHaveLength(3);
	for (const id of ids) {
		expect
			.soft(
				journal.legacy.messages.some((m) => m.id === id),
				`journal message ${id}`,
			)
			.toBe(true);
		expect
			.soft(
				accepted.messages.some((m) => m.id === id),
				`accepted message ${id}`,
			)
			.toBe(true);
		const out = journal.state.outbox.find((o) => o.message.id === id);
		expect.soft(out, `outbox ${id}`).toBeDefined();
		expect
			.soft(
				journal.state.usage.some((u) => u.transactionId === out?.receipt.transactionId),
				`charge ${id}`,
			)
			.toBe(true);
		expect.soft(w.rm.byId(id), `native message ${id}`).toBeDefined();
	}
}

describe("#175 H-LEASE-1: a delivered chat is not the lease owner", () => {
	it("waits between journal commit and accepted publication", async () => {
		await race("commit:directory_flush");
	});
	it("keeps both writers' messages, charges and outbox after both could have passed ready", async () => {
		await race("prepare:write");
	});
	it("also detaches the deferred page-change callback created by admit's save", async () => {
		await race("commit:directory_flush", "changed");
	});
	it("keeps synchronous admit -> sent nesting, question/decision saves and rotation re-entrant", async () => {
		const w = await world();
		const order: string[] = [];
		let nested: Promise<void> | undefined;
		w.hooks.sent = () => {
			order.push("sent");
			nested = w.internals.lease.run(async () => {
				order.push("decision");
				w.internals.appendDecision({
					eventId: "synthetic-nested-decision",
					kind: "role",
					bindingDigest: "synthetic-binding",
					choice: "deny",
					reason: "synthetic",
					answeredAt: 1,
				});
				await w.internals.lease.run(async () => {
					order.push("questions");
					w.internals.saveQuestions();
				});
				order.push("saved");
			});
			order.push("sent-return");
		};
		expect(await w.send("alpha")).toMatchObject({ ok: true });
		await nested;
		expect(order).toEqual(["sent", "decision", "questions", "sent-return", "saved"]);
		await w.internals.lease.run(async () => {
			order.push("outer");
			await w.internals.lease.run(async () => w.internals.rotate(false));
			order.push("rotated");
		});
		expect(order.slice(-2)).toEqual(["outer", "rotated"]);
		expect(JSON.parse(readFileSync(join(w.dir, "guard", "current.json"), "utf8"))).toEqual({ gen: 2 });
		expect(readFileSync(join(w.dir, "guard", "decisions.jsonl"), "utf8")).toContain("synthetic-nested-decision");
	});
	it("keeps zero-delay kicks, the 300 ms list debounce, and ordinary working-chat delivery", async () => {
		const timer = vi.spyOn(globalThis, "setTimeout");
		const w = await world();
		expect(await w.send("alpha", "beta", "request")).toMatchObject({ ok: true });
		await w.delivered.promise;
		await w.notified.promise;
		expect(w.got).toEqual([{ file: w.files.beta, via: "deliver" }]);
		expect(timer.mock.calls.filter(([, ms]) => ms === 300)).toHaveLength(1);
		expect(timer.mock.calls.some(([, ms]) => ms === 0)).toBe(true);
		expect(w.copies().accepted.messages).toHaveLength(1);
	});
});
