import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "../../server/protocol.js";
import {
	PendingCommandLifecycle,
	PendingLifecycleCaptureError,
	PendingLifecycleRejectedError,
	type PendingCommandCorrelation,
	type PendingLifecycleDisposition,
	type PendingLifecycleEntry,
	type PendingLifecycleHandoff,
	type PendingLifecycleIgnored,
} from "../../server/ws-pending-lifecycle.js";
import {
	MAX_PENDING_WS_MESSAGES,
	PENDING_DROP_WARN_INTERVAL_MS,
	PendingCommandQueue,
	resetPendingDropWarn,
} from "../../server/ws-pending-queue.js";

const GENERATION = "synthetic-generation-A";
const OTHER_GENERATION = "synthetic-generation-B";

function command(index: number): Extract<ClientMessage, { type: "prompt" }> {
	return {
		type: "prompt",
		id: `original-${index}`,
		forSession: `command-session-${index % 2}`,
		text: `  exact ${index}: 中文 🍋\r\nsecond line\u0000  `,
		queue: index % 2 === 0,
		attachments: [
			{ path: `src/${index}.ts`, mode: "lines", lines: { start: 2, end: 9 }, name: "原文.txt" },
			{ path: "", imageData: "AAECAwQ=", mimeType: "image/png", name: "粘贴.png" },
			{ path: "", fileData: "AAoN/4A=", mimeType: "application/octet-stream", name: "bytes.bin", size: 5 },
		],
	};
}

function correlation(index: number, generation = GENERATION): PendingCommandCorrelation {
	return {
		sessionId: `supplied-session-${index % 2}`,
		requestId: `supplied-request-${index}`,
		connectionGeneration: generation,
	};
}

function fill(lifecycle: PendingCommandLifecycle, count = 4): PendingLifecycleEntry[] {
	return Array.from(
		{ length: count },
		(_, i) => lifecycle.admit(command(i), correlation(i, lifecycle.generation)).entry,
	);
}

function transfers(result: PendingLifecycleHandoff | PendingLifecycleIgnored): readonly PendingLifecycleDisposition[] {
	expect(result.kind).toBe("handoff");
	if (result.kind !== "handoff") throw new Error("Expected a one-time ownership handoff");
	expect(result.persistence).toBe("unknown");
	expect(result.releaseClientCopy).toBe(false);
	return result.dispositions;
}

function expectAccounted(
	lifecycle: PendingCommandLifecycle,
	admitted: readonly PendingLifecycleEntry[],
	reported: readonly PendingLifecycleDisposition[],
): void {
	expect(lifecycle.state.held + reported.length).toBe(admitted.length);
	expect(lifecycle.state.held).toBeLessThanOrEqual(lifecycle.cap);
	expect(new Set(reported.map((item) => item.entry)).size).toBe(reported.length);
	for (const disposition of reported) {
		expect(admitted).toContain(disposition.entry);
		expect(disposition.persistence).toBe("unknown");
		expect(disposition.releaseClientCopy).toBe(false);
		expect(disposition.retryable).toBe(disposition.status === "unprocessed");
		const index = admitted.indexOf(disposition.entry);
		expect(disposition.entry.command).toEqual(command(index));
		expect(disposition.entry.correlation).toEqual(correlation(index, lifecycle.generation));
	}
}

function refusal(
	lifecycle: PendingCommandLifecycle,
	sent: ClientMessage,
	supplied: PendingCommandCorrelation,
): PendingLifecycleDisposition {
	let caught: unknown;
	try {
		lifecycle.admit(sent, supplied);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PendingLifecycleRejectedError);
	return (caught as PendingLifecycleRejectedError).disposition;
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

beforeEach(() => resetPendingDropWarn());
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	resetPendingDropWarn();
});

