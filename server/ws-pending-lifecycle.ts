import type { ClientMessage } from "./protocol.js";
import {
	MAX_PENDING_WS_MESSAGES,
	PendingCommandRejectedError,
	RecoverablePendingCommandQueue,
} from "./ws-pending-queue.js";

/** Supplied evidence only. null means unknown, not the currently open session. */
export interface PendingCommandCorrelation {
	readonly sessionId: string | null;
	readonly requestId: string | null;
	readonly connectionGeneration: string;
}

/** Captured parsed-JSON content; command and correlation are recursively frozen. */
export interface PendingLifecycleEntry {
	readonly command: ClientMessage;
	readonly correlation: PendingCommandCorrelation;
}

export type PendingLifecycleTerminalReason =
	"attach-failed" | "socket-closed" | "generation-replaced" | "dispatch-threw";
export type PendingLifecycleRejectionReason =
	PendingLifecycleTerminalReason | "capacity" | "attach-complete" | "stale-generation";

interface NoPersistenceEvidence {
	readonly persistence: "unknown";
	readonly releaseClientCopy: false;
}

export type PendingLifecycleDisposition = NoPersistenceEvidence &
	(
		| {
				readonly entry: PendingLifecycleEntry;
				readonly status: "unprocessed";
				readonly retryable: true;
				readonly reason: PendingLifecycleRejectionReason;
		  }
		| {
				readonly entry: PendingLifecycleEntry;
				readonly status: "uncertain";
				readonly retryable: false;
				readonly reason: PendingLifecycleTerminalReason | "handler-returned";
		  }
	);

export interface PendingLifecycleHandoff extends NoPersistenceEvidence {
	readonly kind: "handoff";
	/** The recipient now owns recovery/reconciliation, NOT permission to retry/delete. */
	readonly dispositions: readonly PendingLifecycleDisposition[];
}

export interface PendingLifecycleIgnored {
	readonly kind: "ignored";
	readonly reason:
		| "stale-generation"
		| "terminal"
		| "attach-complete"
		| "attach-pending"
		| "dispatch-in-progress"
		| "empty"
		| "already-transferred";
}

export interface PendingLifecycleBuffered extends NoPersistenceEvidence {
	readonly kind: "buffered";
	/** A reference for correlation only: ownership is still with the lifecycle. */
	readonly entry: PendingLifecycleEntry;
}

/** Private payload avoids accidental ordinary error serialization/logging. */
export class PendingLifecycleRejectedError extends Error {
	readonly #disposition: PendingLifecycleDisposition;

	constructor(entry: PendingLifecycleEntry, reason: PendingLifecycleRejectionReason) {
		super(`Pending lifecycle command not processed: ${reason}`);
		this.name = "PendingLifecycleRejectedError";
		this.#disposition = unprocessed(entry, reason);
	}

	get disposition(): PendingLifecycleDisposition {
		return this.#disposition;
	}
}

/** No admission occurred; the original input remains caller-owned, even if not cloneable. */
export class PendingLifecycleCaptureError extends Error {
	readonly status = "unprocessed";
	readonly retryable = true;
	readonly persistence = "unknown";
	readonly releaseClientCopy = false;
	readonly #command: ClientMessage;
	readonly #correlation: PendingCommandCorrelation;

	constructor(command: ClientMessage, correlation: PendingCommandCorrelation) {
		super("Pending command capture failed; original remains caller-owned");
		this.name = "PendingLifecycleCaptureError";
		this.#command = command;
		this.#correlation = correlation;
	}

	get command(): ClientMessage {
		return this.#command;
	}

	get correlation(): PendingCommandCorrelation {
		return this.#correlation;
	}
}

function freezeJson<T>(value: T): T {
	if (value && typeof value === "object") {
		if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
			throw new TypeError("Pending commands must contain parsed JSON data");
		}
		for (const child of Object.values(value)) freezeJson(child);
		Object.freeze(value);
	}
	return value;
}

