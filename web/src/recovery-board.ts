/** Field-specific Board source checkpoint composition. No board post/close action, wire payload,
 * browser database or lease is created by importing/constructing this adapter. */
import type { BoardDraftSource } from "./roles-state";
import { captureRecoveryMessage } from "./recovery-admission";
import { isRecoveryEligible } from "./recovery-policy";
import type { CapturedAuthoredInput } from "./recovery-chat";
import type { ClientMessage } from "./types";
import {
	BOARD_DRAFT_PURPOSE,
	BoardDraftError,
	boardDraftKey,
	copyBoardDraftRecord,
	copyBoardDraftSource,
	encodeBoardDraftRecord,
	encodeBoardDraftSource,
	inspectBoardDrafts,
	type BoardDraftStorage,
} from "./board-draft-store";

export interface BoardSourceFailure {
	readonly source: BoardDraftSource;
	readonly submitted: boolean;
	readonly message: string;
}

export interface BoardCheckpointSnapshot {
	readonly pending: number;
	readonly failures: readonly BoardSourceFailure[];
}

function wireMatchesBoardSource(
	wire: Extract<ClientMessage, { type: "board_post" | "board_close" }>,
	source: BoardDraftSource,
): boolean {
	const f = source.form;
	if (f.type === "board_post") {
		if (wire.type !== "board_post") return false;
		if (wire.kind !== f.kind) return false;
		if (wire.title !== f.title.trim() || wire.text !== f.text.trim()) return false;
		if (f.toAll) return wire.to === "all";
		if (!Array.isArray(wire.to)) return false;
		const expectedTo = [...f.picked].sort();
		return wire.to.length === expectedTo.length && wire.to.every((id, i) => id === expectedTo[i]);
	}
	if (wire.type !== "board_close") return false;
	if (wire.id !== f.id) return false;
	const trimmedNote = f.note.trim();
	return trimmedNote ? wire.note === trimmedNote : wire.note === undefined;
}