describe("PendingCommandLifecycle: admission and attach ownership", () => {
	it("handles empty, pre-attach, attached and terminal states without dispatch or proof", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const handler = vi.fn();
		expect(lifecycle.cap).toBe(256);
		expect(lifecycle.state).toMatchObject({ phase: "attaching", held: 0 });
		expect(await lifecycle.dispatchNext(GENERATION, handler)).toEqual({ kind: "ignored", reason: "attach-pending" });
		expect(lifecycle.attachSucceeded(GENERATION)).toEqual({ kind: "attached", pendingCount: 0 });
		expect(await lifecycle.dispatchNext(GENERATION, handler)).toEqual({ kind: "ignored", reason: "empty" });
		expect(transfers(lifecycle.socketClosed(GENERATION))).toEqual([]);
		expect(lifecycle.socketClosed(GENERATION)).toEqual({ kind: "ignored", reason: "terminal" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("moves exact FIFO content from buffer to lifecycle batch, then transfers uncertainty once per handler", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		const reports: PendingLifecycleDisposition[] = [];
		const observed: PendingLifecycleEntry[] = [];
		expect(lifecycle.state).toMatchObject({ buffered: 4, undispatched: 4, dispatching: 0, held: 4 });
		expect(lifecycle.attachSucceeded(GENERATION)).toEqual({ kind: "attached", pendingCount: 4 });
		expect(lifecycle.state).toMatchObject({ buffered: 0, undispatched: 4, held: 4 });
		for (let i = 0; i < admitted.length; i++) {
			const result = await lifecycle.dispatchNext(GENERATION, (entry) => {
				expect(lifecycle.state).toMatchObject({ dispatching: 1, undispatched: admitted.length - i - 1 });
				observed.push(entry);
			});
			reports.push(...transfers(result));
			expect(reports[i]).toMatchObject({ status: "uncertain", retryable: false, reason: "handler-returned" });
			expectAccounted(lifecycle, admitted, reports);
		}
		expect(observed).toEqual(admitted);
		expect(await lifecycle.dispatchNext(GENERATION, vi.fn())).toEqual({ kind: "ignored", reason: "empty" });
		expect(transfers(lifecycle.socketClosed(GENERATION))).toEqual([]);
	});

	it.each(["no-client-id", "no-session-or-attach-pending"] as const)("host %s admission", (branch) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const sent = command(0);
		const supplied = { sessionId: null, requestId: null, connectionGeneration: GENERATION };
		const clientId = branch === "no-client-id" ? null : "synthetic-client";
		const session = null;
		const attachDone = false;
		let result;
		if (!clientId) result = lifecycle.admit(sent, supplied);
		else if (!session || !attachDone) result = lifecycle.admit(sent, supplied);
		expect(result).toMatchObject({ kind: "buffered", persistence: "unknown", releaseClientCopy: false });
		expect(result?.entry.correlation).toEqual(supplied);
		expect(result?.entry.correlation.sessionId).not.toBe(sent.forSession);
		expect(result?.entry.correlation.requestId).not.toBe(sent.id);
		expect(transfers(lifecycle.socketClosed(GENERATION))[0].entry).toBe(result?.entry);
	});

	it.each([1, 2, MAX_PENDING_WS_MESSAGES])("capacity %i: no accepted eviction", (cap) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const lifecycle = new PendingCommandLifecycle(GENERATION, cap);
		const admitted = fill(lifecycle, cap);
		const refused = command(900);
		let error: unknown;
		try {
			lifecycle.admit(refused, correlation(900));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PendingLifecycleRejectedError);
		const disposition = (error as PendingLifecycleRejectedError).disposition;
		expect(disposition).toMatchObject({
			status: "unprocessed",
			retryable: true,
			reason: "capacity",
			persistence: "unknown",
			releaseClientCopy: false,
		});
		expect(disposition.entry).toEqual({ command: refused, correlation: correlation(900) });
		expect(lifecycle.state.held).toBe(cap);
		const reports = transfers(lifecycle.socketClosed(GENERATION));
		expect(reports.map((item) => item.entry)).toEqual(admitted);
		expectAccounted(lifecycle, admitted, reports);
	});

	it("preserves the shared 60s warning and exact refusal even if the logger throws", () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {
			throw new Error("logger unavailable");
		});
		const lifecycle = new PendingCommandLifecycle(GENERATION, 1);
		fill(lifecycle, 1);
		for (let i = 0; i < 3; i++)
			expect(() => lifecycle.admit(command(99), correlation(99))).toThrow(PendingLifecycleRejectedError);
		expect(warn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(PENDING_DROP_WARN_INTERVAL_MS);
		expect(() => lifecycle.admit(command(100), correlation(100))).toThrow(PendingLifecycleRejectedError);
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls.flat().join(" ")).not.toContain(command(99).text);
		expect(warn.mock.calls.flat().join(" ")).not.toContain("dropped");
		expect(transfers(lifecycle.socketClosed(GENERATION))).toHaveLength(1);
	});

	it.each([0, -1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("invalid cap %s", (cap) => {
		expect(() => new PendingCommandLifecycle(GENERATION, cap)).toThrow(RangeError);
	});

	it("seals admission at attach without creating a second retained batch", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION, 1);
		const admitted = fill(lifecycle, 1);
		lifecycle.attachSucceeded(GENERATION);
		for (let i = 0; i < 300; i++) {
			expect(refusal(lifecycle, command(i + 1), correlation(i + 1)).reason).toBe("attach-complete");
		}
		expect(lifecycle.state.held).toBe(1);
		expect(transfers(lifecycle.socketClosed(GENERATION)).map((item) => item.entry)).toEqual(admitted);
	});

	it("captures full immutable content and supplied correlation independently of later mutations", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const sent = command(0);
		const original = structuredClone(sent);
		const supplied = { sessionId: "supplied-original", requestId: "same-id", connectionGeneration: GENERATION };
		const expectedCorrelation = { ...supplied };
		const buffered = lifecycle.admit(sent, supplied);
		sent.text = "changed";
		sent.id = "changed";
		sent.forSession = "changed";
		sent.attachments![0].lines!.start = 500;
		sent.attachments![1].imageData = "CHANGED";
		sent.attachments!.pop();
		supplied.sessionId = "changed";
		supplied.requestId = "changed";
		supplied.connectionGeneration = OTHER_GENERATION;
		expect(buffered.entry).toEqual({ command: original, correlation: expectedCorrelation });
		expect(Object.isFrozen(buffered.entry)).toBe(true);
		expect(Object.isFrozen(buffered.entry.correlation)).toBe(true);
		expect(() => {
			(buffered.entry.command as typeof sent).text = "mutated-through-result";
		}).toThrow(TypeError);
		expect(() => {
			(buffered.entry.command as typeof sent).attachments![0].lines!.end = 999;
		}).toThrow(TypeError);
		lifecycle.attachSucceeded(GENERATION);
		const reports = transfers(
			await lifecycle.dispatchNext(GENERATION, (entry) => {
				expect(entry).toBe(buffered.entry);
				expect(entry).toEqual({ command: original, correlation: expectedCorrelation });
			}),
		);
		expect(reports[0].entry).toBe(buffered.entry);
	});

	it("rejects uncloneable input before admission and keeps the original with a payload-private capture error", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const invalid = { ...command(0), unsupported: () => "not wire JSON" };
		let error: unknown;
		try {
			lifecycle.admit(invalid, correlation(0));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PendingLifecycleCaptureError);
		const capture = error as PendingLifecycleCaptureError;
		expect(capture.command).toBe(invalid);
		expect(capture.correlation).toEqual(correlation(0));
		expect(capture).toMatchObject({
			status: "unprocessed",
			retryable: true,
			persistence: "unknown",
			releaseClientCopy: false,
		});
		expect(lifecycle.state.held).toBe(0);
		expect(inspect(capture) + JSON.stringify(capture)).not.toContain("exact 0");
	});

	it("rejects mutable non-JSON content before admission rather than promise an immutable Map", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const invalid = { ...command(0), unsupported: new Map([["original", "bytes"]]) };
		expect(() => lifecycle.admit(invalid, correlation(0))).toThrow(PendingLifecycleCaptureError);
		expect(lifecycle.state.held).toBe(0);
	});

	it("keeps original command content out of ordinary rejection inspection and state", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		lifecycle.socketClosed(GENERATION);
		let error: unknown;
		try {
			lifecycle.admit(command(0), correlation(0));
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PendingLifecycleRejectedError);
		expect((error as PendingLifecycleRejectedError).disposition.entry.command).toEqual(command(0));
		expect(
			inspect(error) + JSON.stringify(error) + JSON.stringify(lifecycle) + JSON.stringify(lifecycle.state),
		).not.toContain("exact 0");
	});

	it("preserves heterogeneous non-idempotent commands without selecting or rewriting their content", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const original: ClientMessage[] = [
			command(0),
			{
				type: "edit_message",
				messageId: "exact-old-question",
				text: "\t编辑\r\n",
				attachments: command(0).attachments,
			},
			{ type: "new_chat", preset: "synthetic-preset", ephemeral: false },
			{ type: "prompt_status", ids: ["one", "two", "one"] },
		];
		original.forEach((sent, i) => lifecycle.admit(sent, correlation(i)));
		const reports = transfers(lifecycle.attachFailed(GENERATION));
		expect(reports.map((item) => item.entry.command)).toEqual(original);
		expect(reports.map((item) => item.entry.correlation)).toEqual(original.map((_, i) => correlation(i)));
		expect(reports.every((item) => item.status === "unprocessed")).toBe(true);
	});

	it("has no extra content-size limit or payload truncation", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION, 1);
		const sent = { ...command(0), text: "synthetic full content 🦊\r\n".repeat(10_000) };
		const captured = lifecycle.admit(sent, correlation(0));
		const report = transfers(lifecycle.socketClosed(GENERATION))[0];
		expect(report.entry).toBe(captured.entry);
		expect(report.entry.command).toEqual(sent);
	});

	it("does not infer missing correlation, normalize empty strings, or deduplicate equal IDs/text", () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const sent = command(0);
		const supplied = [
			correlation(0),
			{ ...correlation(0), sessionId: "other-session" },
			{ sessionId: null, requestId: null, connectionGeneration: GENERATION },
			{ sessionId: "", requestId: "", connectionGeneration: GENERATION },
		];
		const admitted = supplied.map((item) => lifecycle.admit(sent, item).entry);
		const reports = transfers(lifecycle.socketClosed(GENERATION));
		expect(new Set(admitted).size).toBe(4);
		expect(reports.map((item) => item.entry.correlation)).toEqual(supplied);
		expect(reports.map((item) => item.entry.command)).toEqual(supplied.map(() => sent));
	});
});

