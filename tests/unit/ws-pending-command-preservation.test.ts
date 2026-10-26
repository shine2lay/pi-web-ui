import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage } from "../../server/protocol.js";
import {
	MAX_PENDING_WS_MESSAGES,
	PENDING_DROP_WARN_INTERVAL_MS,
	PendingCommandQueue,
	PendingCommandRejectedError,
	RecoverablePendingCommandQueue,
	resetPendingDropWarn,
	type PendingCommandAbandonReason,
} from "../../server/ws-pending-queue.js";

type Prompt = Extract<ClientMessage, { type: "prompt" }>;
const command = (n: number): Prompt => ({
	type: "prompt",
	id: `synthetic-send-${n}`,
	forSession: "synthetic-session",
	text: `synthetic ${n}: 文字 👩🏽‍💻 e\u0301\r\n\t spaces  \n`,
	queue: n % 2 === 0,
	attachments: [
		{ path: `/synthetic/not-a-file/附件 ${n}.txt`, mode: "reference" },
		{ path: `/synthetic/not-a-file/lines-${n}.ts`, mode: "lines", lines: { start: 2, end: 17 } },
		{ path: "", mode: "conversation", conversationId: `synthetic-conversation-${n}` },
	],
});

function expectExact(
	actual: readonly ClientMessage[],
	original: readonly ClientMessage[],
	snapshot = structuredClone(original),
) {
	expect(actual).toEqual(snapshot);
	expect(actual).toHaveLength(original.length);
	original.forEach((item, i) => expect(actual[i]).toBe(item));
}

function refuse(queue: RecoverablePendingCommandQueue, value: ClientMessage): PendingCommandRejectedError {
	try {
		queue.push(value);
	} catch (error) {
		expect(error).toBeInstanceOf(PendingCommandRejectedError);
		if (!(error instanceof PendingCommandRejectedError)) throw error;
		expect(error.command).toBe(value);
		expect(error.status).toBe("unprocessed");
		expect(error.retryable).toBe(true);
		return error;
	}
	throw new Error("Expected an explicit recoverable refusal, not a silently ignored return value");
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
	resetPendingDropWarn();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("recoverable pre-initialization command admission", () => {
	it("keeps the existing 256 default bound and exposes no silent clear operation", () => {
		const queue = new RecoverablePendingCommandQueue();
		expect(queue.cap).toBe(MAX_PENDING_WS_MESSAGES);
		expect(queue.cap).toBe(256);
		expect("clear" in queue).toBe(false);
		expect(queue.rejected).toBe(0);
	});

	it.each([1, 2, MAX_PENDING_WS_MESSAGES].flatMap((cap) => [-1, 0, 1].map((delta) => ({ cap, count: cap + delta }))))(
		"retains exact accepted content/FIFO at capacity $cap with $count attempts",
		({ cap, count }) => {
			const queue = new RecoverablePendingCommandQueue(cap);
			const inputs = Array.from({ length: count }, (_, i) => command(i));
			const snapshot = structuredClone(inputs);
			const rejected: ClientMessage[] = [];
			for (const [i, input] of inputs.entries()) {
				if (i < cap) expect(queue.push(input)).toBeUndefined();
				else {
					const error = refuse(queue, input);
					expect(error.reason).toBe("capacity");
					rejected.push(error.command);
				}
				expect(queue.size).toBe(Math.min(i + 1, cap));
			}
			expectExact(rejected, inputs.slice(cap), snapshot.slice(cap));
			expect(queue.rejected).toBe(Math.max(0, count - cap));
			expectExact(queue.drain(), inputs.slice(0, cap), snapshot.slice(0, cap));
			expect(queue.size).toBe(0);
			expect(queue.drain()).toEqual([]);
		},
	);

	it("repeated overflow refuses only NEW commands without retaining an extra overflow buffer", () => {
		const queue = new RecoverablePendingCommandQueue(2);
		const accepted = [command(0), command(1)];
		const excess = Array.from({ length: 7 }, (_, i) => command(i + 2));
		const snapshot = structuredClone([...accepted, ...excess]);
		accepted.forEach((input) => queue.push(input));
		const rejected = excess.map((input) => {
			const error = refuse(queue, input);
			expect(error.reason).toBe("capacity");
			expect(queue.size).toBe(2);
			return error.command;
		});
		expectExact(rejected, excess, snapshot.slice(2));
		expect(queue.rejected).toBe(excess.length);
		expectExact(queue.drain(), accepted, snapshot.slice(0, 2));
		const next = command(100);
		queue.push(next);
		expectExact(queue.drain(), [next]);
	});

	it("preserves mixed/non-idempotent commands, duplicate IDs and frozen inputs without interpreting or replaying them", () => {
		const queue = new RecoverablePendingCommandQueue();
		const first = command(0);
		const edit: ClientMessage = {
			type: "edit_message",
			messageId: "synthetic-original",
			text: "edited\r\n exact  ",
			attachments: first.attachments,
		};
		const create: ClientMessage = { type: "new_chat", preset: "synthetic", ephemeral: false };
		const inputs: ClientMessage[] = [first, create, edit, { ...command(1), id: first.id }, first];
		const snapshot = structuredClone(inputs);
		inputs.forEach(Object.freeze);
		inputs.forEach((input) => queue.push(input));
		expectExact(queue.drain(), inputs, snapshot);
		expect(queue.drain()).toEqual([]);
	});

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_PENDING_WS_MESSAGES + 1])(
		"rejects invalid/bound-bypassing capacity %s before use",
		(cap) => {
			expect(() => new RecoverablePendingCommandQueue(cap)).toThrow(RangeError);
		},
	);

	it("fails loudly for a consumer that ignores push's return value", () => {
		const queue = new RecoverablePendingCommandQueue(1);
		const accepted = command(0);
		const excess = command(1);
		queue.push(accepted);
		expect(() => {
			queue.push(excess); // No result check: a boolean-return API would lose this command silently.
		}).toThrow(PendingCommandRejectedError);
		expectExact(queue.drain(), [accepted]);
	});

	it("a broken warning logger cannot hide the recoverable refusal", () => {
		vi.mocked(console.warn).mockImplementation(() => {
			throw new Error("synthetic logger failure");
		});
		const queue = new RecoverablePendingCommandQueue(1);
		const accepted = command(0);
		queue.push(accepted);
		expect(refuse(queue, command(1)).reason).toBe("capacity");
		expectExact(queue.drain(), [accepted]);
	});
});

