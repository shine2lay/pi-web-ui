/**
 * Memory Explorer — the operations behind the write routes (spec-explorer-writes.md G5, G6, Undo, "Operation States"):
 * an edit applied now with a 10 s undo, a delete held 10 s before it reaches the store, and the owner's change-record
 * line for every transition. Everything here is in memory and timed by the injected server clock; the route module
 * (explorer-write-routes.ts) only parses, gates and maps errors.
 *
 * R-EXPLORER-WRITE-3: one in-process lock per uri serialises stat -> read -> write for edit, delete and undo.
 * R-EXPLORER-WRITE-4: a line is appended only after its store call succeeded; a failed append leaves the change.
 * R-OWNER-UNDO-1: asking to confirm an undo freezes a held delete (`undo_pending`); it never runs from there.
 * Operations are kept, without their text, for the process's life so a late undo answers `410 { state }`.
 */
import { createHash, randomBytes } from "node:crypto";
import type { OpenVikingExplorerStat } from "./explorer-daemon.js";
import { explorerRefusal, operationIdOf, sameModTime } from "./explorer-rules.js";
import {
	EXPLORER_UNDO_WINDOW_MS,
	OWNER_EXPLORER_ROLE,
	OWNER_EXPLORER_SOURCE,
	type OpenVikingExplorerClock,
	type OpenVikingExplorerUri,
	type OpenVikingNoteDeleteResponse,
	type OpenVikingNoteEditResponse,
	type OpenVikingOperationState,
	type OpenVikingUndoResponse,
	type OwnerExplorerAction,
	type OwnerExplorerChangelogLine,
	type OwnerExplorerOutcome,
} from "./explorer-types.js";
import { OpenVikingDashboardError } from "./types.js";

/** The store calls an operation makes; failures arrive already mapped to the explorer's codes. */
export interface ExplorerNoteStore {
	stat(target: OpenVikingExplorerUri): Promise<OpenVikingExplorerStat>;
	read(target: OpenVikingExplorerUri): Promise<string>;
	/** `POST /api/v1/content/write`, `mode: "replace"`; never retried. */
	write(target: OpenVikingExplorerUri, content: string): Promise<void>;
	/** `DELETE /api/v1/fs`, `recursive=false`; never retried. */
	remove(target: OpenVikingExplorerUri): Promise<void>;
}

export interface ExplorerOperationsDeps {
	store: ExplorerNoteStore;
	/** Appends one change-record line; true when it was written. */
	append: (line: OwnerExplorerChangelogLine) => boolean;
	clock: OpenVikingExplorerClock;
	/** 4 random bytes for an operation id; crypto by default. */
	random?: () => Uint8Array;
}

interface OperationBase {
	id: string;
	target: OpenVikingExplorerUri;
	state: OpenVikingOperationState;
	/** Undo is open while `clock.now() < windowEndsMs` (10 s from registering, longer only while a confirmation runs). */
	windowEndsMs: number;
	timer: unknown;
	beforeSha: string;
	beforeBytes: number;
}

interface EditOperation extends OperationBase {
	kind: "edit";
	/** The text read just before the edit; dropped when the operation ends. */
	before: string | null;
	afterSha: string;
	afterBytes: number;
	afterModTime: string;
	/** Undos that came inside the window and are running; the window's end waits for them. */
	undoing: number;
}

interface DeleteOperation extends OperationBase {
	kind: "delete";
	/** The window closed and the store delete started; no undo or shutdown ends it any more. */
	closing: boolean;
}

type Operation = EditOperation | DeleteOperation;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** The code a failed store call ends a held delete with (`MEMORY_ERROR/INTERNAL`, `MEMORY_UNREACHABLE`, ...). */
function failureCode(err: unknown): string {
	if (!(err instanceof OpenVikingDashboardError)) return "INTERNAL_ERROR";
	const upstream = err.details?.upstream_code;
	return typeof upstream === "string" ? `${err.code}/${upstream}` : err.code;
}

export class ExplorerOperations {
	private readonly ops = new Map<string, Operation>();
	private readonly locks = new Map<string, Promise<void>>();
	private readonly closings = new Set<Promise<void>>();
	private readonly random: () => Uint8Array;

	constructor(private readonly deps: ExplorerOperationsDeps) {
		this.random = deps.random ?? (() => randomBytes(4));
	}