export function createBoardSourceCheckpoints(options: {
	storage: BoardDraftStorage;
	newRecordId?: () => string;
	problem?: (message: string) => void;
}) {
	const lanes = new Map<string, Promise<boolean>>();
	// Failed submitted originals remain obligations. A later current edit must not erase them.
	const submitted = new Map<string, Map<string, BoardDraftSource>>();
	const reqTargets = new Map<string, { editorId: string; revision: number }>();
	const failures = new Map<string, BoardSourceFailure>();
	const listeners = new Set<() => void>();
	let pending = 0;
	let snapshot: BoardCheckpointSnapshot = Object.freeze({ pending, failures: Object.freeze([]) });

	function changed() {
		snapshot = Object.freeze({ pending, failures: Object.freeze([...failures.values()]) });
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				/* A view cannot alter persistence ownership. */
			}
		}
	}

	function report(message: string) {
		try {
			options.problem?.(message);
		} catch {
			/* Reporting cannot drop an original. */
		}
	}

	async function checkpoint(source: BoardDraftSource, key: string): Promise<void> {
		const raw = await options.storage.read(key);
		const prior = raw === undefined ? null : copyBoardDraftRecord(raw);
		if (prior && boardDraftKey(prior.current) !== key) throw new BoardDraftError("invalid-record");
		if (prior?.retired) throw new BoardDraftError("retired");
		const obligations = [...(submitted.get(key)?.entries() ?? [])];
		const originals = new Map<number, BoardDraftSource>();
		function add(value: BoardDraftSource) {
			if (boardDraftKey(value) !== key) throw new BoardDraftError("conflict");
			const known = originals.get(value.revision);
			if (known && encodeBoardDraftSource(known) !== encodeBoardDraftSource(value)) {
				throw new BoardDraftError("conflict");
			}
			originals.set(value.revision, value);
		}
		if (prior) {
			add(prior.current);
			for (const original of prior.submitted) add(original);
		}
		add(source);
		for (const [, original] of obligations) add(original);
		const current = [...originals.values()].reduce((a, b) => (a.revision >= b.revision ? a : b));
		const retained = new Map((prior?.submitted ?? []).map((original) => [original.revision, original]));
		for (const [, original] of obligations) retained.set(original.revision, original);
		const next = copyBoardDraftRecord({
			purpose: BOARD_DRAFT_PURPOSE,
			schemaVersion: 1,
			recordId: prior?.recordId ?? options.newRecordId?.() ?? crypto.randomUUID(),
			version: prior ? prior.version + 1 : 0,
			retired: false,
			current,
			submitted: [...retained.values()],
		});
		const expected = prior ? encodeBoardDraftRecord(prior) : null;
		// Current + EVERY accepted/failed submitted source are ONE atomic replacement.
		await options.storage.swap(key, expected, next);
		let readback: unknown;
		try {
			readback = await options.storage.read(key);
		} catch (cause) {
			throw new BoardDraftError("readback-failed", true, { cause });
		}
		try {
			if (encodeBoardDraftRecord(readback) !== encodeBoardDraftRecord(next)) {
				throw new BoardDraftError("readback-mismatch", true);
			}
		} catch (cause) {
			if (cause instanceof BoardDraftError && cause.code === "readback-mismatch") throw cause;
			throw new BoardDraftError("readback-mismatch", true, { cause });
		}
		const waiting = submitted.get(key);
		for (const [bytes] of obligations) waiting?.delete(bytes);
		if (!waiting?.size) submitted.delete(key);
		// Only sources proven retained by this exact committed readback leave the failure shelf.
		for (const [failureKey, failure] of failures) {
			if (boardDraftKey(failure.source) !== key) continue;
			const original = failure.submitted ? retained.get(failure.source.revision) : current;
			if (
				original &&
				(original.revision > failure.source.revision ||
					encodeBoardDraftSource(original) === encodeBoardDraftSource(failure.source))
			) {
				failures.delete(failureKey);
			}
		}
	}

	function persist(value: unknown, isSubmitted: boolean): Promise<boolean> {
		let source: BoardDraftSource;
		try {
			source = copyBoardDraftSource(value);
		} catch {
			report("Board source is not an admitted complete authored form. The caller must retain its original.");
			return Promise.resolve(false);
		}
		const key = boardDraftKey(source);
		const bytes = encodeBoardDraftSource(source);
		const failureKey = `${isSubmitted ? "submitted" : "current"}:${bytes}`;
		if (isSubmitted) {
			let waiting = submitted.get(key);
			if (!waiting) {
				waiting = new Map();
				submitted.set(key, waiting);
			}
			waiting.set(bytes, source);
		}
		pending++;
		changed();
		const previous = lanes.get(key);
		const job = Promise.resolve(previous).then(async () => {
			try {
				await checkpoint(source, key);
				return true;
			} catch (error) {
				const message =
					error instanceof BoardDraftError
						? error.message
						: "Board source checkpoint is uncertain. Originals retained.";
				failures.set(failureKey, Object.freeze({ source, submitted: isSubmitted, message }));
				report(message);
				return false;
			} finally {
				pending--;
				changed();
			}
		});
		lanes.set(key, job);
		void job.then(() => {
			if (lanes.get(key) === job) lanes.delete(key);
		});
		return job;
	}

	function retire(reqIdOrEditorId: string): Promise<boolean> {
		if (typeof reqIdOrEditorId !== "string" || !reqIdOrEditorId) return Promise.resolve(false);
		const target = reqTargets.get(reqIdOrEditorId) ?? { editorId: reqIdOrEditorId, revision: Number.MAX_SAFE_INTEGER };
		const key = target.editorId;
		pending++;
		changed();
		const previous = lanes.get(key);
		const job = Promise.resolve(previous).then(async () => {
			try {
				const raw = await options.storage.read(key);
				if (raw === undefined) return false;
				const prior = copyBoardDraftRecord(raw);
				if (boardDraftKey(prior.current) !== key) throw new BoardDraftError("invalid-record");
				if (prior.retired) return true;
				// Never retire a record whose current revision has advanced past the confirmed submission.
				if (prior.current.revision > target.revision) return false;
				const next = copyBoardDraftRecord({
					...prior,
					version: prior.version + 1,
					retired: true,
				});
				await options.storage.swap(key, encodeBoardDraftRecord(prior), next);
				const readback = await options.storage.read(key);
				if (encodeBoardDraftRecord(readback) !== encodeBoardDraftRecord(next)) {
					throw new BoardDraftError("readback-mismatch", true);
				}
				return true;
			} catch (error) {
				const message =
					error instanceof BoardDraftError
						? error.message
						: "Board source retirement marker could not be verified. Originals retained.";
				report(message);
				return false;
			} finally {
				pending--;
				changed();
			}
		});
		lanes.set(key, job);
		void job.then(() => {
			if (lanes.get(key) === job) lanes.delete(key);
		});
		return job;
	}

	return {
		/** Source lookup is performed by the host on its ORIGINAL message, before this copy. */
		captureOriginal(message: ClientMessage, value: unknown): CapturedAuthoredInput | null {
			try {
				const source = copyBoardDraftSource(value);
				const wire = captureRecoveryMessage(message);
				if ((wire.type !== "board_post" && wire.type !== "board_close") || !isRecoveryEligible(wire)) return null;
				if (!wireMatchesBoardSource(wire, source)) return null;
				if (typeof wire.reqId === "string" && wire.reqId) {
					reqTargets.set(wire.reqId, { editorId: source.editorId, revision: source.revision });
				}
				return { message: wire, beforeCheckpoint: () => persist(source, true) };
			} catch {
				return null;
			}
		},
		persistCurrent: (source: unknown) => persist(source, false),
		retainSubmitted: (source: unknown) => persist(source, true),
		retire,
		inspect: () => inspectBoardDrafts(options.storage),
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
