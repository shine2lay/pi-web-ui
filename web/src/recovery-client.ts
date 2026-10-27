/** One recovery owner per document, independent of React remount/socket reconnect.
 * Rendering reads this small event-driven view, never coordinator.snapshot() per token.
 * Import alone neither opens a store/lease nor sends anything. */
import {
	createPendingRecoveryCoordinator,
	type PreparedIdentity,
	type PreparedRecoveryWork,
	type RecoverySnapshot,
	type RecoveryWork,
} from "./pending-recovery-coordinator";
import {
	createRecoveryAdmission,
	type AdmissionBinding,
	type AdmissionContext,
	type PublishOutcome,
	type RecoveryAdmissionOptions,
} from "./recovery-admission";
import { isRecoveryEligible } from "./recovery-policy";
import type { PendingSend } from "./pending-sends";
import type { ClientMessage, CommandDispositionMsg, PromptAttachment } from "./types";

export type RecoveryDelivery = "saved" | "held" | "uncertain" | "unprocessed" | "blocked";
export interface RecoveryViewItem {
	prepared: PreparedRecoveryWork;
	complete: boolean;
	delivery: RecoveryDelivery;
	issues: readonly string[];
}
export interface RecoveryView {
	state: RecoverySnapshot["state"] | "starting";
	ownerId?: string;
	items: readonly RecoveryViewItem[];
	issues: readonly string[];
	problem: string | null;
}
export interface NativeRecoveryPort {
	captureContext(message: ClientMessage): AdmissionContext | null;
	isCurrent(binding: AdmissionBinding): boolean;
	publish(
		message: ClientMessage,
		prepared: PreparedRecoveryWork,
		binding: AdmissionBinding,
		direct: boolean,
	): PublishOutcome;
	verifyReference?(attachment: PromptAttachment, pending: PendingSend): Promise<boolean>;
	restored?(snapshot: RecoverySnapshot): void;
	saved?(prepared: PreparedRecoveryWork): void;
	cancelHold?(identity: PreparedIdentity): void;
	problem?(message: string): void;
}
type Coordinator = RecoveryAdmissionOptions["coordinator"];
type VerifyReference = NonNullable<Parameters<typeof createPendingRecoveryCoordinator>[0]>["verifyReference"];
export type RecoveryCoordinatorFactory = (verifyReference: VerifyReference) => Coordinator;
export function recoveryIdentityKey(p: PreparedIdentity): string {
	return JSON.stringify([p.ownerId, p.kind, p.sessionId, p.id]);
}
function immutable<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) immutable(child);
		Object.freeze(value);
	}
	return value;
}

