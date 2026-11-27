import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Type, type Static } from "typebox";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	SessionManager,
	type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { childRawGateResources } from "../../server/specialist-child-raw-gate.js";
import { installSpecialistRawGuard } from "../../server/specialist-raw-runtime.js";
import { createConsultChildFile, consultChildFile, consultIdOf } from "../../server/specialist-consult.js";
import { makeLspTool } from "../../server/lsp-tool.js";

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
const original = () => ({ action: "diagnostics", path: "source.ts", allowInstall: false });
type Fault =
	| "none"
	| "coercion"
	| "unknown"
	| "prepareMutation"
	| "policyMutation"
	| "missingStart"
	| "schemaUnavailable"
	| "policyDeny";

/** Real AgentSession extension dispatch, child identity file, and nested ctx.executeTool path.
 * The external fixture substitutes only provider OUTPUT and body counters. It never reads
 * model inputs, requests, system prompts, or tool-result payloads.
 */
async function childCase(fault: Fault, nested: boolean, mode: "parallel" | "sequential") {
	const dir = mkdtempSync(join(tmpdir(), "child-raw-gate-"));
	let bodies = 0;
	let policyCalls = 0;
	let policySawOriginal = false;
	let prepares = 0;
	let nestedError: boolean | undefined;
	const args: ToolCall["arguments"] = {
		...original(),
		...(fault === "coercion" ? { allowInstall: "false" } : {}),
		...(fault === "unknown" ? { undeclared: true } : {}),
	};
	const gate = childRawGateResources();
	const fixture: ExtensionFactory = (pi) => {
		const lsp = makeLspTool({ cwd: dir });
		pi.registerTool({
			...lsp,
			prepareArguments(input) {
				prepares++;
				const prepared = input as Record<string, unknown>;
				// This compatibility shim intentionally repairs input before SDK validation.
				delete prepared.undeclared;
				if (fault === "prepareMutation") prepared.path = "changed.ts";
				return prepared as Static<typeof lsp.parameters>;
			},
			execute: async () => {
				bodies++;
				return { content: [{ type: "text", text: "Complete" }], details: undefined };
			},
		});
		pi.registerTool({
			name: "outer",
			label: "Outer",
			description: "External nested-call fixture",
			parameters: Type.Object({}),
			execute: async (_id, _args, _signal, _update, ctx) => {
				const outcome = await ctx.executeTool("lsp", args);
				nestedError = outcome.isError;
				return { content: [{ type: "text", text: "Complete" }], details: undefined };
			},
		});
		// Stands in for existing identity policy, NOT the raw validator. It observes
		// the original snapshot and can refuse independently or try mutating input.
		pi.on("tool_call", (event) => {
			if (event.toolName !== "lsp") return;
			policyCalls++;
			const input = event.input as Record<string, unknown>;
			policySawOriginal = input.path === "source.ts" && input.allowInstall === false;
			if (fault === "policyMutation") input.path = "policy-changed.ts";
			if (fault === "policyDeny") return { block: true, reason: "fixture policy refusal" };
		});
	};
	try {
		const services = await createAgentSessionServices({
			cwd: dir,
			agentDir: join(dir, "agent"),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noContextFiles: true,
				...gate,
				// Deliberately put policy first: production ordering must move guards around it.
				extensionFactories: [fixture, ...gate.extensionFactories!],
			},
		});
		const caller = SessionManager.create(dir, dir);
		caller.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Ready" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const callerFile = caller.getSessionFile()!;
		const consultId = consultIdOf(callerFile, "child-call");
		const file = consultChildFile(callerFile, consultId);
		createConsultChildFile(file, {
			v: 1,
			id: "ops",
			via: "consult",
			specialist: "reader",
			consult: { id: consultId, caller: callerFile, callerPrincipal: "ops" },
		});
		const manager = SessionManager.open(file);
		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: manager,
			model,
			tools: ["lsp", "outer"],
		});
		try {
			// External missing-start harness: suppress only lsp capture, not SDK dispatch
			// or the outer start. No fixture modes are present in production code.
			const subscribe = session.subscribe.bind(session);
			if (fault === "missingStart")
				session.subscribe = (listener) =>
					subscribe((event) => {
						if (event.type === "tool_execution_start" && event.toolName === "lsp") return;
						listener(event);
					});
			installSpecialistRawGuard(session);
			session.subscribe = subscribe;
			await session.bindExtensions({ mode: "rpc" });
			if (fault === "schemaUnavailable") {
				const getTool = session.getToolDefinition.bind(session);
				session.getToolDefinition = (name) => (name === "lsp" ? undefined : getTool(name));
			}
			session.setActiveToolsByName(["lsp", "outer"]);
			session.agent.toolExecution = mode;
			session.agent.getApiKey = () => "external-fixture";
			session.agent.finishTurn = () => ({ action: "end" });
			session.agent.streamFunction = () => {
				const output: AssistantMessage = {
					role: "assistant",
					content: [
						{ type: "toolCall", id: "child-call", name: nested ? "outer" : "lsp", arguments: nested ? {} : args },
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
			await session.agent.prompt("Exercise the external child fixture.");
			return { bodies, prepares, policyCalls, policySawOriginal, nestedError };
		} finally {
			session.dispose();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("consult child SDK dispatch raw authorization", () => {
	for (const mode of ["sequential", "parallel"] as const) {
		for (const nested of [false, true]) {
			it.each(["coercion", "unknown", "prepareMutation", "missingStart", "schemaUnavailable"] as const)(
				`${mode} nested=${nested} refuses %s before policy/body with a valid twin`,
				async (fault) => {
					const denied = await childCase(fault, nested, mode);
					expect(denied.prepares).toBe(1);
					expect(denied.bodies).toBe(0);
					expect(denied.policyCalls).toBe(0);
					if (nested) expect(denied.nestedError).toBe(true);
					const allowed = await childCase("none", nested, mode);
					expect(allowed.bodies).toBe(1);
					expect(allowed.policyCalls).toBe(1);
					expect(allowed.policySawOriginal).toBe(true);
					if (nested) expect(allowed.nestedError).toBe(false);
				},
			);
			it.each(["policyMutation", "policyDeny"] as const)(
				`${mode} nested=${nested} preserves %s refusal`,
				async (fault) => {
					const result = await childCase(fault, nested, mode);
					expect(result.bodies).toBe(0);
					expect(result.policyCalls).toBe(1);
					expect(result.policySawOriginal).toBe(true);
				},
			);
		}
	}
});
