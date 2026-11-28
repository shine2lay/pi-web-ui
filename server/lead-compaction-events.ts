import type { LeadLifecycleHooks } from "./lead-compaction-lifecycle.js";

const settled = new Set<(sessionId: string, type: string) => void>();
const opened = new Set<(sessionId: string) => void>();
const idle = new Set<() => void>();
function subscribe<T>(listeners: Set<T>, listener: T): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
/** Scalar host events only. No discovery, journal reader, timer or scheduling authority here. */
export const leadLifecycleHooks: LeadLifecycleHooks = {
	onAgentEvent: (listener) => subscribe(settled, listener),
	onHomeOpen: (listener) => subscribe(opened, listener),
	onIdle: (listener) => subscribe(idle, listener),
	onError: (code) => console.error(`[lead-compaction] ${code}`),
};
export function leadSettled(sessionId: string): void {
	for (const listener of settled) listener(sessionId, "agent_settled");
}
export function leadOpened(sessionId: string): void {
	if (sessionId) for (const listener of opened) listener(sessionId);
}
export function leadIdle(): void {
	for (const listener of idle) listener();
}
