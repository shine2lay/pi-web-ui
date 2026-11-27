import { compile, type JsonSchema } from "@earendil-works/pi-schema";
import { formats } from "@earendil-works/pi-schema/formats";

export interface ToolRawInvocationKey {
	readonly sessionId: string;
	readonly toolCallId: string;
	readonly toolName: string;
}

export interface ToolRawInvocationStart {
	readonly type: "tool_execution_start";
	readonly toolCallId: string;
	readonly toolName: string;
	readonly args: unknown;
}

export type ToolRawInvocationResult =
	| { readonly status: "valid"; readonly args: unknown }
	| { readonly status: "invalid" }
	| { readonly status: "unavailable" };

export interface ToolRawInvocationStore {
	/** Call synchronously from the public SDK start event, BEFORE preparation. */
	capture(sessionId: string, event: ToolRawInvocationStart): void;
	/** Repeatable read. Caller resolves CURRENT registered tool.parameters, never a fallback schema. */
	validate(key: ToolRawInvocationKey, schema?: JsonSchema): ToolRawInvocationResult;
	/** Release at tool_execution_end, not before dispatch authorization. */
	release(key: ToolRawInvocationKey): void;
	clearSession(sessionId: string): void;
}

function keyOf(key: ToolRawInvocationKey): string {
	return JSON.stringify([key.sessionId, key.toolCallId, key.toolName]);
}

function validKey(key: ToolRawInvocationKey): boolean {
	return [key.sessionId, key.toolCallId, key.toolName].every((value) => typeof value === "string" && value.length > 0);
}

/** Copy JSON data without invoking accessors or retaining mutable caller references. */
function snapshot(value: unknown, ancestors = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || value === null || ancestors.has(value)) throw new Error("Not JSON data");
	const array = Array.isArray(value);
	if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new Error("Not JSON data");
	}
	ancestors.add(value);
	try {
		const copy: Record<string, unknown> | unknown[] = array ? [] : {};
		for (const property of Reflect.ownKeys(value)) {
			if (array && property === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, property)!;
			if (typeof property !== "string" || !descriptor.enumerable || !("value" in descriptor))
				throw new Error("Not JSON data");
			if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(property) || Number(property) >= value.length)) {
				throw new Error("Not JSON data");
			}
			Object.defineProperty(copy, property, {
				value: snapshot(descriptor.value, ancestors),
				enumerable: true,
				writable: false,
				configurable: false,
			});
		}
		if (Array.isArray(value) && Object.keys(copy).length !== value.length) throw new Error("Not JSON data");
		return Object.freeze(copy);
	} finally {
		ancestors.delete(value);
	}
}

/** No history lookup, prepared-argument fallback, or authority shared between stores. */
export function createToolRawInvocationStore(): ToolRawInvocationStore {
	const entries = new Map<string, { sessionId: string; result: ToolRawInvocationResult }>();
	return {
		capture(sessionId, event) {
			const key = { sessionId, toolCallId: event.toolCallId, toolName: event.toolName };
			if (event.type !== "tool_execution_start" || !validKey(key)) return;
			const id = keyOf(key);
			let result: ToolRawInvocationResult = { status: "invalid" };
			if (!entries.has(id)) {
				try {
					result = { status: "valid", args: snapshot(event.args) };
				} catch {
					/* Fail closed without logging raw data. */
				}
			}
			// A duplicate live start poisons the tuple; never replace its original authority.
			entries.set(id, { sessionId, result });
		},
		validate(key, schema) {
			if (!validKey(key) || schema === undefined) return { status: "unavailable" };
			const entry = entries.get(keyOf(key));
			if (!entry) return { status: "unavailable" };
			if (entry.result.status !== "valid") return { status: "invalid" };
			try {
				// Tool envelopes admit only explicitly registered top-level properties,
				// even when the schema permits extras. Inspect the ORIGINAL snapshot.
				const args = entry.result.args;
				if (args !== null && typeof args === "object" && !Array.isArray(args)) {
					const properties =
						typeof schema === "object" && schema !== null ? (schema as { properties?: unknown }).properties : undefined;
					if (
						Object.keys(args).some(
							(name) =>
								properties === null ||
								typeof properties !== "object" ||
								!Object.prototype.hasOwnProperty.call(properties, name),
						)
					) {
						return { status: "invalid" };
					}
				}
				const validator = compile(schema, { coerce: false, unresolvedRefs: "reject", formats });
				return validator.check(entry.result.args)
					? { status: "valid", args: entry.result.args }
					: { status: "invalid" };
			} catch {
				return { status: "unavailable" };
			}
		},
		release(key) {
			entries.delete(keyOf(key));
		},
		clearSession(sessionId) {
			for (const [id, entry] of entries) if (entry.sessionId === sessionId) entries.delete(id);
		},
	};
}
