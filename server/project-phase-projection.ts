/** Canonical v3 display bridge. No local phase replay, counting or task-key reconstruction. */
import type { UiProjectDelivery } from "./roles-board-protocol.js";
interface PhaseReaders {
	version: 3;
	readWork(dir: string): unknown;
	projectDelivery(state: unknown, id: string): UiProjectDelivery | undefined;
	taskPhase(state: unknown, project: string, queue: string, task: number, added: number): string | null | undefined;
}
export function phaseReaders(): PhaseReaders | undefined {
	const r = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-queue.readers.v3")] as
		Partial<PhaseReaders> | undefined;
	return r?.version === 3 &&
		typeof r.readWork === "function" &&
		typeof r.projectDelivery === "function" &&
		typeof r.taskPhase === "function"
		? (r as PhaseReaders)
		: undefined;
}
export const unavailablePhases = (): UiProjectDelivery => ({
	state: "unavailable",
	reason: "Canonical phase reader unavailable; phase progress cannot be read.",
});
export function deliveryFromState(state: unknown, id: string, hasPhases: boolean): UiProjectDelivery | undefined {
	if (!hasPhases) return undefined;
	try {
		return phaseReaders()?.projectDelivery(state, id) ?? unavailablePhases();
	} catch {
		return unavailablePhases();
	}
}
export function taskPhaseResolver(
	dir: string,
	queue: string | null | undefined,
): (project: string, task: number, added: number) => string | null | undefined {
	const readers = phaseReaders();
	if (!readers || !queue) return () => undefined;
	try {
		const state = readers.readWork(dir);
		return (project, task, added) => readers.taskPhase(state, project, queue, task, added);
	} catch {
		return () => undefined;
	}
}
