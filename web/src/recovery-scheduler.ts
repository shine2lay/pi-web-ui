/** Field-specific source checkpoint composition. No scheduler action, wire payload,
 * browser database or lease is created by importing/constructing this adapter. */
import type { SchedulerAdmissionSource } from "./components/SchedulerPanel";
import { captureRecoveryMessage } from "./recovery-admission";
import { isRecoveryEligible } from "./recovery-policy";
import type { CapturedAuthoredInput } from "./recovery-chat";
import type { ClientMessage } from "./types";
import {
	SCHEDULER_DRAFT_PURPOSE,
	SchedulerDraftError,
	copySchedulerDraftRecord,
	copySchedulerDraftSource,
	encodeSchedulerDraftRecord,
	encodeSchedulerDraftSource,
	inspectSchedulerDrafts,
	schedulerDraftKey,
	type SchedulerDraftStorage,
} from "./scheduler-draft-store";

export interface SchedulerSourceFailure {
	readonly source: SchedulerAdmissionSource;
	readonly submitted: boolean;
	readonly message: string;
}
export interface SchedulerCheckpointSnapshot {
	readonly pending: number;
	readonly failures: readonly SchedulerSourceFailure[];
}
export function createSchedulerSourceCheckpoints(options: {
	storage: SchedulerDraftStorage;
	newRecordId?: () => string;
	problem?: (message: string) => void;
}) {
	const lanes = new Map<string, Promise<boolean>>();
	// Failed submitted originals remain obligations. A later current edit must not erase them.
	const submitted = new Map<string, Map<string, SchedulerAdmissionSource>>();
	const failures = new Map<string, SchedulerSourceFailure>();
	const listeners = new Set<() => void>();
	let pending = 0;
	let snapshot: SchedulerCheckpointSnapshot = Object.freeze({ pending, failures: Object.freeze([]) });
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
	async function checkpoint(source: SchedulerAdmissionSource, key: string): Promise<void> {
		const raw = await options.storage.read(key);
		const prior = raw === undefined ? null : copySchedulerDraftRecord(raw);
		if (prior && schedulerDraftKey(prior.current) !== key) throw new SchedulerDraftError("invalid-record");
		if (prior?.retired) throw new SchedulerDraftError("retired");
		const obligations = [...(submitted.get(key)?.entries() ?? [])];
		const originals = new Map<number, SchedulerAdmissionSource>();
		function add(value: SchedulerAdmissionSource) {
			if (schedulerDraftKey(value) !== key) throw new SchedulerDraftError("conflict");
			const known = originals.get(value.revision);
			if (known && encodeSchedulerDraftSource(known) !== encodeSchedulerDraftSource(value))
				throw new SchedulerDraftError("conflict");
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
		const next = copySchedulerDraftRecord({
			purpose: SCHEDULER_DRAFT_PURPOSE,
			schemaVersion: 1,
			recordId: prior?.recordId ?? options.newRecordId?.() ?? crypto.randomUUID(),
			version: prior ? prior.version + 1 : 0,
			retired: false,
			current,
			submitted: [...retained.values()],
		});
		const expected = prior ? encodeSchedulerDraftRecord(prior) : null;
		// Current + EVERY accepted/failed submitted source are ONE atomic replacement.
		await options.storage.swap(key, expected, next);
		let readback: unknown;
		try {
			readback = await options.storage.read(key);
		} catch (cause) {
			throw new SchedulerDraftError("readback-failed", true, { cause });
		}
		try {
			if (encodeSchedulerDraftRecord(readback) !== encodeSchedulerDraftRecord(next))
				throw new SchedulerDraftError("readback-mismatch", true);
		} catch (cause) {
			if (cause instanceof SchedulerDraftError && cause.code === "readback-mismatch") throw cause;
			throw new SchedulerDraftError("readback-mismatch", true, { cause });
		}
		const waiting = submitted.get(key);
		for (const [bytes] of obligations) waiting?.delete(bytes);
		if (!waiting?.size) submitted.delete(key);
		// Only sources proven retained by this exact committed readback leave the failure shelf.
		for (const [failureKey, failure] of failures) {
			if (schedulerDraftKey(failure.source) !== key) continue;
			const original = failure.submitted ? retained.get(failure.source.revision) : current;
			if (
				original &&
				(original.revision > failure.source.revision ||
					encodeSchedulerDraftSource(original) === encodeSchedulerDraftSource(failure.source))
			)
				failures.delete(failureKey);
		}
	}
	function persist(value: unknown, isSubmitted: boolean): Promise<boolean> {
		let source: SchedulerAdmissionSource;
		try {
			source = copySchedulerDraftSource(value);
		} catch {
			report("Scheduler source is not an admitted complete authored form. The caller must retain its original.");
			return Promise.resolve(false);
		}
		const key = schedulerDraftKey(source);
		const bytes = encodeSchedulerDraftSource(source);
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
					error instanceof SchedulerDraftError
						? error.message
						: "Scheduler source checkpoint is uncertain. Originals retained.";
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
	return {
		/** Source lookup is performed by the host on its ORIGINAL message, before this copy. */
		captureOriginal(message: ClientMessage, value: unknown, workspace: string): CapturedAuthoredInput | null {
			try {
				const source = copySchedulerDraftSource(value);
				if (source.workspace !== workspace) return null;
				const wire = captureRecoveryMessage(message);
				if (wire.type !== "schedule_save" || !isRecoveryEligible(wire)) return null;
				const f = source.form;
				const expected = {
					...(f.id ? { id: f.id } : {}),
					name: f.name,
					description: f.description,
					cwd: f.cwd,
					kind: f.kind,
					spec: f.kind === "cron" ? f.cron : String(Math.max(1, Math.floor(Number(f.intervalMinutes) || 0)) * 60000),
					prompt: f.prompt,
					model: f.model,
					thinkingLevel: f.thinkingLevel,
					catchUp: f.catchUp ? "once" : "skip",
				};
				if (
					Object.keys(wire.task).length !== Object.keys(expected).length ||
					!Object.entries(expected).every(
						([key, value]) => Object.getOwnPropertyDescriptor(wire.task, key)?.value === value,
					)
				)
					return null;
				return { message: wire, beforeCheckpoint: () => persist(source, true) };
			} catch {
				return null;
			}
		},
		persistCurrent: (source: unknown) => persist(source, false),
		retainSubmitted: (source: unknown) => persist(source, true),
		inspect: () => inspectSchedulerDrafts(options.storage),
		getSnapshot: () => snapshot,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