describe("PendingCommandLifecycle: terminal and generation fences", () => {
	it.each(["attachFailed", "socketClosed", "supersede"] as const)("%s before attach", async (method) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		const reports = transfers(lifecycle[method](GENERATION));
		expect(reports.every((item) => item.status === "unprocessed")).toBe(true);
		expectAccounted(lifecycle, admitted, reports);
		const handler = vi.fn();
		expect(lifecycle.attachSucceeded(GENERATION)).toEqual({ kind: "ignored", reason: "terminal" });
		expect(await lifecycle.dispatchNext(GENERATION, handler)).toEqual({ kind: "ignored", reason: "terminal" });
		for (const terminal of ["attachFailed", "socketClosed", "supersede"] as const)
			expect(lifecycle[terminal](GENERATION)).toEqual({ kind: "ignored", reason: "terminal" });
		expect(() => lifecycle.admit(command(99), correlation(99))).toThrow(PendingLifecycleRejectedError);
		expect(handler).not.toHaveBeenCalled();
	});

	it.each(["attachFailed", "socketClosed", "supersede"] as const)("%s after drain", (method) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const reports = transfers(lifecycle[method](GENERATION));
		expect(reports.map((item) => item.entry)).toEqual(admitted);
		expect(reports.every((item) => item.status === "unprocessed")).toBe(true);
		expectAccounted(lifecycle, admitted, reports);
	});

	it("duplicate attach/plugin success/fallback completions cannot replace a partially drained batch", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const reports = [...transfers(await lifecycle.dispatchNext(GENERATION, () => {}))];
		expect(lifecycle.attachSucceeded(GENERATION)).toEqual({ kind: "ignored", reason: "attach-complete" });
		reports.push(...transfers(lifecycle.socketClosed(GENERATION)));
		expect(reports.map((item) => item.entry)).toEqual(admitted);
		expectAccounted(lifecycle, admitted, reports);
	});

	it("stale-generation attach, dispatch, close and failure calls cannot alter current ownership", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		const handler = vi.fn();
		expect(lifecycle.attachSucceeded(OTHER_GENERATION)).toEqual({ kind: "ignored", reason: "stale-generation" });
		for (const method of ["attachFailed", "socketClosed", "supersede"] as const)
			expect(lifecycle[method](OTHER_GENERATION)).toEqual({ kind: "ignored", reason: "stale-generation" });
		expect(await lifecycle.dispatchNext(OTHER_GENERATION, handler)).toEqual({
			kind: "ignored",
			reason: "stale-generation",
		});
		expect(refusal(lifecycle, command(9), correlation(9, OTHER_GENERATION))).toMatchObject({
			status: "unprocessed",
			reason: "stale-generation",
			entry: { command: command(9), correlation: correlation(9, OTHER_GENERATION) },
		});
		expect(lifecycle.state.held).toBe(admitted.length);
		expect(handler).not.toHaveBeenCalled();
		expectAccounted(lifecycle, admitted, transfers(lifecycle.socketClosed(GENERATION)));
	});

	it("new generation cannot be dispatched/closed by old callbacks, and old late settlement cannot touch new entries", async () => {
		const old = new PendingCommandLifecycle(GENERATION);
		const oldEntries = fill(old, 2);
		old.attachSucceeded(GENERATION);
		const wait = deferred();
		const oldDispatch = old.dispatchNext(GENERATION, () => wait.promise);
		const oldReports = transfers(old.supersede(GENERATION));
		const current = new PendingCommandLifecycle(OTHER_GENERATION);
		const newEntries = fill(current, 2);
		expect(current.attachSucceeded(GENERATION)).toEqual({ kind: "ignored", reason: "stale-generation" });
		expect(current.socketClosed(GENERATION)).toEqual({ kind: "ignored", reason: "stale-generation" });
		wait.resolve();
		expect(await oldDispatch).toEqual({ kind: "ignored", reason: "already-transferred" });
		expect(old.attachSucceeded(GENERATION)).toEqual({ kind: "ignored", reason: "terminal" });
		expectAccounted(old, oldEntries, oldReports);
		expect(current.state.held).toBe(2);
		expectAccounted(current, newEntries, transfers(current.socketClosed(OTHER_GENERATION)));
	});
});