	/** G5 steps 2-6, under the uri's lock. Throws the spec's refusals; store failures arrive mapped. */
	edit(target: OpenVikingExplorerUri, content: string, openedModTime: string): Promise<OpenVikingNoteEditResponse> {
		return this.locked(target.uri, async () => {
			this.refuseIfDeletePending(target.uri);
			const stat = await this.deps.store.stat(target);
			if (stat.isDir) throw explorerRefusal("NOT_A_FILE", "A folder has no text to edit.", { uri: target.uri });
			if (!sameModTime(stat.modTime, openedModTime)) {
				throw explorerRefusal("NOTE_CHANGED", "The note changed since it was opened.", {
					current_mod_time: stat.modTime,
				});
			}
			const before = await this.deps.store.read(target);
			const beforeSha = sha256(before);
			const afterSha = sha256(content);
			if (beforeSha === afterSha) return { changed: false };
			const id = this.newId();
			try {
				await this.deps.store.write(target, content);
			} catch (err) {
				throw explorerRefusal("MEMORY_WRITE_FAILED", "The memory store did not save the note.", {
					upstream_code: failureCode(err),
				});
			}
			const summary = `owner edited a note: ${byteLength(before)} -> ${byteLength(content)} bytes`;
			let after: OpenVikingExplorerStat;
			try {
				after = await this.deps.store.stat(target);
			} catch {
				// Written but its new modTime is unknown: record the change, offer no undo that could not be checked.
				this.line(id, target, "owner_edit", "applied", null, beforeSha, afterSha, summary);
				throw explorerRefusal("MEMORY_ERROR", "The note was saved, but its new state could not be read.", {
					operation_id: id,
				});
			}
			const audit = this.line(id, target, "owner_edit", "applied", null, beforeSha, afterSha, summary);
			const op: EditOperation = {
				kind: "edit",
				id,
				target,
				state: "edited",
				windowEndsMs: this.deps.clock.now() + EXPLORER_UNDO_WINDOW_MS,
				timer: null,
				beforeSha,
				beforeBytes: byteLength(before),
				before,
				afterSha,
				afterBytes: byteLength(content),
				afterModTime: after.modTime,
				undoing: 0,
			};
			this.ops.set(id, op);
			this.armWindow(op, () => this.closeEdit(op));
			return {
				operation_id: id,
				uri: target.uri,
				changed: true,
				mod_time: after.modTime,
				undo_until: new Date(op.windowEndsMs).toISOString(),
				before_sha256: beforeSha,
				after_sha256: afterSha,
				audit_recorded: audit,
			};
		});
	}

	/** G6: checks the note now, holds the store delete until the window closes. */
	requestDelete(target: OpenVikingExplorerUri): Promise<OpenVikingNoteDeleteResponse> {
		return this.locked(target.uri, async () => {
			this.refuseIfDeletePending(target.uri);
			const stat = await this.deps.store.stat(target);
			if (stat.isDir) {
				throw explorerRefusal("FOLDER_DELETE_REFUSED", "Folders are not deleted here, only one note at a time.", {
					uri: target.uri,
				});
			}
			const text = await this.deps.store.read(target);
			const op: DeleteOperation = {
				kind: "delete",
				id: this.newId(),
				target,
				state: "pending",
				windowEndsMs: this.deps.clock.now() + EXPLORER_UNDO_WINDOW_MS,
				timer: null,
				beforeSha: sha256(text),
				beforeBytes: byteLength(text),
				closing: false,
			};
			this.ops.set(op.id, op);
			this.armWindow(op, () => this.closeDelete(op));
			return {
				operation_id: op.id,
				uri: target.uri,
				state: "pending",
				applies_at: new Date(op.windowEndsMs).toISOString(),
			};
		});
	}

	/** `POST /api/openviking/undo`: the server's clock decides; unknown ids (also after a restart) are `404`. */
	async undo(operationId: unknown): Promise<OpenVikingUndoResponse> {
		const op = this.find(operationId);
		return op.kind === "delete" ? this.undoDelete(op) : this.undoEdit(op);
	}

	/**
	 * R-OWNER-UNDO-1: the owner asked to confirm an undo (`owner/write/options`), the challenge good until
	 * `untilMs`. Inside the window a held delete moves to `undo_pending` (its store call never runs from there) and an
	 * edit's undo stays open until the challenge expires. Returns the state after the ask.
	 */
	askUndo(operationId: unknown, untilMs: number): OpenVikingOperationState {
		const op = this.find(operationId);
		if (op.kind === "delete" && op.state === "undo_pending") {
			if (untilMs > op.windowEndsMs) this.rearm(op, untilMs, () => this.expireUndoAsk(op));
			return op.state;
		}
		if (!this.undoOpen(op)) throw this.windowClosed(op);
		if (op.kind === "delete") {
			op.state = "undo_pending";
			this.rearm(op, untilMs, () => this.expireUndoAsk(op));
		} else if (untilMs > op.windowEndsMs) {
			this.rearm(op, untilMs, () => this.closeEdit(op));
		}
		return op.state;
	}

