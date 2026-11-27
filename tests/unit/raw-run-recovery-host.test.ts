import { describe, expect, it } from "vitest";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { installRawRunRecoveryHost } from "../../server/raw-run-recovery-host.js";

describe("host recovery admission", () => {
	function fixture() {
		const events: string[] = [];
		const session = {
			isStreaming: false,
			sessionManager: {
				getSessionId: () => "isolated",
				getLeafId: () => "leaf",
				buildSessionProjection: () => ({ entries: [] }),
				getBranch: () => [],
				getEntry: (id: string) => ({ id, type: "custom" }),
				appendContextEdit: () => {
					events.push("append");
					return "edit";
				},
			},
			refreshContext: () => events.push("refresh"),
			prompt: async () => {
				events.push("prompt");
			},
			abort: async () => {
				events.push("abort");
			},
			agent: {
				state: { isStreaming: false },
				prompt: async () => {
					events.push("request");
				},
				continue: async () => {
					events.push("next");
				},
				finishTurn: async () => {
					events.push("boundary");
					return { action: "continue" };
				},
			},
		};
		const gate = installRawRunRecoveryHost(session as any);
		return { session, events, gate };
	}
	it("holds prompt, continuation and request until recovered, refreshes before release", async () => {
		const { session, events, gate } = fixture();
		let held = true;
		gate.register(() => ({
			recover: async () => {
				events.push("recover");
				return { held };
			},
		}));
		await expect(session.prompt()).rejects.toThrow("E_RAW_RUN_RECOVERY_HELD");
		await expect(session.agent.prompt()).rejects.toThrow("E_RAW_RUN_RECOVERY_HELD");
		await expect(session.agent.continue()).rejects.toThrow("E_RAW_RUN_RECOVERY_HELD");
		expect(events).toEqual(["recover", "recover", "recover"]);
		held = false;
		await session.prompt();
		await session.agent.continue();
		await session.agent.prompt();
		expect(events.slice(3)).toEqual([
			"recover",
			"refresh",
			"prompt",
			"recover",
			"refresh",
			"next",
			"recover",
			"refresh",
			"request",
		]);
	});
	it("an older waiter cannot clear a newer recovery promise", async () => {
		const { session, gate } = fixture();
		const context = new AsyncLocalStorage<string>();
		const labels = new Map<number, string>();
		const releases: Array<() => void> = [];
		gate.register(() => ({
			recover: () => new Promise<{ held: boolean }>((resolve) => releases.push(() => resolve({ held: false }))),
		}));
		let c: Promise<void> | undefined, d: Promise<void> | undefined;
		let ready = false;
		let notifyStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		// External scheduling probe: enter C immediately before B's old await resumes.
		// A already released P. C now owns Q; B must not clear Q on its way out.
		const hook = createHook({
			init(id) {
				const label = context.getStore();
				if (label) labels.set(id, label);
			},
			before(id) {
				if (ready && labels.get(id) === "B") {
					hook.disable();
					c = context.run("C", () => session.prompt());
					queueMicrotask(() => {
						d = context.run("D", () => session.prompt());
						notifyStarted();
					});
				}
			},
		});
		hook.enable();
		const a = context.run("A", () => session.prompt());
		const b = context.run("B", () => session.prompt());
		expect(releases).toHaveLength(1);
		ready = true;
		releases[0]();
		try {
			await started;
			const recoveryCount = releases.length;
			for (const release of releases) release();
			await Promise.all([a, b, c, d]);
			expect(recoveryCount).toBe(2);
		} finally {
			hook.disable();
			for (const release of releases) release();
		}
	});
	it("ends a held boundary without throwing into the agent loop", async () => {
		const { session, events, gate } = fixture();
		gate.register(() => ({ recover: async () => ({ held: true }) }));
		expect(await session.agent.finishTurn()).toEqual({ action: "end" });
		expect(events).toEqual(["boundary", "abort"]);
	});
	it("allows native appends only inside recovery and holds on thrown recovery", async () => {
		const { session, events, gate } = fixture();
		let host: any;
		gate.register((h) => {
			host = h;
			return {
				recover: async () => {
					expect(h.entry("target")).toEqual({ id: "target", type: "custom" });
					h.append({ type: "context_edit", targetId: "target", replacement: null });
					throw new Error("receipt");
				},
			};
		});
		expect(() => host.append({ type: "context_edit", targetId: "target", replacement: null })).toThrow(
			"E_RAW_RUN_OUTSIDE_RECOVERY",
		);
		await expect(session.prompt()).rejects.toThrow("receipt");
		expect(events).toEqual(["append"]);
	});
	it("requires the coordinator for native ownership markers without interpreting phase", async () => {
		const { session, events } = fixture();
		session.sessionManager.getBranch = () =>
			[{ type: "custom", customType: "openviking.raw-run.operation", data: { phase: "complete" } }] as any;
		await expect(session.prompt()).rejects.toThrow("E_RAW_RUN_RECOVERY_UNAVAILABLE");
		await expect(session.agent.continue()).rejects.toThrow("E_RAW_RUN_RECOVERY_UNAVAILABLE");
		expect(events).toEqual([]);
	});
	it("does not touch existing no-addon prompt behavior; installation is idempotent", async () => {
		const { session, events, gate } = fixture();
		expect(installRawRunRecoveryHost(session as any)).toBe(gate);
		await session.prompt();
		expect(events).toEqual(["prompt"]);
	});
});