describe("explicit unprocessed disposition at failure/close", () => {
	it.each<PendingCommandAbandonReason>(["attach-failed", "socket-closed"])(
		"exposes every unprocessed command exactly once on %s, without processing evidence",
		(reason) => {
			const queue = new RecoverablePendingCommandQueue();
			const inputs = [command(0), command(1), command(2)];
			const snapshot = structuredClone(inputs);
			inputs.forEach((input) => queue.push(input));
			const disposition = queue.abandon(reason);
			expect(disposition).toEqual({ status: "unprocessed", reason, commands: snapshot });
			expectExact(disposition.commands, inputs, snapshot);
			expect(Object.isFrozen(disposition)).toBe(true);
			expect(Object.isFrozen(disposition.commands)).toBe(true);
			expect(queue.size).toBe(0);
			expect(queue.drain()).toEqual([]);
			expect(queue.abandon(reason)).toEqual({ status: "unprocessed", reason, commands: [] });
			// Even an old-style caller cannot accidentally admit/replay work after cleanup.
			expect(refuse(queue, command(3)).reason).toBe(reason);
			expect(queue.size).toBe(0);
		},
	);

	it("keeps the first abandonment reason through repeated/stale cleanup and rejects new work explicitly", () => {
		const queue = new RecoverablePendingCommandQueue(2);
		const inputs = [command(0), command(1)];
		inputs.forEach((input) => queue.push(input));
		expectExact(queue.abandon("socket-closed").commands, inputs);
		for (const reason of ["attach-failed", "socket-closed", "attach-failed"] as const) {
			expect(queue.abandon(reason)).toEqual({ status: "unprocessed", reason: "socket-closed", commands: [] });
			expect(refuse(queue, command(99)).reason).toBe("socket-closed");
		}
		expect(queue.rejected).toBe(3);
		expect(queue.drain()).toEqual([]);
	});

	it("empty abandonment is still terminal (close before any command/attach)", () => {
		const queue = new RecoverablePendingCommandQueue();
		expect(queue.abandon("socket-closed")).toEqual({ status: "unprocessed", reason: "socket-closed", commands: [] });
		expect(refuse(queue, command(0)).reason).toBe("socket-closed");
	});

	it.each(["drain-first", "abandon-first"])("transfers FIFO ownership once in a %s race", async (order) => {
		const queue = new RecoverablePendingCommandQueue();
		const inputs = [command(0), command(1)];
		const snapshot = structuredClone(inputs);
		inputs.forEach((input) => queue.push(input));
		const drained: ClientMessage[] = [];
		const abandoned: ClientMessage[] = [];
		const drain = () => drained.push(...queue.drain());
		const abandon = () => abandoned.push(...queue.abandon("socket-closed").commands);
		await Promise.all(
			(order === "drain-first" ? [drain, abandon] : [abandon, drain]).map((op) => Promise.resolve().then(op)),
		);
		expectExact([...drained, ...abandoned], inputs, snapshot);
		expectExact(order === "drain-first" ? drained : abandoned, inputs, snapshot);
		expect(order === "drain-first" ? abandoned : drained).toEqual([]);
		expect(queue.drain()).toEqual([]);
		expect(queue.abandon("attach-failed").commands).toEqual([]);
	});

	it("a drained batch remains caller-owned, including the undispatched suffix when close wins later", () => {
		const queue = new RecoverablePendingCommandQueue();
		const inputs = [command(0), command(1), command(2)];
		const snapshot = structuredClone(inputs);
		inputs.forEach((input) => queue.push(input));
		const batch = queue.drain();
		const handedToHandler = batch.slice(0, 1);
		const stillUnprocessed = batch.slice(1);
		expect(queue.abandon("socket-closed").commands).toEqual([]);
		expectExact(batch, inputs, snapshot);
		expectExact([...handedToHandler, ...stillUnprocessed], inputs, snapshot);
		// Queue handoff isn't an operation receipt. The host must recover this suffix itself.
		expectExact(stillUnprocessed, inputs.slice(1), snapshot.slice(1));
	});

	it("cleanup from an old socket cannot alter a fresh reconnect queue or auto-replay old work", () => {
		const old = new RecoverablePendingCommandQueue();
		const input = command(0);
		old.push(input);
		const abandoned = old.abandon("attach-failed");
		const fresh = new RecoverablePendingCommandQueue();
		const newInput = command(1);
		fresh.push(newInput);
		expect(old.abandon("socket-closed").commands).toEqual([]);
		expect(old.drain()).toEqual([]); // A stale attach completion has nothing to dispatch.
		expectExact(fresh.drain(), [newInput]);
		expectExact(abandoned.commands, [input]); // Caller still owns recovery; no implicit replay.
	});

	it("invalid cleanup cannot silently discard or terminally fence accepted work", () => {
		const queue = new RecoverablePendingCommandQueue();
		const input = command(0);
		queue.push(input);
		expect(() => queue.abandon("processed" as PendingCommandAbandonReason)).toThrow(TypeError);
		expect(queue.size).toBe(1);
		expectExact(queue.abandon("attach-failed").commands, [input]);
	});
});