function unprocessed(
	entry: PendingLifecycleEntry,
	reason: PendingLifecycleRejectionReason,
): PendingLifecycleDisposition {
	return Object.freeze({
		entry,
		status: "unprocessed",
		retryable: true,
		reason,
		persistence: "unknown",
		releaseClientCopy: false,
	});
}

function uncertain(
	entry: PendingLifecycleEntry,
	reason: PendingLifecycleTerminalReason | "handler-returned",
): PendingLifecycleDisposition {
	return Object.freeze({
		entry,
		status: "uncertain",
		retryable: false,
		reason,
		persistence: "unknown",
		releaseClientCopy: false,
	});
}

function handoff(dispositions: PendingLifecycleDisposition[]): PendingLifecycleHandoff {
	return Object.freeze({
		kind: "handoff",
		dispositions: Object.freeze(dispositions),
		persistence: "unknown",
		releaseClientCopy: false,
	});
}

function ignored(reason: PendingLifecycleIgnored["reason"]): PendingLifecycleIgnored {
	return Object.freeze({ kind: "ignored", reason });
}

interface ActiveDispatch {
	readonly entry: PendingLifecycleEntry;
	transferred: boolean;
}

/**
 * One finite pre-attach batch per socket generation. No storage, replay or receipt.
 * Consume EVERY admission error and dispatch/terminal handoff (even on closed WS).
 * See docs/durable-ws-pending-lifecycle.md; host wiring belongs to #570.
 */
export class PendingCommandLifecycle {
	readonly #generation: string;
	readonly #queue: RecoverablePendingCommandQueue;
	readonly #buffered = new Map<ClientMessage, PendingLifecycleEntry>();
	#batch: PendingLifecycleEntry[] = [];
	#attached = false;
	#terminal: PendingLifecycleTerminalReason | null = null;
	#active: ActiveDispatch | null = null;

	constructor(generation: string, cap = MAX_PENDING_WS_MESSAGES) {
		if (typeof generation !== "string") throw new TypeError("A supplied connection generation is required");
		this.#generation = generation;
		this.#queue = new RecoverablePendingCommandQueue(cap);
	}

	get generation(): string {
		return this.#generation;
	}

	get cap(): number {
		return this.#queue.cap;
	}

	/** Payload-free accounting, not an execution/persistence status query. */
	get state() {
		const undispatched = this.#queue.size + this.#batch.length;
		const dispatching = this.#active ? 1 : 0;
		return Object.freeze({
			phase: this.#terminal ? ("terminal" as const) : this.#attached ? ("attached" as const) : ("attaching" as const),
			terminalReason: this.#terminal,
			buffered: this.#queue.size,
			undispatched,
			dispatching,
			held: undispatched + dispatching,
		});
	}

