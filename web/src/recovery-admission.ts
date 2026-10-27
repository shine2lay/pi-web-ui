/** Native authored-work boundary. Storage ownership is #579's; socket ownership is
 * the host's. Neither admission nor a transport outcome is a persistence receipt. */
import type {
	createPendingRecoveryCoordinator,
	PreparedIdentity,
	PreparedRecoveryWork,
	RecoverySnapshot,
	RecoveryWork,
} from "./pending-recovery-coordinator";
import { newPendingSend, newPromptId } from "./pending-sends";
import { randomUuid } from "./uuid";
import { recoveryUsesSessionTarget } from "../../server/recovery-scope";
import type { ClientMessage, CommandDispositionMsg, CommandRecoveryIdentity, SwitchTarget, UiState } from "./types";

export interface AdmissionBinding {
	/** The actual socket object, not its reusable client/conversation name. */
	transport: object;
	generation: string;
	sessionId: string;
	conversationId: string;
	workspace?: string;
	lifetime?: object;
	/** Derived from message type, never caller-provided authority. */
	targetScope?: "session" | "global";
	heldTarget?: SwitchTarget;
}
export interface AdmissionContext extends AdmissionBinding {
	/** Used only to capture baselines, never retained in an attempt/held port. */
	state: UiState;
}
function bindingOf(source: AdmissionContext, type: string): AdmissionBinding {
	const { state: _view, ...binding } = source;
	return {
		...binding,
		targetScope: recoveryUsesSessionTarget(type) ? "session" : "global",
		...(source.heldTarget ? { heldTarget: { ...source.heldTarget } } : {}),
	};
}
export type PublishOutcome =
	{ kind: "sent"; accepted?: Promise<boolean> } | { kind: "held" } | { kind: "not-published"; reason: string };
type Coordinator = Pick<
	ReturnType<typeof createPendingRecoveryCoordinator>,
	"start" | "restore" | "prepare" | "returnToComposer" | "discard" | "exportArtifact"
>;
export interface RecoveryAdmissionOptions {
	coordinator: Coordinator;
	/** Explicit caller policy only: unknown/sensitive data must never reach prepare. */
	eligible(message: ClientMessage): boolean;
	captureContext(message: ClientMessage): AdmissionContext | null;
	isCurrent(context: AdmissionBinding): boolean;
	publish(
		message: ClientMessage,
		prepared: PreparedRecoveryWork,
		context: AdmissionBinding,
		direct: boolean,
	): PublishOutcome;
	onRestore?(snapshot: RecoverySnapshot): void;
	onSaved?(prepared: PreparedRecoveryWork): void;
	onCancelHold?(identity: PreparedIdentity): void;
	onProblem?(message: string): void;
}
interface Attempt {
	prepared: PreparedRecoveryWork;
	context: AdmissionBinding;
	message: ClientMessage;
	identity: CommandRecoveryIdentity;
	status: "held" | "unprocessed" | "uncertain";
	/** Observed dispatch entry or an older unresolved handoff cannot become retryable. */
	priorUncertainty: boolean;
}