export function createNativeRecoveryClient(factory?: RecoveryCoordinatorFactory) {
	let port: NativeRecoveryPort | null = null;
	let view: RecoveryView = Object.freeze({
		state: "starting",
		items: Object.freeze([]),
		issues: Object.freeze([]),
		problem: null,
	});
	const items = new Map<string, RecoveryViewItem>();
	const listeners = new Set<() => void>();
	const emit = (patch: Partial<RecoveryView>) => {
		view = Object.freeze({ ...view, ...patch, items: Object.freeze([...items.values()]) });
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				/* A renderer cannot change ownership or publication. */
			}
		}
	};
	const verifyReference: VerifyReference = async (attachment, pending) => {
		const original = port;
		if (!original?.verifyReference) return false;
		try {
			return (await original.verifyReference(attachment, pending)) === true && port === original;
		} catch {
			return false;
		}
	};
	const coordinator = factory?.(verifyReference) ?? createPendingRecoveryCoordinator({ verifyReference });
	let admission!: ReturnType<typeof createRecoveryAdmission>;
	const problem = (message: string) => {
		emit({ problem: message, ...(!admission.ready && view.state === "ready" ? { state: "incomplete" as const } : {}) });
		try {
			port?.problem?.(message);
		} catch {
			/* Reporting is never a receipt. */
		}
	};
	const delivery = (prepared: PreparedRecoveryWork, phase: RecoveryDelivery) => {
		const key = recoveryIdentityKey(prepared);
		const item = items.get(key);
		if (item) {
			items.set(key, immutable({ ...item, delivery: phase }));
			emit({});
		}
	};
	admission = createRecoveryAdmission({
		coordinator,
		eligible: isRecoveryEligible,
		captureContext: (message) => port?.captureContext(message) ?? null,
		isCurrent: (binding) => port?.isCurrent(binding) === true,
		publish: (message, prepared, binding, direct) => {
			const original = port;
			if (!original || !original.isCurrent(binding))
				return { kind: "not-published", reason: "The original view or connection is no longer bound." };
			delivery(prepared, "uncertain");
			const result = original.publish(message, prepared, binding, direct);
			if (result.kind === "held") delivery(prepared, "held");
			if (result.kind === "not-published") delivery(prepared, "unprocessed");
			return result;
		},
		onSaved: (prepared) => {
			const key = recoveryIdentityKey(prepared);
			const older = items.get(key);
			items.set(
				key,
				immutable({ prepared, complete: true, delivery: older?.delivery ?? "saved", issues: Object.freeze([]) }),
			);
			emit({});
			port?.saved?.(prepared);
		},
		onRestore: (snapshot) => {
			// A restore is read-only and never changes unknown work into never-sent work.
			for (const entry of snapshot.entries) {
				const key = recoveryIdentityKey(entry.prepared);
				const older = items.get(key);
				items.set(
					key,
					immutable({
						prepared: entry.prepared,
						complete: entry.complete,
						delivery: entry.complete ? (older?.delivery ?? "uncertain") : "blocked",
						issues: entry.issues.map((issue) => issue.message),
					}),
				);
			}
			emit({
				state: snapshot.state,
				ownerId: snapshot.ownerId,
				issues: Object.freeze(snapshot.issues.map((issue) => issue.message)),
				problem:
					snapshot.state === "ready"
						? null
						: "Some original work needs recovery. Nothing incomplete was treated as empty.",
			});
			port?.restored?.(snapshot);
		},
		onCancelHold: (identity) => {
			const item = items.get(recoveryIdentityKey(identity));
			if (item?.delivery === "held") delivery(item.prepared, "unprocessed");
			port?.cancelHold?.(identity);
		},
		onProblem: problem,
	});
	const api = {
		/** Replacing a view port does NOT release/reacquire the document's owner. */
		attach(next: NativeRecoveryPort): () => void {
			port = next;
			return () => {
				if (port === next) port = null;
			};
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: (): RecoveryView => view,
		get ready(): boolean {
			return admission.ready;
		},
		async start(): Promise<RecoverySnapshot> {
			try {
				return await admission.start();
			} catch (error) {
				emit({ state: "unavailable" });
				problem("Recovery storage is unavailable. Keep original work and use recovery export; nothing was sent.");
				throw error;
			}
		},
		async recheck(): Promise<RecoverySnapshot> {
			try {
				return await admission.recheck();
			} catch (error) {
				problem("Recovery recheck failed. Original sources have not been replaced or cleared.");
				throw error;
			}
		},
		admit: admission.admit,
		flushHeld: admission.flushHeld,
		cancelHeld(identity: PreparedIdentity): void {
			admission.cancelHeld(identity);
			const item = items.get(recoveryIdentityKey(identity));
			if (item?.delivery === "held") delivery(item.prepared, "unprocessed");
		},
		retry: admission.retry,
		receiveDisposition(message: CommandDispositionMsg, transport: object): boolean {
			if (!admission.receiveDisposition(message, transport)) return false;
			const kind = message.commandType === "prompt" ? "prompt" : "command";
			for (const item of items.values()) {
				const p = item.prepared;
				if (
					p.kind === kind &&
					p.id === message.recovery.id &&
					p.sessionId === message.recovery.sessionId &&
					p.contentDigest === message.recovery.contentDigest
				) {
					delivery(p, message.status);
					break;
				}
			}
			return true;
		},
		/** Data only. Caller must return it to the exact original target or export it,
		 * never execute a recovered command or present it as renewed action authority. */
		async returnToComposer(identity: PreparedIdentity): Promise<RecoveryWork | null> {
			const work = await admission.returnToComposer(identity);
			const item = items.get(recoveryIdentityKey(identity));
			if (work && item?.delivery === "held") delivery(item.prepared, "unprocessed");
			return work;
		},
		async discard(identity: PreparedIdentity) {
			// The admission layer cancels never-sent holds before awaiting tombstoning.
			const result = await admission.discard(identity);
			if (result.released) {
				items.delete(recoveryIdentityKey(identity));
				emit({});
			} else problem(result.error?.message ?? "Discard was not committed; the complete saved original remains.");
			return result;
		},
		exportArtifact: admission.exportArtifact,
	};
	return api;
}

let documentClient: ReturnType<typeof createNativeRecoveryClient> | undefined;
let documentFactory: RecoveryCoordinatorFactory | undefined;
export function setNativeRecoveryCoordinatorFactory(factory?: RecoveryCoordinatorFactory): void {
	documentFactory = factory;
	documentClient = undefined;
}
/** Lazy: SSR/tests/imports do not create browser ownership or touch recovery data. */
export function nativeRecoveryClient() {
	return (documentClient ??= createNativeRecoveryClient(documentFactory));
}