describe("PendingCommandLifecycle: every drain/dispatch boundary", () => {
	it.each([0, 1, 2, 3, 4])("close after %i calls: exact suffix", async (completed) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const handler = vi.fn();
		const reports: PendingLifecycleDisposition[] = [];
		for (let i = 0; i < completed; i++) reports.push(...transfers(await lifecycle.dispatchNext(GENERATION, handler)));
		reports.push(...transfers(lifecycle.socketClosed(GENERATION)));
		expect(reports.map((item) => item.entry)).toEqual(admitted);
		expect(reports.map((item) => item.status)).toEqual(
			admitted.map((_, i) => (i < completed ? "uncertain" : "unprocessed")),
		);
		expect(handler).toHaveBeenCalledTimes(completed);
		expectAccounted(lifecycle, admitted, reports);
		expect(await lifecycle.dispatchNext(GENERATION, handler)).toEqual({ kind: "ignored", reason: "terminal" });
		expect(handler).toHaveBeenCalledTimes(completed);
	});

	it.each([0, 1, 2, 3])("reentrant close at %i: one handoff", async (activeIndex) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const reports: PendingLifecycleDisposition[] = [];
		for (let i = 0; i < activeIndex; i++)
			reports.push(...transfers(await lifecycle.dispatchNext(GENERATION, () => {})));
		const result = await lifecycle.dispatchNext(GENERATION, (entry) => {
			expect(entry).toBe(admitted[activeIndex]);
			expect(lifecycle.state.dispatching).toBe(1);
			reports.push(...transfers(lifecycle.socketClosed(GENERATION)));
		});
		expect(result).toEqual({ kind: "ignored", reason: "already-transferred" });
		expect(reports.map((item) => item.entry)).toEqual(admitted);
		expect(reports.map((item) => item.status)).toEqual(
			admitted.map((_, i) => (i <= activeIndex ? "uncertain" : "unprocessed")),
		);
		expectAccounted(lifecycle, admitted, reports);
	});

	it.each(["resolve", "reject"] as const)("close during await then %s", async (settlement) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const wait = deferred();
		const handler = vi.fn(() => wait.promise);
		const running = lifecycle.dispatchNext(GENERATION, handler);
		expect(lifecycle.state).toMatchObject({ dispatching: 1, undispatched: 3, held: 4 });
		expect(await lifecycle.dispatchNext(GENERATION, handler)).toEqual({
			kind: "ignored",
			reason: "dispatch-in-progress",
		});
		const reports = transfers(lifecycle.socketClosed(GENERATION));
		if (settlement === "resolve") wait.resolve();
		else wait.reject(new Error("late failure with no execution proof"));
		expect(await running).toEqual({ kind: "ignored", reason: "already-transferred" });
		expect(lifecycle.attachFailed(GENERATION)).toEqual({ kind: "ignored", reason: "terminal" });
		expect(reports.map((item) => item.status)).toEqual(["uncertain", "unprocessed", "unprocessed", "unprocessed"]);
		expect(handler).toHaveBeenCalledTimes(1);
		expectAccounted(lifecycle, admitted, reports);
	});

	it("close after handler returns but before async continuation still owns the started entry only once", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const handler = vi.fn();
		const running = lifecycle.dispatchNext(GENERATION, handler);
		const reports = transfers(lifecycle.socketClosed(GENERATION));
		expect(await running).toEqual({ kind: "ignored", reason: "already-transferred" });
		expect(reports[0]).toMatchObject({ status: "uncertain", reason: "socket-closed" });
		expectAccounted(lifecycle, admitted, reports);
	});

	it.each(["attachFailed", "supersede"] as const)("reentrant %s then throw", async (method) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		let reports: readonly PendingLifecycleDisposition[] = [];
		expect(
			await lifecycle.dispatchNext(GENERATION, () => {
				reports = transfers(lifecycle[method](GENERATION));
				throw new Error("throw after ownership transferred");
			}),
		).toEqual({ kind: "ignored", reason: "already-transferred" });
		expectAccounted(lifecycle, admitted, reports);
	});

	it.each([0, 1, 2, 3])("throw at %i: uncertain + exact suffix", async (activeIndex) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const reports: PendingLifecycleDisposition[] = [];
		for (let i = 0; i < activeIndex; i++)
			reports.push(...transfers(await lifecycle.dispatchNext(GENERATION, () => {})));
		reports.push(
			...transfers(
				await lifecycle.dispatchNext(GENERATION, () => {
					throw new Error("no proof whether accepted");
				}),
			),
		);
		expect(reports.map((item) => item.entry)).toEqual(admitted);
		expect(reports.map((item) => item.status)).toEqual(
			admitted.map((_, i) => (i <= activeIndex ? "uncertain" : "unprocessed")),
		);
		expect(reports[activeIndex]).toMatchObject({ status: "uncertain", reason: "dispatch-threw", retryable: false });
		expect(lifecycle.state).toMatchObject({ phase: "terminal", terminalReason: "dispatch-threw", held: 0 });
		expectAccounted(lifecycle, admitted, reports);
	});

	it.each([false, true])("acceptance=%s then throw: no replay", async (accepted) => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		let effects = 0;
		const handler = vi.fn(() => {
			if (accepted) effects++;
			throw new Error("transport/handler failed");
		});
		const reports = transfers(await lifecycle.dispatchNext(GENERATION, handler));
		expect(reports[0]).toMatchObject({ status: "uncertain", retryable: false });
		await lifecycle.dispatchNext(GENERATION, handler);
		lifecycle.attachSucceeded(GENERATION);
		lifecycle.attachFailed(GENERATION);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(effects).toBe(accepted ? 1 : 0);
		expectAccounted(lifecycle, admitted, reports);
	});

	it("awaited rejection remains uncertain and safely transfers the suffix", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		const admitted = fill(lifecycle);
		lifecycle.attachSucceeded(GENERATION);
		const reports = transfers(
			await lifecycle.dispatchNext(GENERATION, async () => {
				throw new Error("async refusal is not nonacceptance proof");
			}),
		);
		expect(reports[0].status).toBe("uncertain");
		expectAccounted(lifecycle, admitted, reports);
	});

	it("a handler's invented persisted/deletion result is ignored, never upgraded into an acknowledgement", async () => {
		const lifecycle = new PendingCommandLifecycle(GENERATION);
		fill(lifecycle, 1);
		lifecycle.attachSucceeded(GENERATION);
		const reports = transfers(
			await lifecycle.dispatchNext(GENERATION, (() => ({
				persisted: true,
				releaseClientCopy: true,
			})) as unknown as () => void),
		);
		expect(reports[0]).toMatchObject({ status: "uncertain", persistence: "unknown", releaseClientCopy: false });
	});
});

