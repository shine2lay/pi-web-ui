/**
 * telegram-answers: host.asks (server/plugins.ts) through the real PluginManager. A plugin that
 * declares "asks" sees what chats wait on you for, hears changes and answers as itself; one
 * that doesn't sees nothing; unloading a plugin stops its listener (so a chat with no browser
 * open no longer waits for it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import { askHub, type Ask, type AskEvent, type AskFieldAnswer } from "../../server/asks.js";

let dir: string;
let mgr: PluginManager;
const hosts = () => (globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts;

function makePlugin(id: string, manifest: Record<string, unknown>): void {
	const pdir = join(dir, "plugins", id);
	mkdirSync(pdir, { recursive: true });
	writeFileSync(join(pdir, "manifest.json"), JSON.stringify({ name: id, ...manifest }));
	writeFileSync(
		join(pdir, "index.mjs"),
		`export default { activate(h) { (globalThis.__hosts ??= {})["${id}"] = h; } };`,
	);
}

const ask = (id: string): Ask => ({
	id,
	kind: "question",
	createdAt: 1,
	conversationTitle: "Chat",
	title: "Pick one",
	fields: [
		{
			id: "q0",
			text: "Which?",
			options: [
				{ value: "A", label: "A" },
				{ value: "B", label: "B" },
			],
			multi: false,
			allowText: true,
		},
	],
});

/** Add an ask whose owner settles it as answered, and remember what it was given. */
function addAnswerable(id: string) {
	const got: Array<{ answers: AskFieldAnswer[]; from: string }> = [];
	askHub.add(ask(id), (answers, from) => {
		got.push({ answers, from });
		askHub.settle(id, { how: "answered", summary: answers[0]?.selected[0] ?? "", from });
		return { ok: true };
	});
	return got;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-asks-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	for (const a of askHub.list()) askHub.settle(a.id, { how: "gone", reason: "test over" });
	rmSync(dir, { recursive: true, force: true });
});

describe("host.asks", () => {
	it('with "asks": lists copies, hears changes, and answers as the plugin', async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["asks"] });
		await mgr.ensureLoaded();
		const h = hosts().tg!;
		const events: AskEvent[] = [];
		h.asks.on((ev) => events.push(ev));
		expect(askHub.listening).toBe(true);

		const got = addAnswerable("a1");
		expect(h.asks.list().map((a) => a.id)).toEqual(["a1"]);
		// A copy: changing it doesn't change the shared ask.
		h.asks.list()[0]!.title = "changed";
		events[0]!.ask.title = "changed too";
		expect(askHub.get("a1")?.title).toBe("Pick one");

		expect(await h.asks.answer("a1", [{ id: "q0", selected: ["A"] }])).toEqual({ ok: true });
		expect(got).toEqual([{ answers: [{ id: "q0", selected: ["A"] }], from: "tg" }]);
		expect(events.map((e) => e.type)).toEqual(["appeared", "answered"]);
		expect(events[1]).toMatchObject({ type: "answered", summary: "A", from: "tg" });

		// The first answer won; a late one is told so.
		expect(await h.asks.answer("a1", [{ id: "q0", selected: ["B"] }])).toEqual({
			ok: false,
			error: "no longer waiting",
		});
		// A wrong answer is refused before the owner sees it.
		addAnswerable("a2");
		expect((await h.asks.answer("a2", [{ id: "q0", selected: ["C"] }])).ok).toBe(false);
		expect(askHub.get("a2")).toBeDefined();
	});

	it('without "asks": nothing to see, hear or answer', async () => {
		makePlugin("np", { apiVersion: 2, permissions: ["ui"] });
		await mgr.ensureLoaded();
		const h = hosts().np!;
		addAnswerable("b1");
		const heard: AskEvent[] = [];
		const off = h.asks.on((ev) => heard.push(ev));
		expect(typeof off).toBe("function");
		expect(askHub.listening).toBe(false);
		expect(h.asks.list()).toEqual([]);
		const r = await h.asks.answer("b1", [{ id: "q0", selected: ["A"] }]);
		expect(r.ok).toBe(false);
		expect(r.error).toContain("asks");
		expect(askHub.get("b1")).toBeDefined();
		expect(heard).toEqual([]);
	});

	it("stops listening when the plugin stops it or unloads", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["asks"] });
		await mgr.ensureLoaded();
		const h = hosts().tg!;
		const off = h.asks.on(() => {});
		expect(askHub.listening).toBe(true);
		off();
		expect(askHub.listening).toBe(false);
		h.asks.on(() => {});
		expect(askHub.listening).toBe(true);
		mgr.dispose();
		expect(askHub.listening).toBe(false);
	});

	it("a listener that throws doesn't stop the others", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["asks"] });
		await mgr.ensureLoaded();
		const h = hosts().tg!;
		const heard: string[] = [];
		h.asks.on(() => {
			throw new Error("boom");
		});
		h.asks.on((ev) => heard.push(ev.type));
		addAnswerable("c1");
		expect(heard).toEqual(["appeared"]);
	});
});
