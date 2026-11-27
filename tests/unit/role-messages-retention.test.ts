import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { RoleMessages, ROLE_MESSAGES_KEEP, type RoleMessageHost, type RoleMessagePersistence, type RoleMessageRecord } from "../../server/role-messages.js";
import { parseRoleMessagesSource, readRoleMessagesSource } from "../../server/role-messages-source.js";

const now = 2_000_000_000_000;
const dirs: string[] = [];
const stores: RoleMessages[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.stop();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function row(id: string, patch: Partial<RoleMessageRecord> = {}): RoleMessageRecord {
	return { id, at: now - 86_400_000, from: { role: "alpha", title: "Alpha", chat: "home chat", file: "/alpha" },
		to: { role: "beta", title: "Beta" }, kind: "request", chain: 1, text: "fixture", state: "delivered", sends: 1, attempts: 0, ...patch };
}
function setup(rows: RoleMessageRecord[], overrides: Partial<RoleMessageHost> = {}) {
	let saved: RoleMessageRecord[] = [];
	const host: RoleMessageHost = { roles: () => [], chatState: () => "idle", deliver: async () => ({ ok: false, error: "unused" }), log: () => {}, ...overrides };
	const persistence: RoleMessagePersistence = {
		read: file => file.endsWith("-chains.jsonl") ? "" : JSON.stringify({ v: 1, paused: false, messages: rows }),
		rename: () => {}, saveStore: (_file, data) => { saved = (data as { messages: RoleMessageRecord[] }).messages; },
		appendChains: () => {}, replaceChains: () => {},
	};
	const store = new RoleMessages("/fixture/messages.json", host, () => now, undefined, persistence);
	stores.push(store);
	return { store, save: () => {
		(store as unknown as { save(schedule: (fn: () => void) => void): void }).save(() => {});
		return saved;
	} };
}
const history = () => Array.from({ length: ROLE_MESSAGES_KEEP }, (_, i) => row(`history-${i}`, { kind: "fyi" }));

it("RoleMessages.save retains delivered unanswered questions and requests beyond KEEP", () => {
	const rows = Array.from({ length: ROLE_MESSAGES_KEEP + 1 }, (_, i) => row(`open-${i}`, { kind: i % 2 ? "question" : "request" }));
	expect(setup(rows).save().map(r => r.id)).toEqual(rows.map(r => r.id));
});
it("RoleMessages.save still rotates closed history and failed obligations", () => {
	const rows = [row("failed", { state: "failed" }), ...history()];
	const saved = setup(rows).save();
	expect(saved).toHaveLength(ROLE_MESSAGES_KEEP);
	expect(saved.some(r => r.id === "failed")).toBe(false);
});
it.each(["original", "reply"])("RoleMessages.save pins both accepted payloads from pending %s evidence", pinned => {
	const original = row("original", { state: "replied", replyId: "reply" });
	const reply = row("reply", { kind: "reply", replyTo: "original", from: { ...original.from, role: "beta" }, to: { role: "alpha", title: "Alpha" } });
	const fixture = setup([original, reply, ...history()], { retentionPins: () => new Set([pinned]) });
	expect(fixture.save().map(r => r.id)).toEqual(expect.arrayContaining(["original", "reply"]));
});
it("RoleMessages.save preserves original while its accepted reply awaits delivery", () => {
	const original = row("original", { state: "replied", replyId: "reply" });
	const reply = row("reply", { kind: "reply", state: "waiting", replyTo: original.id, from: { ...original.from, role: "beta" }, to: original.from });
	expect(setup([original, reply, ...history()]).save().map(r => r.id)).toEqual(expect.arrayContaining(["original", "reply"]));
});
it("RoleMessages.save fails safe if the canonical retention projection is unreadable", () => {
	const rows = [row("old", { kind: "fyi" }), ...history()];
	expect(setup(rows, { retentionPins: () => { throw new Error("unknown"); } }).save()).toHaveLength(rows.length);
});
it("RoleMessages.save can rotate a completed pair together after its pins clear", () => {
	const original = row("original", { state: "replied", replyId: "reply" });
	const reply = row("reply", { kind: "reply", replyTo: original.id, from: { ...original.from, role: "beta" }, to: original.from });
	expect(setup([original, reply, ...history()]).save().map(r => r.id)).not.toEqual(expect.arrayContaining(["original", "reply"]));
});
it("readRoleMessagesSource reads every row, including beyond KEEP", () => {
	const dir = mkdtempSync(join(tmpdir(), "role-source-")); dirs.push(dir);
	const file = join(dir, "messages.json");
	const rows = Array.from({ length: ROLE_MESSAGES_KEEP + 5 }, (_, i) => row(`open-${i}`));
	writeFileSync(file, JSON.stringify({ v: 1, paused: false, messages: rows }));
	expect(readRoleMessagesSource(file)).toHaveLength(rows.length);
	expect(() => readRoleMessagesSource(join(dir, "missing.json"))).toThrow();
	writeFileSync(file, "{");
	expect(() => readRoleMessagesSource(file)).toThrow();
});
it.each([
	{ v: 2, paused: false, messages: [] },
	{ v: 1, messages: [] },
	{ v: 1, paused: false, messages: [row("x"), row("x")] },
	{ v: 1, paused: false, messages: [row("x", { state: "bogus" as never })] },
	{ v: 1, paused: false, messages: [row("x"), { id: "broken" }] },
])("parseRoleMessagesSource refuses malformed whole sources rather than returning partial/empty data %#", data => {
	expect(() => parseRoleMessagesSource(JSON.stringify(data))).toThrow();
});

for (const path of ["tick", "resume"] as const) {
	for (const mode of ["default", "reverse", "throw", "duplicate", "clone", "missing"] as const) {
		it(`RoleMessages ${path} waiting ordering: ${mode}`, async () => {
			const rows = [row("a", { state: "waiting", at: now - 2 }), row("b", { state: "waiting", at: now - 1 })];
			const orderWaiting: RoleMessageHost["orderWaiting"] = mode === "default" ? undefined : async records => {
				if (mode === "throw") throw new Error("unknown");
				if (mode === "duplicate") return [records[0], records[0]];
				if (mode === "clone") return records.map(r => ({ ...r }));
				if (mode === "missing") return records.slice(1);
				return [...records].reverse();
			};
			const { store } = setup(rows, { orderWaiting });
			const internals = store as unknown as { step(r: RoleMessageRecord): Promise<void>; route(r: RoleMessageRecord): Promise<{ file: string }> };
			const observed: string[] = [];
			vi.spyOn(internals, "step").mockImplementation(async r => { observed.push(r.id); });
			vi.spyOn(internals, "route").mockResolvedValue({ file: "/home-target" });
			if (path === "resume") { store.deferUntilStart(); await store.beforeResume("/home-target", { deliver: async () => ({ ok: false, error: "unused" }) }); }
			else await store.tick();
			expect(observed).toEqual(mode === "reverse" ? ["b", "a"] : ["a", "b"]);
		});
	}
}