/*
 * The SAME fixed-input preservation assertions can run against a thin legacy
 * consumer. It has the complete test-driver API, so red controls are behavioral
 * failures (eviction/clear/lost local suffix), NOT missing-method/import failures.
 * Default/full gate uses the adapter. Explicit opt-in only demonstrates baseline red.
 */
class ThinConsumer {
	readonly lifecycle = new PendingCommandLifecycle(GENERATION, 2);
	readonly legacy = new PendingCommandQueue(2);
	readonly useLegacy = process.env.WS_PENDING_LIFECYCLE_LEGACY_CONTROL === "1";
	readonly refused: ClientMessage[] = [];
	readonly recovered: ClientMessage[] = [];
	readonly uncertain: ClientMessage[] = [];

	admit(sent: ClientMessage): void {
		if (this.useLegacy) {
			this.legacy.push(sent);
			return;
		}
		try {
			this.lifecycle.admit(sent, { sessionId: null, requestId: null, connectionGeneration: GENERATION });
		} catch (error) {
			if (!(error instanceof PendingLifecycleRejectedError)) throw error;
			this.refused.push(error.disposition.entry.command);
		}
	}

	record(result: PendingLifecycleHandoff | PendingLifecycleIgnored): void {
		if (result.kind !== "handoff") return;
		for (const item of result.dispositions)
			(item.status === "unprocessed" ? this.recovered : this.uncertain).push(item.entry.command);
	}

