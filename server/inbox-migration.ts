/** RET-4 administrative migration seam. Not registered or called by production.
 * Separate from rpi/1: these records never close, claim, dispatch or prune an item.
 * Canonical source hashes/classification stay with InboxRuntime's one reader.
 */
import type { InboxRuntime } from "./inbox-runtime.js";

export interface InboxMigrationPlan {
	v: "rpi-migration/1";
	migrationId: "rpi-legacy-v1";
	planHash: string;
	items: Array<{ id: string; sourceHash: string }>;
}
interface InboxMigrationRecord {
	v: "rpi-migration/1";
	migrationId: "rpi-legacy-v1";
	planHash: string;
	at: number;
}
export type InboxMigrationProgress = InboxMigrationRecord &
	(
		| {
				kind: "item";
				key: string;
				sourceHash: string;
				index: number;
				outcome: "classified" | "refused_changed_hash" | "deferred_unknown";
		  }
		| {
				kind: "attempt";
				attemptId: string;
				fromCursor: number;
				toCursor: number;
				outcome: "complete" | "partial" | "interrupted";
		  }
	);
export type InboxMigrationResult =
	| { status: "complete" | "partial"; cursor: number; planHash: string }
	| { status: "unknown" | "conflict"; source: string; reason: string };

export interface InboxMigrationPorts {
	/** Host-selected trusted state root, never tool input. Builder uses the existing
	 * trusted directory factory and no-follow publication/recovery discipline.
	 */
	stateDir: string;
	runtime: InboxRuntime;
	role: string;
}

export class InboxMigration {
	constructor(readonly ports: InboxMigrationPorts) {}
	/** Frozen first-trigger plan; each call appends its own attempt. An abort is
	 * a normal partial outcome, not permission to discard progress or re-plan.
	 */
	run(_signal?: AbortSignal): Promise<InboxMigrationResult> {
		throw new Error("E_RPI_UNBUILT: migration administration is not installed");
	}
}