/** Capture JSON wire semantics before ANY await; refuse silent non-JSON coercion. */
export function captureRecoveryMessage(input: ClientMessage): ClientMessage {
	const ancestors = new Set<object>();
	function check(value: unknown, optional: boolean): void {
		if (value === undefined && optional) return;
		if (value === null || typeof value === "string" || typeof value === "boolean") return;
		if (typeof value === "number" && Number.isFinite(value)) return;
		if (!value || typeof value !== "object" || ancestors.has(value))
			throw new Error("Complete acyclic JSON is required.");
		const array = Array.isArray(value);
		if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype))
			throw new Error("Complete plain JSON is required.");
		if (Object.getOwnPropertyDescriptor(array ? Array.prototype : Object.prototype, "toJSON"))
			throw new Error("Custom JSON conversion cannot capture an immutable original.");
		ancestors.add(value);
		for (const key of Reflect.ownKeys(value)) {
			if (array && key === "length") continue;
			const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
			if (typeof key !== "string" || !("value" in descriptor) || !descriptor.enumerable)
				throw new Error("Complete plain JSON data properties are required.");
			check(descriptor.value, !array);
		}
		if (array)
			for (let i = 0; i < value.length; i++) {
				if (!Object.hasOwn(value, i)) throw new Error("Sparse original arrays are not complete JSON.");
			}
		ancestors.delete(value);
	}
	check(input, false);
	const result = JSON.parse(JSON.stringify(input)) as ClientMessage;
	if (!result || typeof result.type !== "string" || result.recovery !== undefined)
		throw new Error("The native sender must create its own recovery identity.");
	return result;
}
function identityKey(p: Pick<PreparedIdentity, "ownerId" | "kind" | "sessionId" | "id">): string {
	return JSON.stringify([p.ownerId, p.kind, p.sessionId, p.id]);
}
function wire(prepared: PreparedRecoveryWork): ClientMessage {
	if (prepared.work.kind === "command") return JSON.parse(prepared.work.payload) as ClientMessage;
	const p = prepared.work.pending;
	return {
		type: "prompt",
		id: p.id,
		text: p.text,
		queue: p.queue,
		...(prepared.sessionId.startsWith("dsh:") ? {} : { forSession: prepared.sessionId }),
		...(p.attachments ? { attachments: p.attachments } : {}),
	};
}