	/**
	 * The shutdown hook: every held delete not yet sent to the store ends `not_applied_restart` (synchronously, so a
	 * process `exit` listener may call it too), then deletes already sent are awaited. Calling it again is a no-op.
	 */
	shutdown(): Promise<void> {
		for (const op of this.ops.values()) {
			if (op.kind !== "delete" || op.closing) continue;
			if (op.state !== "pending" && op.state !== "undo_pending") continue;
			this.end(op, "not_applied_restart");
			this.line(
				op.id,
				op.target,
				"owner_delete",
				"not_applied_restart",
				null,
				op.beforeSha,
				op.beforeSha,
				`owner delete not applied, server stopped: ${op.beforeBytes} bytes kept`,
			);
		}
		return Promise.allSettled(this.closings).then(() => undefined);
	}

	/** An operation's state (tests and the confirmation route); null for an unknown id. */
	stateOf(operationId: string): OpenVikingOperationState | null {
		return this.ops.get(operationId)?.state ?? null;
	}

	// ---- transitions ----

	private undoDelete(op: DeleteOperation): OpenVikingUndoResponse {
		if (op.state !== "undo_pending" && !this.undoOpen(op)) throw this.windowClosed(op);
		this.cancelDelete(op, "applied");
		return { operation_id: op.id, state: "cancelled" };
	}

	private async undoEdit(op: EditOperation): Promise<OpenVikingUndoResponse> {
		if (!this.undoOpen(op)) throw this.windowClosed(op);
		op.undoing++;
		try {
			return await this.locked(op.target.uri, async () => {
				if (op.state !== "edited" || op.before === null) throw this.windowClosed(op);
				this.refuseIfDeletePending(op.target.uri);
				const now = await this.deps.store.stat(op.target);
				if (!sameModTime(now.modTime, op.afterModTime)) {
					this.end(op, "undo_refused");
					this.line(
						op.id,
						op.target,
						"owner_undo",
						"refused",
						"edit",
						null,
						null,
						`owner undo refused: the note changed since the edit (${now.size ?? "?"} bytes now)`,
					);
					throw explorerRefusal("UNDO_REFUSED", "The note changed since the edit; nothing was written.", {
						current_mod_time: now.modTime,
					});
				}
				try {
					await this.deps.store.write(op.target, op.before);
				} catch (err) {
					throw explorerRefusal("MEMORY_WRITE_FAILED", "The memory store did not save the undo.", {
						upstream_code: failureCode(err),
					});
				}
				this.end(op, "undone");
				this.line(
					op.id,
					op.target,
					"owner_undo",
					"applied",
					"edit",
					op.afterSha,
					op.beforeSha,
					`owner undid an edit: ${op.afterBytes} -> ${op.beforeBytes} bytes`,
				);
				const after = await this.deps.store.stat(op.target);
				return { operation_id: op.id, state: "undone", mod_time: after.modTime };
			});
		} finally {
			op.undoing--;
			if (op.state === "edited" && this.deps.clock.now() >= op.windowEndsMs) this.closeEdit(op);
		}
	}

	/** The window's end for an edit: undo closes, the kept text is dropped. Waits for an undo already running. */
	private closeEdit(op: EditOperation): void {
		op.timer = null;
		if (op.state !== "edited" || op.undoing > 0) return;
		this.end(op, "closed");
	}

	/** The window's end for a held delete: the one store delete, under the uri's lock, then its line. */
	private closeDelete(op: DeleteOperation): void {
		op.timer = null;
		if (op.state !== "pending") return;
		op.closing = true;
		const run = this.locked(op.target.uri, async () => {
			try {
				await this.deps.store.remove(op.target);
			} catch (err) {
				this.end(op, "failed");
				this.line(
					op.id,
					op.target,
					"owner_delete",
					"failed",
					null,
					op.beforeSha,
					null,
					`owner delete failed (${failureCode(err)}): ${op.beforeBytes} bytes kept`,
				);
				return;
			}
			this.end(op, "applied");
			this.line(
				op.id,
				op.target,
				"owner_delete",
				"applied",
				null,
				op.beforeSha,
				null,
				`owner deleted a note: ${op.beforeBytes} bytes`,
			);
		});
		this.closings.add(run);
		const done = () => void this.closings.delete(run);
		run.then(done, done);
	}