describe("bounded non-content diagnostics", () => {
	it("retains the process-wide 60-second overflow warning throttle across safe and legacy queues", () => {
		const first = new RecoverablePendingCommandQueue(1);
		const second = new RecoverablePendingCommandQueue(1);
		[first, second].forEach((queue) => queue.push(command(0)));
		refuse(first, command(1));
		refuse(second, command(2));
		const legacy = new PendingCommandQueue(1);
		legacy.push(command(0));
		legacy.push(command(1));
		expect(PENDING_DROP_WARN_INTERVAL_MS).toBe(60_000);
		expect(console.warn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(PENDING_DROP_WARN_INTERVAL_MS - 1);
		refuse(first, command(3));
		expect(console.warn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		refuse(second, command(4));
		expect(console.warn).toHaveBeenCalledTimes(2);
		expect(vi.mocked(console.warn).mock.calls).toEqual([
			["[ws] attach not finished, the command queue is at capacity and refused a new command (1 in total)"],
			["[ws] attach not finished, the command queue is at capacity and refused a new command (2 in total)"],
		]);
	});

	it("legacy-first warnings also throttle safe warnings; rejection errors don't serialize payload", () => {
		const legacy = new PendingCommandQueue(1);
		legacy.push(command(0));
		legacy.push(command(1));
		const queue = new RecoverablePendingCommandQueue(1);
		queue.push(command(0));
		const error = refuse(queue, command(1));
		expect(console.warn).toHaveBeenCalledTimes(1);
		expect(Object.keys(error)).not.toContain("command");
		expect(JSON.stringify(error)).not.toMatch(/synthetic|not-a-file|文字|attachments|text/);
		expect(error.message).toBe("Pending command not processed: capacity");
		expect(error.stack).not.toMatch(/synthetic-send|not-a-file|文字/);
	});
});
