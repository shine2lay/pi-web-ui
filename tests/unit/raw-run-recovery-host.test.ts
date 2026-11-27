import { describe, expect, it } from "vitest";
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
