/** Trusted live SDK call registry; no raw arguments are persisted, logged or sent to a model. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createToolRawInvocationStore } from "./tool-raw-invocation.js";

const live = new Map<string, { session: AgentSession; store: ReturnType<typeof createToolRawInvocationStore> }>();
export function validateRawToolInvocation(sessionId: string, toolCallId: string, toolName: string) {
	const entry = live.get(sessionId);
	if (!entry || entry.session.sessionManager.getSessionId() !== sessionId) return { status: "unavailable" as const };
	return entry.store.validate(
		{ sessionId, toolCallId, toolName },
		entry.session.getToolDefinition(toolName)?.parameters,
	);
}

export function installSpecialistRawGuard(session: AgentSession): () => void {
	let sessionId = session.sessionManager.getSessionId();
	if (live.has(sessionId)) throw new Error("Duplicate live session raw-tool registry");
	const store = createToolRawInvocationStore();
	const entry = { session, store };
	live.set(sessionId, entry);
	const unsubscribe = session.subscribe((event) => {
		const currentId = session.sessionManager.getSessionId();
		if (currentId !== sessionId) {
			store.clearSession(sessionId);
			if (live.get(sessionId) === entry) live.delete(sessionId);
			sessionId = currentId;
			if (live.has(sessionId)) throw new Error("Duplicate live session raw-tool registry");
			live.set(sessionId, entry);
		}
		if (event.type === "tool_execution_start") store.capture(sessionId, event);
		else if (event.type === "tool_execution_end")
			store.release({ sessionId, toolCallId: event.toolCallId, toolName: event.toolName });
		else if (event.type === "agent_end") store.clearSession(sessionId);
	});
	const dispose = session.dispose;
	let removed = false;
	const cleanup = () => {
		if (removed) return;
		removed = true;
		unsubscribe();
		store.clearSession(sessionId);
		if (live.get(sessionId) === entry) live.delete(sessionId);
		if (session.dispose === wrappedDispose) session.dispose = dispose;
	};
	const wrappedDispose = () => {
		cleanup();
		dispose.call(session);
	};
	session.dispose = wrappedDispose;
	return cleanup;
}
