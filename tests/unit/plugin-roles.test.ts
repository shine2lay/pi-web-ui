/**
 * telegram-coo: host.roles (server/plugins.ts) through the real PluginManager. A plugin that declares
 * "roles" sends into a role's home chat (as Telegram or as itself) and hears the replies; one that
 * doesn't gets a plain refusal and hears nothing; unloading a plugin stops its listener.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginManager, type PluginHost } from "../../server/plugins.js";
import type { RoleReply } from "../../server/role-replies.js";

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

const reply = (over: Partial<RoleReply> = {}): RoleReply => ({
	role: "coo",
	file: "/s/coo.jsonl",
	text: "Here you go.",
	cause: "telegram",
	at: 5,
	ids: ["rs-1"],
	...over,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "plugin-roles-test-"));
	(globalThis as unknown as { __hosts: Record<string, PluginHost> }).__hosts = {};
	mgr = new PluginManager(dir, dir);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	mgr.dispose();
	rmSync(dir, { recursive: true, force: true });
});

describe("host.roles.send", () => {
	it('with "roles": hands the text to the server with who it is for', async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["roles"] });
		await mgr.ensureLoaded();
		const got: Array<{ role: string; text: string; via: string; queued: boolean }> = [];
		mgr.roleSender = async (role, text, opts) => {
			got.push({ role, text, via: opts.via, queued: typeof opts.onQueued === "function" });
			opts.onQueued?.();
			return { ok: true, id: "rs-9" };
		};
		let queued = 0;
		const h = hosts().tg!;
		expect(await h.roles.send("coo", "\ud83d\udcf1 hi", { via: "telegram", onQueued: () => queued++ })).toEqual({
			ok: true,
			id: "rs-9",
		});
		// Anything but "telegram" is the plugin itself.
		expect(await h.roles.send("coo", "brief please")).toEqual({ ok: true, id: "rs-9" });
		expect(got).toEqual([
			{ role: "coo", text: "\ud83d\udcf1 hi", via: "telegram", queued: true },
			{ role: "coo", text: "brief please", via: "plugin", queued: false },
		]);
		expect(queued).toBe(1);
	});

	it("without the permission: a plain refusal, nothing sent", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["asks"] });
		await mgr.ensureLoaded();
		let sent = 0;
		mgr.roleSender = async () => {
			sent++;
			return { ok: true, id: "rs-1" };
		};
		expect(await hosts().tg!.roles.send("coo", "hi")).toEqual({
			ok: false,
			error: 'the plugin did not declare permission "roles"',
		});
		expect(sent).toBe(0);
	});

	it("never throws: no server wired, or a server that fails", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["roles"] });
		await mgr.ensureLoaded();
		const h = hosts().tg!;
		expect(await h.roles.send("coo", "hi")).toEqual({ ok: false, error: "roles aren't available here" });
		mgr.roleSender = async () => {
			throw new Error("boom");
		};
		expect(await h.roles.send("coo", "hi")).toEqual({ ok: false, error: "boom" });
	});

	it("an onQueued that throws doesn't break the send", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["roles"] });
		await mgr.ensureLoaded();
		mgr.roleSender = async (_r, _t, opts) => {
			opts.onQueued?.();
			return { ok: true, id: "rs-2" };
		};
		const r = await hosts().tg!.roles.send("coo", "hi", {
			onQueued: () => {
				throw new Error("boom");
			},
		});
		expect(r).toEqual({ ok: true, id: "rs-2" });
	});
});

describe("host.roles.onReply", () => {
	it('with "roles": hears every reply, each with its own copy of the ids', async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["roles"] });
		await mgr.ensureLoaded();
		const heard: RoleReply[] = [];
		hosts().tg!.roles.onReply((r) => {
			heard.push(r);
			r.ids.push("changed");
		});
		const r = reply();
		mgr.emitRoleReply(r);
		expect(heard).toHaveLength(1);
		expect(heard[0]).toMatchObject({ role: "coo", text: "Here you go.", cause: "telegram", at: 5 });
		expect(r.ids).toEqual(["rs-1"]);
	});

	it("without the permission: hears nothing", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["asks"] });
		await mgr.ensureLoaded();
		const heard: RoleReply[] = [];
		hosts().tg!.roles.onReply((r) => heard.push(r));
		mgr.emitRoleReply(reply());
		expect(heard).toEqual([]);
		expect(mgr.roleReplyHandlers.size).toBe(0);
	});

	it("stops listening when the plugin stops it or unloads", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["roles"] });
		await mgr.ensureLoaded();
		const h = hosts().tg!;
		const off = h.roles.onReply(() => {});
		expect(mgr.roleReplyHandlers.size).toBe(1);
		off();
		expect(mgr.roleReplyHandlers.size).toBe(0);
		h.roles.onReply(() => {});
		expect(mgr.roleReplyHandlers.size).toBe(1);
		mgr.dispose();
		expect(mgr.roleReplyHandlers.size).toBe(0);
	});

	it("a listener that throws doesn't stop the others", async () => {
		makePlugin("tg", { apiVersion: 2, permissions: ["roles"] });
		await mgr.ensureLoaded();
		const h = hosts().tg!;
		const heard: string[] = [];
		h.roles.onReply(() => {
			throw new Error("boom");
		});
		h.roles.onReply((r) => heard.push(r.cause));
		mgr.emitRoleReply(reply({ cause: "plugin" }));
		expect(heard).toEqual(["plugin"]);
	});
});