export function createRecoveryAdmission(options: RecoveryAdmissionOptions) {
	let startup: Promise<RecoverySnapshot> | undefined;
	let ready = false;
	const attempts = new Map<string, Attempt>();
	function report(message: string): false {
		try {
			options.onProblem?.(message);
		} catch {
			// Reporting is not ownership transfer and cannot authorize a second send.
		}
		return false;
	}
	function saved(prepared: PreparedRecoveryWork): void {
		try {
			options.onSaved?.(prepared);
		} catch {
			// The checkpoint remains owned even if a view cannot render its indicator.
		}
	}
	async function publish(prepared: PreparedRecoveryWork, context: AdmissionBinding, direct: boolean): Promise<boolean> {
		if (!options.isCurrent(context))
			return report("The connection or target changed while saving. The complete copy is retained; nothing was sent.");
		const key = identityKey(prepared);
		const older = attempts.get(key);
		const identity: CommandRecoveryIdentity = {
			id: prepared.id,
			sessionId: prepared.sessionId,
			contentDigest: prepared.contentDigest,
			attemptId: randomUuid(),
		};
		const message = { ...wire(prepared), recovery: identity };
		const attempt: Attempt = {
			prepared,
			context,
			message,
			identity,
			status: "uncertain",
			priorUncertainty: !!older && (older.priorUncertainty || older.status === "uncertain"),
		};
		// Install before calling a potentially reentrant transport. An exception is
		// uncertainty, never evidence that no bytes left the process.
		attempts.set(key, attempt);
		try {
			const result = options.publish(message, prepared, context, direct);
			if (result.kind === "held") attempt.status = "held";
			if (result.kind === "not-published") {
				attempt.status = "unprocessed";
				return report(result.reason);
			}
			if (result.kind === "sent" && result.accepted) {
				if ((await result.accepted) !== true)
					return report(
						"The host did not admit this original. Its complete saved and editable copies must be retained.",
					);
				if (!options.isCurrent(context))
					return report(
						"The connection or target changed after handoff. Delivery is uncertain; the original remains saved.",
					);
			}
			return true;
		} catch {
			return report("Delivery is uncertain. The full saved copy remains; check its status before any retry.");
		}
	}
	async function checkpoint(work: RecoveryWork): Promise<PreparedRecoveryWork | null> {
		try {
			const result = await options.coordinator.prepare(work);
			if (!result.ok) {
				if (result.payloadCommitted) ready = false;
				report(`${result.error.message} The full editable original must be kept; nothing was sent.`);
				return null;
			}
			saved(result.prepared);
			return result.prepared;
		} catch {
			report("Recovery storage failed. Keep the complete editable original; nothing was sent.");
			return null;
		}
	}
	function cancelLocalHold(identity: PreparedIdentity): void {
		const previous = attempts.get(identityKey(identity));
		if (previous?.status === "held") previous.status = "unprocessed";
		try {
			options.onCancelHold?.(identity);
		} catch {
			report("The local hold was cancelled; its original remains saved even though the view could not update.");
		}
	}
	function restored(snapshot: RecoverySnapshot): RecoverySnapshot {
		ready = snapshot.state === "ready";
		try {
			options.onRestore?.(snapshot);
		} catch {
			ready = false;
			report("Recovery was not displayed completely. Keep source records and inspect/export them before sending.");
		}
		return snapshot;
	}
	function start(): Promise<RecoverySnapshot> {
		startup ??= options.coordinator.start().then(restored);
		return startup;
	}
	return {
		start,
		get ready(): boolean {
			return ready;
		},
		/** Explicit read/revalidation only; no save, receipt, cleanup or replay. */
		async recheck(): Promise<RecoverySnapshot> {
			if (!startup) return start();
			ready = false;
			return options.coordinator.restore().then(restored);
		},
		async admit(
			input: ClientMessage,
			original?: { context: AdmissionContext; beforeCheckpoint?: () => Promise<boolean> },
		): Promise<boolean> {
			let message: ClientMessage;
			try {
				message = captureRecoveryMessage(input);
			} catch {
				return report("The complete original could not be captured. Keep the draft; nothing was sent.");
			}
			if (!options.eligible(message))
				return report("This command has no recovery admission policy. Keep the original.");
			if (!ready) return report("Recovery is not ready. Keep the full draft and inspect the recovery notice.");
			const source = original?.context ?? options.captureContext(message);
			const context = source ? bindingOf(source, message.type) : null;
			if (
				!source ||
				!context ||
				!context.sessionId ||
				source.state.sessionId !== context.sessionId ||
				source.state.conversationId !== context.conversationId ||
				!options.isCurrent(context)
			)
				return report("The chat is still opening or changed. Keep the full draft; nothing was sent.");
			if (message.type === "prompt" && message.forSession && message.forSession !== context.sessionId)
				return report("This prompt belongs to a different session. Its complete draft was not sent.");
			if (
				(message.type === "set_goal" || message.type === "start_goal_wizard") &&
				message.conversationId !== undefined &&
				message.conversationId !== context.conversationId
			)
				return report("The goal belongs to its original conversation. Its complete draft was not retargeted.");
			const work: RecoveryWork =
				message.type === "prompt"
					? {
							kind: "prompt",
							pending: newPendingSend({
								id: message.id || newPromptId(),
								text: message.text,
								attachments: message.attachments,
								queue: message.queue,
								state: source.state,
								now: Date.now(),
							}),
						}
					: {
							kind: "command",
							id:
								"reqId" in message && typeof message.reqId === "string" && message.reqId
									? message.reqId
									: `c-${randomUuid()}`,
							conversationId: context.conversationId,
							sessionId: context.sessionId,
							createdAt: Date.now(),
							payload: JSON.stringify(message),
							...(message.type === "edit_message" && message.attachments ? { attachments: message.attachments } : {}),
						};
			// Typed source stores (for example a scheduler's inactive form fields) own
			// their exact original independently of the executable wire packet. Both
			// checkpoints must succeed; a partial commit never permits publication.
			if (original?.beforeCheckpoint) {
				try {
					if ((await original.beforeCheckpoint()) !== true)
						return report(
							"The full original source was not checkpointed. Keep every editable field; nothing was sent.",
						);
				} catch {
					return report("Original-source storage failed. Keep the full draft; nothing was sent.");
				}
				if (!options.isCurrent(context))
					return report("The original target changed while saving its source. Saved copies remain; nothing was sent.");
			}
			// The coordinator captures work synchronously before its own first await.
			const result = await options.coordinator.prepare(work).catch(() => null);
			if (!result || !result.ok) {
				if (result && !result.ok && result.payloadCommitted) ready = false;
				return report(
					`${result && !result.ok ? result.error.message : "Recovery storage failed."} Keep the full editable original; nothing was sent.`,
				);
			}
			saved(result.prepared);
			if (result.dispatch !== "first-send")
				return report("This original already has a saved attempt. Check status or recover it; it was not replayed.");
			return publish(result.prepared, context, false);
		},
		/** First transmission of a locally held, never-dispatched original, not a replay. */
		async flushHeld(identity: PreparedIdentity): Promise<boolean> {
			const previous = attempts.get(identityKey(identity));
			if (!previous || previous.status !== "held" || previous.priorUncertainty)
				return report("This saved work is not an undispatched local hold.");
			const prepared = await checkpoint(previous.prepared.work);
			if (!prepared || attempts.get(identityKey(identity)) !== previous || previous.status !== "held") return false;
			return publish(prepared, previous.context, true);
		},
		/** Only metadata for this exact live transmission may refine uncertainty. */
		receiveDisposition(message: CommandDispositionMsg, transport: object): boolean {
			for (const attempt of attempts.values()) {
				const p = attempt.identity;
				if (
					attempt.context.transport !== transport ||
					attempt.context.generation !== message.connectionGeneration ||
					p.attemptId !== message.recovery.attemptId ||
					p.id !== message.recovery.id ||
					p.sessionId !== message.recovery.sessionId ||
					p.contentDigest !== message.recovery.contentDigest
				)
					continue;
				if (
					message.persistence !== "unknown" ||
					message.releaseClientCopy !== false ||
					message.commandType !== attempt.message.type ||
					(message.status === "unprocessed" ? message.retryable !== true : message.retryable !== false)
				)
					return false;
				if (message.status === "unprocessed" && attempt.priorUncertainty) return false;
				if (message.status === "uncertain") attempt.priorUncertainty = true;
				attempt.status = message.status;
				return true;
			}
			return false;
		},
		/** Explicit retry requires both known unprocessed local history AND a fresh
		 * original-session status probe. Negative/unknown alone never grants replay. */
		async retry(
			identity: PreparedIdentity,
			checkStatus: () => Promise<"negative" | "handled" | "unknown">,
		): Promise<boolean> {
			const key = identityKey(identity);
			const previous = attempts.get(key);
			if (!previous || previous.status !== "unprocessed" || previous.priorUncertainty)
				return report("The original is not proven unprocessed. It remains saved; unknown work was not replayed.");
			const { recovery: _oldAttempt, ...original } = previous.message;
			let origin: AdmissionContext | null;
			try {
				origin = options.captureContext(original as ClientMessage);
			} catch {
				origin = null;
			}
			if (
				!origin ||
				(recoveryUsesSessionTarget(original.type) && origin.sessionId !== previous.prepared.sessionId) ||
				("conversationId" in original &&
					original.conversationId !== undefined &&
					original.conversationId !== origin.conversationId)
			)
				return report("The original target is not bound. Its saved work was not retargeted or replayed.");
			const context = bindingOf(
				recoveryUsesSessionTarget(original.type)
					? origin
					: {
							...origin,
							sessionId: previous.prepared.sessionId,
							conversationId: previous.context.conversationId,
						},
				original.type,
			);
			const status = await checkStatus().catch(() => "unknown" as const);
			if (
				attempts.get(key) !== previous ||
				previous.status !== "unprocessed" ||
				previous.priorUncertainty ||
				status !== "negative" ||
				!options.isCurrent(context)
			)
				return report("The original is not proven unprocessed. It remains saved; unknown work was not replayed.");
			const prepared = await checkpoint(previous.prepared.work);
			if (!prepared || attempts.get(key) !== previous || previous.status !== "unprocessed" || previous.priorUncertainty)
				return false;
			return publish(prepared, context, true);
		},
		/** Pure local cancellation of a never-published hold, not deletion/ack. */
		cancelHeld: cancelLocalHold,
		/** ×/return cancels a never-sent local hold, but is NOT discard. */
		async returnToComposer(identity: PreparedIdentity): Promise<RecoveryWork | null> {
			cancelLocalHold(identity);
			return options.coordinator.returnToComposer(identity);
		},
		discard(identity: PreparedIdentity) {
			cancelLocalHold(identity);
			return options.coordinator.discard({ intent: "discard", identity });
		},
		exportArtifact: () => options.coordinator.exportArtifact(),
	};
}