	close(): void {
		if (this.useLegacy) this.legacy.clear();
		else this.record(this.lifecycle.socketClosed(GENERATION));
	}

	fail(): void {
		if (this.useLegacy) this.legacy.clear();
		else this.record(this.lifecycle.attachFailed(GENERATION));
	}

	async run(handler: (sent: ClientMessage) => void): Promise<void> {
		if (this.useLegacy) {
			try {
				for (const sent of this.legacy.drain()) handler(sent);
			} catch {
				/* the old queue cannot recover this consumer's local suffix */
			}
			return;
		}
		this.lifecycle.attachSucceeded(GENERATION);
		while (true) {
			const result = await this.lifecycle.dispatchNext(GENERATION, (entry) => handler(entry.command));
			if (result.kind === "ignored") return;
			this.record(result);
		}
	}
}

describe("thin consumer preservation contract", () => {
	it("capacity refusal keeps the new original and both accepted originals", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const driver = new ThinConsumer();
		for (let i = 0; i < 3; i++) driver.admit(command(i));
		driver.close();
		expect(driver.refused).toEqual([command(2)]);
		expect(driver.recovered).toEqual([command(0), command(1)]);
	});

	it.each(["close", "fail"] as const)("%s hands off all admitted full payloads instead of clear", (method) => {
		const driver = new ThinConsumer();
		driver.admit(command(0));
		driver.admit(command(1));
		driver[method]();
		expect(driver.recovered).toEqual([command(0), command(1)]);
	});

	it("dispatch exception retains the exact local undispatched suffix and current uncertainty", async () => {
		const driver = new ThinConsumer();
		driver.admit(command(0));
		driver.admit(command(1));
		await driver.run(() => {
			throw new Error("started dispatch cannot prove nonacceptance");
		});
		expect(driver.recovered).toEqual([command(1)]);
		expect(driver.uncertain).toEqual([command(0)]);
	});

	it("close during the first dispatch does not execute the undispatched suffix", async () => {
		const driver = new ThinConsumer();
		driver.admit(command(0));
		driver.admit(command(1));
		const observed: ClientMessage[] = [];
		await driver.run((sent) => {
			observed.push(sent);
			driver.close();
		});
		expect(observed).toEqual([command(0)]);
		expect(driver.recovered).toEqual([command(1)]);
		expect(driver.uncertain).toEqual([command(0)]);
	});
});
