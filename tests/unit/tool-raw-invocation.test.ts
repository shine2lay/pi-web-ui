import { describe, expect, it } from "vitest";
import {
	runAgentLoop,
	runToolCall,
	type AgentContext,
	type AgentLoopConfig,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { createToolRawInvocationStore, type ToolRawInvocationResult } from "../../server/tool-raw-invocation.js";

const key = { sessionId: "fixture-session", toolCallId: "fixture-call", toolName: "fixture-tool" };
const schema = {
	type: "object",
	properties: { count: { type: "integer" }, enabled: { type: "boolean" } },
	required: ["count", "enabled"],
	additionalProperties: false,
};
const valid = () => ({ count: 3, enabled: true });
function capture(store: ReturnType<typeof createToolRawInvocationStore>, args: unknown, identity = key) {
	store.capture(identity.sessionId, { type: "tool_execution_start", ...identity, args });
}

describe("shared raw invocation snapshots", () => {
	it("keeps an immutable original and permits repeatable reads", () => {
		const store = createToolRawInvocationStore();
		const args = { nested: { values: [1, 2] } };
		const nestedSchema = { type: "object", properties: { nested: { type: "object" } } };
		capture(store, args);
		args.nested.values.push(3);
		const result = store.validate(key, nestedSchema);
		expect(result.status).toBe("valid");
		if (result.status !== "valid") throw new Error("Expected valid snapshot");
		const raw = result.args as typeof args;
		expect(raw.nested.values.length).toBe(2);
		expect(Object.isFrozen(raw)).toBe(true);
		expect(Object.isFrozen(raw.nested.values)).toBe(true);
		expect(store.validate(key, nestedSchema).status).toBe("valid");
		expect(Reflect.set(raw.nested.values, "0", 99)).toBe(false);
		// Returned wrapper mutation cannot change the stored verdict or snapshot.
		Object.assign(result, { status: "invalid", args: null });
		expect(store.validate(key, nestedSchema).status).toBe("valid");
	});

	it.each([
		["number coercion", { count: "3", enabled: true }],
		["boolean coercion", { count: 3, enabled: "true" }],
		["unknown key", { ...valid(), extra: true }],
		["missing required", { count: 3 }],
	])("rejects %s without normalization", (_name, args) => {
		const store = createToolRawInvocationStore();
		capture(store, args);
		expect(store.validate(key, schema).status).toBe("invalid");
	});

	it("uses format checks, rejects unresolved refs, and reads current schemas", () => {
		const store = createToolRawInvocationStore();
		capture(store, { contact: "not-an-email" });
		expect(store.validate(key, { type: "object", properties: { contact: {} } }).status).toBe("valid");
		expect(
			store.validate(key, { type: "object", properties: { contact: { type: "string", format: "email" } } }).status,
		).toBe("invalid");
		expect(store.validate(key, { properties: { contact: { $ref: "missing-schema" } } }).status).toBe("invalid");
		expect(store.validate(key).status).toBe("unavailable");
		store.release(key);
		capture(store, { contact: "person@example.com" });
		expect(
			store.validate(key, { type: "object", properties: { contact: { type: "string", format: "email" } } }).status,
		).toBe("valid");
		expect(
			store.validate(key, {
				properties: { contact: { $ref: "#/$defs/contact" } },
				$defs: { contact: { type: "string" } },
			}).status,
		).toBe("valid");
	});

	it("rejects undeclared ORIGINAL keys even when registered schema allows extras, with valid twin", () => {
		const store = createToolRawInvocationStore();
		const permissive = { ...schema, additionalProperties: true };
		const args = { ...valid(), extra: true };
		capture(store, args);
		delete (args as Partial<typeof args>).extra;
		expect(store.validate(key, permissive).status).toBe("invalid");
		store.release(key);
		capture(store, valid());
		expect(store.validate(key, permissive).status).toBe("valid");
	});

	it("isolates all tuple components and instances; cleanup removes live authority", () => {
		const store = createToolRawInvocationStore();
		capture(store, valid());
		for (const part of ["sessionId", "toolCallId", "toolName"] as const) {
			expect(store.validate({ ...key, [part]: "other" }, schema).status).toBe("unavailable");
		}
		expect(createToolRawInvocationStore().validate(key, schema).status).toBe("unavailable");
		const other = { ...key, sessionId: "other" };
		capture(store, valid(), other);
		store.clearSession(key.sessionId);
		expect(store.validate(key, schema).status).toBe("unavailable");
		expect(store.validate(other, schema).status).toBe("valid");
		store.release(other);
		expect(store.validate(other, schema).status).toBe("unavailable");
	});

	it("poisons duplicate live starts and rejects non-JSON without invoking getters", () => {
		const store = createToolRawInvocationStore();
		capture(store, valid());
		capture(store, valid());
		expect(store.validate(key, schema).status).toBe("invalid");
		store.release(key);
		let reads = 0;
		capture(store, {
			get count() {
				reads++;
				return 3;
			},
		});
		expect(reads).toBe(0);
		expect(store.validate(key, schema).status).toBe("invalid");
	});

	it("host-shaped DI preserves verdicts and never returns prepared arguments", () => {
		const store = createToolRawInvocationStore();
		let registered: typeof schema | undefined = schema;
		const host = {
			validateRawToolInvocation(sessionId: string, toolCallId: string, toolName: string) {
				return store.validate({ sessionId, toolCallId, toolName }, registered);
			},
		};
		const read = () => host.validateRawToolInvocation(key.sessionId, key.toolCallId, key.toolName).status;
		expect(read()).toBe("unavailable");
		capture(store, valid());
		expect(read()).toBe("valid");
		expect(read()).toBe(store.validate(key, registered).status);
		registered = undefined;
		expect(read()).toBe("unavailable");
		registered = schema;
		store.release(key);
		capture(store, { ...valid(), count: "3" });
		expect(read()).toBe("invalid");
	});
});

// Real installed SDK lifecycle; synthetic provider OUTPUT only. No model input,
// prompt, request or tool payload is inspected/logged; assertions use state/verdicts.
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
function message(args: ToolCall["arguments"]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: key.toolCallId, name: key.toolName, arguments: args }],
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
}