	/** Both host pre-attach branches use this. Normal return means buffered ONLY. */
	admit(command: ClientMessage, correlation: PendingCommandCorrelation): PendingLifecycleBuffered {
		if (
			typeof correlation.connectionGeneration !== "string" ||
			!(correlation.sessionId === null || typeof correlation.sessionId === "string") ||
			!(correlation.requestId === null || typeof correlation.requestId === "string")
		) {
			throw new TypeError("Supply exact session/request strings or null and a connection generation");
		}
		const capturedCorrelation = Object.freeze({
			sessionId: correlation.sessionId,
			requestId: correlation.requestId,
			connectionGeneration: correlation.connectionGeneration,
		});
		let captured: ClientMessage;
		try {
			captured = freezeJson(structuredClone(command));
		} catch {
			throw new PendingLifecycleCaptureError(command, capturedCorrelation);
		}
		const entry = Object.freeze({ command: captured, correlation: capturedCorrelation });
		const reason =
			capturedCorrelation.connectionGeneration !== this.#generation
				? "stale-generation"
				: (this.#terminal ?? (this.#attached ? "attach-complete" : null));
		if (reason) throw new PendingLifecycleRejectedError(entry, reason);
		try {
			this.#queue.push(captured);
		} catch (error) {
			if (error instanceof PendingCommandRejectedError) throw new PendingLifecycleRejectedError(entry, error.reason);
			throw error;
		}
		this.#buffered.set(captured, entry);
		return Object.freeze({ kind: "buffered", entry, persistence: "unknown", releaseClientCopy: false });
	}

	/** Seal admission and move core-buffer ownership into ONE lifecycle-held FIFO. */
	attachSucceeded(
		generation: string,
	): { readonly kind: "attached"; readonly pendingCount: number } | PendingLifecycleIgnored {
		if (generation !== this.#generation) return ignored("stale-generation");
		if (this.#terminal) return ignored("terminal");
		if (this.#attached) return ignored("attach-complete");
		this.#attached = true;
		this.#batch = this.#takeBuffered(this.#queue.drain());
		return Object.freeze({ kind: "attached", pendingCount: this.#batch.length });
	}

	/**
	 * Record dispatch-start BEFORE calling external code. Never interpret return,
	 * resolution or exception as persistence, or as proof it was not processed.
	 * A terminal event may synchronously transfer ownership while handler awaits.
	 */
	async dispatchNext(
		generation: string,
		handler: (entry: PendingLifecycleEntry) => void | Promise<void>,
	): Promise<PendingLifecycleHandoff | PendingLifecycleIgnored> {
		if (generation !== this.#generation) return ignored("stale-generation");
		if (this.#terminal) return ignored("terminal");
		if (!this.#attached) return ignored("attach-pending");
		if (this.#active) return ignored("dispatch-in-progress");
		const entry = this.#batch.shift();
		if (!entry) return ignored("empty");
		const active: ActiveDispatch = { entry, transferred: false };
		this.#active = active;
		try {
			await handler(entry);
		} catch {
			if (active.transferred) return ignored("already-transferred");
			return this.#terminate(generation, "dispatch-threw");
		}
		if (active.transferred) return ignored("already-transferred");
		active.transferred = true;
		this.#active = null;
		return handoff([uncertain(entry, "handler-returned")]);
	}

	attachFailed(generation: string): PendingLifecycleHandoff | PendingLifecycleIgnored {
		return this.#terminate(generation, "attach-failed");
	}

	socketClosed(generation: string): PendingLifecycleHandoff | PendingLifecycleIgnored {
		return this.#terminate(generation, "socket-closed");
	}

	/** Call on the OLD instance before replacing it; no global generation is inferred. */
	supersede(generation: string): PendingLifecycleHandoff | PendingLifecycleIgnored {
		return this.#terminate(generation, "generation-replaced");
	}

	#takeBuffered(commands: readonly ClientMessage[]): PendingLifecycleEntry[] {
		const entries = commands.map((command) => this.#buffered.get(command)!);
		this.#buffered.clear();
		return entries;
	}

	#terminate(
		generation: string,
		reason: PendingLifecycleTerminalReason,
	): PendingLifecycleHandoff | PendingLifecycleIgnored {
		if (generation !== this.#generation) return ignored("stale-generation");
		if (this.#terminal) return ignored("terminal");
		this.#terminal = reason;
		const dispositions: PendingLifecycleDisposition[] = [];
		if (this.#active) {
			this.#active.transferred = true;
			dispositions.push(uncertain(this.#active.entry, reason));
			this.#active = null;
		}
		const buffered = this.#takeBuffered(
			this.#queue.abandon(
				reason === "socket-closed" || reason === "generation-replaced" ? "socket-closed" : "attach-failed",
			).commands,
		);
		for (const entry of [...this.#batch, ...buffered]) dispositions.push(unprocessed(entry, reason));
		this.#batch = [];
		return handoff(dispositions);
	}
}
