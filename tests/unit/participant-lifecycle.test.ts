import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParticipantLifecycle, type ParticipantTarget } from "../../server/participant-lifecycle.js";
import { PluginManager } from "../../server/plugins.js";

const qa = { sessionId: "qa-session", role: "qa" };
const architecture = { sessionId: "architecture-session", role: "architecture" };
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("passive participant lifecycle", () => {
	it("coalesces concurrent reads and keeps the exact current assignments", async () => {
		const gate = deferred();
		const open = vi.fn(async () => {
			await gate.promise;
		});
		const lifecycle = new ParticipantLifecycle(open);
		let bindings = [qa, architecture];
		const lease = lifecycle.register(() => bindings);
		const a = lease.refresh();
		const b = lease.refresh();
		await Promise.resolve();
		expect(a).toBe(b);
		expect(open).toHaveBeenCalledTimes(1);
		expect(lifecycle.has(qa.sessionId, qa.role)).toBe(true);
		expect(lifecycle.has(qa.sessionId, "design")).toBe(false);
		gate.resolve();
		await Promise.all([a, b]);
		expect(open.mock.calls).toHaveLength(2);
		bindings = [];
		expect(lifecycle.has(qa.sessionId, qa.role)).toBe(false);
	});

	it("invalidates in-flight recovery and processes a replacement without using stale bindings", async () => {
		const gate = deferred();
		const seen: string[] = [];
		let currentGuard!: () => boolean;
		const lifecycle = new ParticipantLifecycle(async (target, current) => {
			if (target === undefined) throw new Error("bad target");
			if (target.sessionId === qa.sessionId) {
				currentGuard = current;
				await gate.promise;
			}
			if (current()) seen.push(target.sessionId);
		});
		let bindings = [qa];
		const lease = lifecycle.register(() => bindings);
		const a = lease.refresh();
		await Promise.resolve();
		bindings = [architecture];
		const b = lease.refresh();
		expect(currentGuard()).toBe(false);
		gate.resolve();
		await Promise.all([a, b]);
		expect(seen).toEqual([architecture.sessionId]);
	});

	it("revokes guards on plugin disposal, including a pending open", async () => {
		const gate = deferred();
		let current!: () => boolean;
		const lifecycle = new ParticipantLifecycle(async (_target, guard) => {
			current = guard;
			await gate.promise;
		});
		const lease = lifecycle.register(() => [qa]);
		const pending = lease.refresh();
		await Promise.resolve();
		lease.dispose();
		expect(current()).toBe(false);
		gate.resolve();
		await pending;
		await lease.refresh();
		expect(lifecycle.has(qa.sessionId, qa.role)).toBe(false);
		lifecycle.dispose();
		expect(() => lifecycle.register(() => [qa])).toThrow("stopped");
	});

	it("deduplicates, fails closed on role conflicts, and rejects malformed targets", async () => {
		const seen: ParticipantTarget[] = [];
		const lifecycle = new ParticipantLifecycle(async (target) => {
			seen.push(target);
		});
		lifecycle.register(() => [qa, qa]);
		const lease = lifecycle.register(
			() =>
				[
					{ ...qa, role: "design" },
					architecture,
					{ sessionId: "../escape", role: "qa" },
					{ sessionId: undefined, role: "qa" },
					{ sessionId: "valid", role: undefined },
				] as unknown as ParticipantTarget[],
		);
		await lease.refresh();
		expect(seen).toEqual([architecture]);
		expect(lifecycle.has(qa.sessionId, qa.role)).toBe(false);
	});

	it("isolates missing/corrupt targets and retries only on a later explicit refresh", async () => {
		const seen: string[] = [];
		const lifecycle = new ParticipantLifecycle(async (target) => {
			seen.push(target.sessionId);
			if (target.sessionId === qa.sessionId) throw new Error("missing");
		});
		const lease = lifecycle.register(() => [qa, architecture]);
		await lease.refresh();
		expect(seen).toEqual([qa.sessionId, architecture.sessionId]);
		await lease.refresh();
		expect(seen).toHaveLength(4);
	});

	it("a broken source cannot retain its previous assignments", () => {
		let broken = false;
		const lifecycle = new ParticipantLifecycle(async () => {});
		lifecycle.register(() => {
			if (broken) throw new Error("closed");
			return [qa];
		});
		expect(lifecycle.has(qa.sessionId, qa.role)).toBe(true);
		broken = true;
		expect(lifecycle.has(qa.sessionId, qa.role)).toBe(false);
	});
});

describe("participant capability is owned by the plugin effect lifetime", () => {
	let root: string | undefined;
	let manager: PluginManager | undefined;
	afterEach(() => {
		manager?.dispose();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("requires the participants grant and releases a stale lease when deactivated", async () => {
		root = mkdtempSync(join(tmpdir(), "participant-capability-"));
		manager = new PluginManager(root, root);
		const lifecycle = new ParticipantLifecycle(async () => {});
		const registered = vi.fn((source: () => ParticipantTarget[]) => lifecycle.register(source));
		manager.participantRouteRetainer = registered;
		for (const [id, permissions] of [
			["permitted", ["participants"]],
			["denied", ["chat"]],
		] as const) {
			const dir = join(root, "plugins", id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, apiVersion: 2, permissions }));
			writeFileSync(
				join(dir, "index.mjs"),
				`export default { activate(host) { host.retainParticipantRoutes(() => [{sessionId: "${id}", role: "qa"}]); } };`,
			);
		}
		const loaded = await manager.ensureLoaded();
		expect(loaded.every((p) => !p.error)).toBe(true);
		expect(registered).toHaveBeenCalledTimes(1);
		expect(lifecycle.has("permitted", "qa")).toBe(true);
		expect(lifecycle.has("denied", "qa")).toBe(false);
		manager.dispose();
		expect(lifecycle.has("permitted", "qa")).toBe(false);
	});
});