	/** Confirmation challenge expired unused: the delete is cancelled all the same, recorded as unconfirmed. */
	private expireUndoAsk(op: DeleteOperation): void {
		op.timer = null;
		if (op.state === "undo_pending") this.cancelDelete(op, "unconfirmed");
	}

	private cancelDelete(op: DeleteOperation, undoOutcome: "applied" | "unconfirmed"): void {
		this.end(op, "cancelled");
		const kept = `${op.beforeBytes} bytes kept`;
		const undid = undoOutcome === "applied" ? "owner undid a delete" : "owner undo of a delete was never confirmed";
		this.line(op.id, op.target, "owner_undo", undoOutcome, "delete", null, null, `${undid}: ${kept}`);
		this.line(
			op.id,
			op.target,
			"owner_delete",
			"cancelled",
			null,
			op.beforeSha,
			op.beforeSha,
			`owner delete cancelled: ${kept}`,
		);
	}

	// ---- helpers ----

	private undoOpen(op: Operation): boolean {
		const open = op.kind === "delete" ? op.state === "pending" && !op.closing : op.state === "edited";
		return open && this.deps.clock.now() < op.windowEndsMs;
	}

	/** `410 UNDO_WINDOW_CLOSED { state }`; an edit whose window ran out but whose timer has not fired reads `closed`. */
	private windowClosed(op: Operation): OpenVikingDashboardError {
		const state = op.state === "edited" ? "closed" : op.state;
		return explorerRefusal("UNDO_WINDOW_CLOSED", "The undo window has closed.", { state });
	}

	private find(operationId: unknown): Operation {
		const op = typeof operationId === "string" ? this.ops.get(operationId) : undefined;
		if (!op) throw explorerRefusal("OPERATION_UNKNOWN", "No such operation (the server may have restarted).");
		return op;
	}

	private refuseIfDeletePending(uri: string): void {
		for (const op of this.ops.values()) {
			if (op.kind === "delete" && op.target.uri === uri && (op.state === "pending" || op.state === "undo_pending")) {
				throw explorerRefusal("DELETE_PENDING", "A delete of this note is pending.", { operation_id: op.id });
			}
		}
	}

	private end(op: Operation, state: OpenVikingOperationState): void {
		op.state = state;
		if (op.timer !== null) this.deps.clock.clearTimer(op.timer);
		op.timer = null;
		if (op.kind === "edit") op.before = null;
	}

	private armWindow(op: Operation, onEnd: () => void): void {
		op.timer = this.deps.clock.setTimer(op.windowEndsMs - this.deps.clock.now(), onEnd);
	}

	private rearm(op: Operation, untilMs: number, onEnd: () => void): void {
		if (op.timer !== null) this.deps.clock.clearTimer(op.timer);
		op.windowEndsMs = untilMs;
		this.armWindow(op, onEnd);
	}

	private newId(): string {
		for (;;) {
			const id = operationIdOf(this.deps.clock.now(), this.random());
			if (!this.ops.has(id)) return id;
		}
	}

	/** R-EXPLORER-WRITE-3: runs `fn` after every earlier call for `uri` has settled. */
	private locked<T>(uri: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.locks.get(uri) ?? Promise.resolve()).then(fn);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		this.locks.set(uri, tail);
		void tail.then(() => {
			if (this.locks.get(uri) === tail) this.locks.delete(uri);
		});
		return run;
	}

	private line(
		id: string,
		target: OpenVikingExplorerUri,
		action: OwnerExplorerAction,
		outcome: OwnerExplorerOutcome,
		undoOf: "edit" | "delete" | null,
		beforeSha: string | null,
		afterSha: string | null,
		summary: string,
	): boolean {
		return this.deps.append({
			timestamp: new Date(this.deps.clock.now()).toISOString(),
			role: OWNER_EXPLORER_ROLE,
			source: OWNER_EXPLORER_SOURCE,
			action,
			operation_id: id,
			uri: target.uri,
			outcome,
			undo_of: undoOf,
			before_sha256: beforeSha,
			after_sha256: afterSha,
			summary,
			diff: null,
			task_id: null,
			session_id: null,
		});
	}
}
