import type { UiWorkRecord } from "./roles-board-protocol.js";

/** Mirrors pi-queue/work-delivery.ts; parity acceptance uses the actual canonical module. */
export type WorkDeliveryRecord = Required<Pick<UiWorkRecord, "id" | "outcome" | "doneWhen" | "taskRefs">> &
	Pick<UiWorkRecord, "currentProject">;
export interface WorkDeliveryProjection {
	initiatives: WorkDeliveryRecord[];
	projects: WorkDeliveryRecord[];
}
export type DeliveryReader = (state: unknown) => WorkDeliveryProjection;

/** No second evidence parser or focus formula: older/missing producers explicitly lack the capability. */
export function workDeliveryReader(): DeliveryReader | undefined {
	const slot = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-queue.readers.v4")];
	if (!slot || typeof slot !== "object") return undefined;
	const r = slot as { version?: unknown; deliveryProjection?: unknown };
	return r.version === 4 && typeof r.deliveryProjection === "function"
		? (r.deliveryProjection as DeliveryReader)
		: undefined;
}

export function unavailableCurrentProject(): NonNullable<UiWorkRecord["currentProject"]> {
	return { state: "unavailable", reason: "Canonical current-project reader unavailable" };
}
