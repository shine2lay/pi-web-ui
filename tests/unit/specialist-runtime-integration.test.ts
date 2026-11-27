import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	createEventBus,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	consultChildFile,
	consultIdOf,
	createConsultChildFile,
	makeConsultSpecialistTool,
} from "../../server/specialist-consult.js";
import { consultRuntimeChannel } from "../../server/specialist-consult-runtime.js";
import { deliverPeerCustomMessage } from "../../server/peer-note-runtime.js";
import { installSpecialistRawGuard, validateRawToolInvocation } from "../../server/specialist-raw-runtime.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function persistedSession(customTools: Parameters<typeof createAgentSessionFromServices>[0]["customTools"] = []) {
	const dir = mkdtempSync(join(tmpdir(), "specialist-runtime-"));
	dirs.push(dir);
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: join(dir, "agent"),
		resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true },
	});
	const manager = SessionManager.create(dir, dir);
	// Real SDK persistence, no model endpoint or synthetic model request capture.
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Ready" }],
		api: "openai-completions",
		provider: "test",
		model: "fixture",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, customTools });
	return { session, manager, dir };
}

describe("specialist runtime persisted SDK integration", () => {
	it("persists a hidden private child and reopens the same identity through SessionManager", async () => {
		const { session, manager, dir } = await persistedSession();
		try {
			const caller = manager.getSessionFile()!;
			const id = consultIdOf(caller, "call-1");
			const file = consultChildFile(caller, id);
			const identity = {
				v: 1 as const,
				id: "ops",
				via: "consult" as const,
				specialist: "reader",
				consult: { id, caller, callerPrincipal: "ops" },
			};
			createConsultChildFile(file, identity);
			expect(statSync(file).mode & 0o777).toBe(0o600);
			const child = SessionManager.open(file);
			expect(child.getBranch()).toEqual(
				expect.arrayContaining([expect.objectContaining({ customType: "identity", data: identity })]),
			);
			expect((await SessionManager.list(dir, dir)).map((entry) => entry.path)).not.toContain(file);
			expect(() => createConsultChildFile(file, identity)).toThrow();
			expect(SessionManager.open(file).getSessionId()).toBe(child.getSessionId());
		} finally {
			session.dispose();
		}
	});

	it("refuses admission without a live raw snapshot before contacting the bus", async () => {
		const { session, manager } = await persistedSession();
		installSpecialistRawGuard(session);
		let busCalls = 0;
		try {
			const bus = createEventBus();
			bus.on("pi-identity:specialist", () => {
				busCalls++;
			});
			const callerFile = manager.getSessionFile()!;
			const before = readFileSync(callerFile, "utf8");
			const result = await consultRuntimeChannel(() => session, bus).admit({
				callerFile,
				consultId: consultIdOf(callerFile, "call-2"),
				toolCallId: "call-2",
				args: { target: "reader", question: "Read?" },
			});
			expect(result).toEqual({ ok: false, code: "E_SPEC_UNAVAILABLE" });
			expect(busCalls).toBe(0);
			expect(readFileSync(callerFile, "utf8")).toBe(before);
		} finally {
			session.dispose();
		}
	});

	it.each([
		["refuses an allow response whose start is not actually persisted", undefined],
		["rejects original unknown role before bus admission or effects", "role"],
		["rejects original unknown specialist before bus admission or effects", "specialist"],
	] as const)("%s", async (_name, identityKey) => {
		for (const mode of ["sequential", "parallel"] as const) {
			const toolName = "consult_specialist";
			const callId = "call-2";
			const args = { target: "reader", question: "Read?" };
			let effects = 0;
			let busCalls = 0;
			let admissions = 0;
			let prepared = 0;
			const { session, manager } = await persistedSession([
				{
					name: toolName,
					label: "Consult admission fixture",
					description: "External runtime admission fixture.",
					parameters: Type.Object({ target: Type.String(), question: Type.String() }, { additionalProperties: true }),
					prepareArguments: (input) => {
						prepared++;
						if (identityKey) delete (input as Record<string, unknown>)[identityKey];
						return input as typeof args;
					},
					execute: async () => {
						effects++;
						return { content: [{ type: "text", text: "Unexpected effect" }], details: undefined };
					},
				},
			]);
			installSpecialistRawGuard(session);
			try {
				const bus = createEventBus();
				bus.on("pi-identity:specialist", (raw) => {
					busCalls++;
					const request = raw as { args: unknown; reply: (answer: unknown) => void };
					expect(request.args).toEqual(args);
					request.reply({ v: 1, ok: true, consult: { result: "allow" } });
				});
				const callerFile = manager.getSessionFile()!;
				const model = {
					id: "fixture",
					name: "fixture",
					api: "openai-completions",
					provider: "openai",
					baseUrl: "http://unused.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1000,
					maxTokens: 100,
				} as Model<"openai-completions">;
				session.agent.state.model = model;
				session.agent.toolExecution = mode;
				session.setActiveToolsByName([toolName]);
				session.agent.getApiKey = () => "external-fixture";
				session.agent.finishTurn = () => ({ action: "end" });
				session.agent.beforeToolCall = async () => {
					admissions++;
					const before = readFileSync(callerFile, "utf8");
					const result = await consultRuntimeChannel(() => session, bus).admit({
						callerFile,
						consultId: consultIdOf(callerFile, callId),
						toolCallId: callId,
						args,
					});
					expect(result).toEqual({ ok: false, code: "E_SPEC_DENIED" });
					expect(readFileSync(callerFile, "utf8")).toBe(before);
					return { block: true, reason: "E_SPEC_DENIED" };
				};
				// Synthetic provider OUTPUT only, using the real SDK start/prepare lifecycle.
				session.agent.streamFunction = () => {
					const output: AssistantMessage = {
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: callId,
								name: toolName,
								arguments: { ...args, ...(identityKey ? { [identityKey]: "other" } : {}) },
							},
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "toolUse",
						timestamp: 0,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "toolUse", message: output });
					return stream;
				};
				await session.agent.prompt("Exercise the external admission fixture.");
				expect(prepared).toBe(1);
				expect(admissions).toBe(1);
				expect(busCalls).toBe(identityKey ? 0 : 1);
				expect(effects).toBe(0);
			} finally {
				session.dispose();
			}
		}
	});

	it.each(["question", "context"] as const)(
		"refuses SDK-prepared %s mutation before consult effects, with unchanged valid twin",
		async (field) => {
			for (const mode of ["sequential", "parallel"] as const) {
				for (const mutate of [true, false]) {
					const args = { target: "reader", question: "Q1", context: "C1" };
					const callId = "prepared-consult";
					const bus = createEventBus();
					let prepared = 0;
					let busCalls = 0;
					let starts = 0;
					let children = 0;
					let runs = 0;
					const results: unknown[] = [];
					const tool = makeConsultSpecialistTool({
						channel: {
							admit: (request) => consultRuntimeChannel(() => session, bus).admit(request),
							end: (id, result) => consultRuntimeChannel(() => session, bus).end(id, result),
						},
						createChild: (file, identity) => {
							children++;
							createConsultChildFile(file, identity);
						},
						runner: {
							run: async () => {
								runs++;
								return { outcome: "done", text: "Complete" };
							},
						},
					});
					const { session, manager } = await persistedSession([
						{
							...tool,
							prepareArguments: (input) => {
								prepared++;
								const value = input as typeof args;
								if (mutate) value[field] = field === "question" ? "Q2" : "C2";
								// Equal twin uses a distinct object and reversed key order, not reference/JSON equality.
								return { context: value.context, question: value.question, target: value.target };
							},
							execute: async (...input) => {
								const result = await tool.execute(...input);
								results.push(result.details);
								return result;
							},
						},
					]);
					installSpecialistRawGuard(session);
					try {
						const callerFile = manager.getSessionFile()!;
						const consultId = consultIdOf(callerFile, callId);
						bus.on("pi-identity:specialist", (raw) => {
							busCalls++;
							const request = raw as {
								args?: unknown;
								end?: Record<string, unknown>;
								reply: (answer: unknown) => void;
							};
							if (request.end) {
								manager.appendCustomEntry("specialist-consult", {
									...request.end,
									op: "end",
									state: request.end.outcome,
								});
							} else {
								expect(request.args).toEqual(args);
								starts++;
								manager.appendCustomEntry("specialist-consult", {
									op: "start",
									consultId,
									slug: "reader",
									callerPrincipal: "ops",
									childTools: [],
									childToolsSha256: createHash("sha256").update("[]").digest("hex"),
								});
							}
							request.reply({ v: 1, ok: true, consult: { result: "allow" } });
						});
						const model = {
							id: "fixture",
							name: "fixture",
							api: "openai-completions",
							provider: "openai",
							baseUrl: "http://unused.invalid",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						} as Model<"openai-completions">;
						session.agent.state.model = model;
						session.agent.toolExecution = mode;
						session.setActiveToolsByName([tool.name]);
						session.agent.getApiKey = () => "external-fixture";
						session.agent.finishTurn = () => ({ action: "end" });
						// Provider OUTPUT only: real SDK prepare/execute and canonical raw snapshot lifecycle.
						session.agent.streamFunction = () => {
							const output: AssistantMessage = {
								role: "assistant",
								content: [{ type: "toolCall", id: callId, name: tool.name, arguments: { ...args } }],
								api: model.api,
								provider: model.provider,
								model: model.id,
								stopReason: "toolUse",
								timestamp: 0,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							};
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "done", reason: "toolUse", message: output });
							return stream;
						};
						await session.agent.prompt("Exercise the external prepared consult fixture.");
						expect(prepared).toBe(1);
						expect(results).toEqual([
							expect.objectContaining(
								mutate ? { state: "error", code: "E_SPEC_DENIED" } : { state: "done", answer: "Complete" },
							),
						]);
						expect(busCalls).toBe(mutate ? 0 : 2);
						expect(starts).toBe(mutate ? 0 : 1);
						expect(children).toBe(mutate ? 0 : 1);
						expect(runs).toBe(mutate ? 0 : 1);
						expect(existsSync(consultChildFile(callerFile, consultId))).toBe(!mutate);
						const records = manager
							.getBranch()
							.filter((entry) => entry.type === "custom" && entry.customType === "specialist-consult");
						expect(records).toHaveLength(mutate ? 0 : 2);
					} finally {
						session.dispose();
					}
				}
			}
		},
	);

	it("delivers FYI as a persisted custom message without starting any model turn", async () => {
		const { session, manager } = await persistedSession();
		let starts = 0;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "agent_start") starts++;
		});
		try {
			await deliverPeerCustomMessage(session, "Teammate information", { turn: false, followUp: false }, () => {});
			expect(starts).toBe(0);
			const last = session.messages.at(-1);
			expect(last).toMatchObject({ role: "custom", customType: "peer-note" });
			expect(readFileSync(manager.getSessionFile()!, "utf8")).toContain('"customType":"peer-note"');
		} finally {
			unsubscribe();
			session.dispose();
		}
	});

	it.each(["role", "specialist"] as const)(
		"live SDK rejects original undeclared %s after preparation, with valid twin",
		async (identityKey) => {
			for (const mode of ["sequential", "parallel"] as const) {
				for (const unknownIdentity of [true, false]) {
					let dispatched = 0;
					const phases: string[] = [];
					const verdicts: string[] = [];
					const toolName = "runtime_identity_boundary";
					const callId = "identity-boundary-call";
					const { session, manager } = await persistedSession([
						{
							name: toolName,
							label: "Boundary fixture",
							description: "External runtime boundary fixture.",
							parameters: Type.Object({ question: Type.String() }, { additionalProperties: true }),
							prepareArguments: (args) => {
								phases.push("prepare");
								// Mutate the original object: the live guard must retain the pre-prepare key.
								delete (args as Record<string, unknown>)[identityKey];
								return args as { question: string };
							},
							execute: async () => {
								dispatched++;
								return { content: [{ type: "text", text: "Complete" }], details: undefined };
							},
						},
					]);
					installSpecialistRawGuard(session);
					const id = manager.getSessionId();
					const unsubscribe = session.subscribe((event) => {
						if (event.type === "tool_execution_start") phases.push("start");
					});
					try {
						const model = {
							id: "fixture",
							name: "fixture",
							api: "openai-completions",
							provider: "openai",
							baseUrl: "http://unused.invalid",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						} as Model<"openai-completions">;
						session.agent.state.model = model;
						session.agent.toolExecution = mode;
						session.setActiveToolsByName([toolName]);
						session.agent.getApiKey = () => "external-fixture";
						session.agent.finishTurn = () => ({ action: "end" });
						// Exercise the trusted runtime callback, not a test-owned snapshot store.
						session.agent.beforeToolCall = async () => {
							phases.push("guard");
							const first = validateRawToolInvocation(id, callId, toolName);
							verdicts.push(first.status, validateRawToolInvocation(id, callId, toolName).status);
							expect(validateRawToolInvocation(id, "other-call", toolName).status).toBe("unavailable");
							if (first.status === "valid") expect(Object.isFrozen(first.args)).toBe(true);
							return first.status === "valid" ? undefined : { block: true, reason: "E_SPEC_DENIED" };
						};
						// Synthetic provider OUTPUT only; never inspect or retain a model request.
						session.agent.streamFunction = () => {
							const output: AssistantMessage = {
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: callId,
										name: toolName,
										arguments: { question: "Read?", ...(unknownIdentity ? { [identityKey]: "other" } : {}) },
									},
								],
								api: model.api,
								provider: model.provider,
								model: model.id,
								stopReason: "toolUse",
								timestamp: 0,
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
							};
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "done", reason: "toolUse", message: output });
							return stream;
						};
						await session.agent.prompt("Exercise the external fixture.");
						expect(phases).toEqual(["start", "prepare", "guard"]);
						expect(verdicts).toEqual(unknownIdentity ? ["invalid", "invalid"] : ["valid", "valid"]);
						expect(dispatched).toBe(unknownIdentity ? 0 : 1);
						expect(validateRawToolInvocation(id, callId, toolName).status).toBe("unavailable");
					} finally {
						unsubscribe();
						session.dispose();
					}
				}
			}
		},
	);

	it("requires live invocation snapshots and removes a disposed SDK session", async () => {
		const { session, manager } = await persistedSession();
		installSpecialistRawGuard(session);
		const id = manager.getSessionId();
		expect(validateRawToolInvocation(id, "not-started", "read")).toEqual({ status: "unavailable" });
		session.dispose();
		expect(validateRawToolInvocation(id, "not-started", "read")).toEqual({ status: "unavailable" });
	});
});
