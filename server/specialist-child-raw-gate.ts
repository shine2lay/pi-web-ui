/** Child-only dispatch authorization, bracketing the existing identity policy hooks. */
import { isDeepStrictEqual } from "node:util";
import type { DefaultResourceLoader, ToolCallEvent } from "@earendil-works/pi-coding-agent";
type ResourceOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
import { validateRawToolInvocation } from "./specialist-raw-runtime.js";

const FIRST = "consult-child-raw-before";
const LAST = "consult-child-raw-after";
const denied = () => ({ block: true as const, reason: "E_SPEC_DENIED: child raw invocation refused" });

/** Public SDK loader hooks only; no private AgentSession/agent hook replacement.
 * Both boundaries re-read the SAME canonical validator and CURRENT registered schema.
 * The policy receives a copy of the original snapshot; the body retains its SDK argument
 * object, which must remain equal to that original across all policy handlers.
 */
export function childRawGateResources(): Pick<ResourceOptions, "extensionFactories" | "extensionsOverride"> {
	const prepared = new WeakMap<ToolCallEvent, unknown>();
	return {
		extensionFactories: [
			{
				name: FIRST,
				factory(pi) {
					pi.on("tool_call", (event, ctx) => {
						try {
							const raw = validateRawToolInvocation(
								ctx.sessionManager.getSessionId(),
								event.toolCallId,
								event.toolName,
							);
							if (raw.status !== "valid" || !isDeepStrictEqual(event.input, raw.args)) return denied();
							prepared.set(event, event.input);
							// Existing policy must never receive a normalized substitute for the original.
							event.input = structuredClone(raw.args) as typeof event.input;
						} catch {
							return denied();
						}
					});
				},
			},
			{
				name: LAST,
				factory(pi) {
					pi.on("tool_call", (event, ctx) => {
						try {
							const raw = validateRawToolInvocation(
								ctx.sessionManager.getSessionId(),
								event.toolCallId,
								event.toolName,
							);
							if (
								raw.status !== "valid" ||
								!prepared.has(event) ||
								!isDeepStrictEqual(prepared.get(event), raw.args) ||
								!isDeepStrictEqual(event.input, raw.args)
							)
								return denied();
						} catch {
							return denied();
						} finally {
							prepared.delete(event);
						}
					});
				},
			},
		],
		extensionsOverride(base) {
			const first = base.extensions.filter((extension) => extension.path === `<inline:${FIRST}>`);
			const last = base.extensions.filter((extension) => extension.path === `<inline:${LAST}>`);
			if (first.length !== 1 || last.length !== 1) throw new Error("E_SPEC_UNAVAILABLE: child raw gate missing");
			return {
				...base,
				extensions: [
					first[0]!,
					...base.extensions.filter((extension) => extension !== first[0] && extension !== last[0]),
					last[0]!,
				],
			};
		},
	};
}