async function sdkCase(
	args: ToolCall["arguments"],
	repair: boolean,
	mode: "parallel" | "sequential",
	nested = false,
	allowExtras = false,
) {
	const store = createToolRawInvocationStore();
	const phases: string[] = [];
	const verdicts: ToolRawInvocationResult["status"][] = [];
	let dispatched = 0;
	const tool: AgentTool = {
		name: key.toolName,
		label: "fixture",
		description: "fixture",
		parameters: { ...schema, additionalProperties: allowExtras },
		prepareArguments: (input) => {
			phases.push("prepare");
			if (repair) {
				// Deliberately mutate the SDK argument object, proving snapshot independence.
				Object.assign(input as object, valid());
				delete (input as Record<string, unknown>).extra;
			}
			return input;
		},
		execute: async () => {
			phases.push("dispatch");
			dispatched++;
			return { content: [{ type: "text", text: "fixture complete" }], details: undefined };
		},
	};
	const context: AgentContext = { messages: [], tools: [tool] };
	const config: AgentLoopConfig = {
		model,
		convertToLlm: () => [],
		toolExecution: mode,
		finishTurn: () => ({ action: "end" }),
		beforeToolCall: async () => {
			phases.push("guard");
			// Registry schema, not a handwritten approximation or normalized arguments.
			const first = store.validate(key, context.tools?.find((item) => item.name === key.toolName)?.parameters);
			const second = store.validate(key, tool.parameters);
			verdicts.push(first.status, second.status);
			return first.status === "valid" ? undefined : { block: true, reason: "fixture denied" };
		},
	};
	const output = message(args);
	if (nested) {
		await runToolCall(
			{ type: "toolCall", id: key.toolCallId, name: key.toolName, arguments: args },
			{
				tools: [tool],
				assistantMessage: output,
				context,
				beforeToolCall: config.beforeToolCall,
			},
		);
	} else {
		await runAgentLoop(
			[],
			context,
			config,
			(event) => {
				if (event.type === "tool_execution_start") {
					phases.push("start");
					store.capture(key.sessionId, event);
				}
				if (event.type === "tool_execution_end") {
					phases.push("end");
					store.release(key);
				}
			},
			undefined,
			() => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "toolUse", message: output });
				return stream;
			},
		);
	}
	return { phases, verdicts, dispatched, remaining: store.validate(key, schema).status };
}

describe.each(["sequential", "parallel"] as const)("installed SDK %s raw boundary", (mode) => {
	it.each([false, true])("numeric coercion/prepare repair negative and valid twin (repair=%s)", async (repair) => {
		const denied = await sdkCase({ count: "3", enabled: true }, repair, mode);
		expect(denied.phases).toEqual(["start", "prepare", "guard", "end"]);
		expect(denied.verdicts).toEqual(["invalid", "invalid"]);
		expect(denied.dispatched).toBe(0);
		expect(denied.remaining).toBe("unavailable");
		const allowed = await sdkCase(valid(), repair, mode);
		expect(allowed.phases).toEqual(["start", "prepare", "guard", "dispatch", "end"]);
		expect(allowed.verdicts).toEqual(["valid", "valid"]);
		expect(allowed.dispatched).toBe(1);
		expect(allowed.remaining).toBe("unavailable");
	});
	it("cannot repair away an original unknown key", async () => {
		const denied = await sdkCase({ ...valid(), extra: true }, true, mode);
		expect(denied.verdicts).toEqual(["invalid", "invalid"]);
		expect(denied.dispatched).toBe(0);
		const allowed = await sdkCase(valid(), true, mode);
		expect(allowed.dispatched).toBe(1);
	});
	it("denies original extra keys under an explicitly permissive registered schema, with valid twin", async () => {
		const denied = await sdkCase({ ...valid(), extra: true }, true, mode, false, true);
		expect(denied.verdicts).toEqual(["invalid", "invalid"]);
		expect(denied.dispatched).toBe(0);
		const allowed = await sdkCase(valid(), true, mode, false, true);
		expect(allowed.verdicts).toEqual(["valid", "valid"]);
		expect(allowed.dispatched).toBe(1);
	});
	it("denies nested runToolCall without public start even with valid arguments", async () => {
		const nested = await sdkCase(valid(), false, mode, true);
		expect(nested.phases).toEqual(["prepare", "guard"]);
		expect(nested.verdicts).toEqual(["unavailable", "unavailable"]);
		expect(nested.dispatched).toBe(0);
	});
});
