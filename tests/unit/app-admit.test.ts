import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appAdmit, setAppAdmit, type AppAdmit } from "../../web/src/app-admit.js";
import type { ClientMessage } from "../../web/src/types.js";

// A successful transport must never make admission succeed. This catches a future
// appSend fallback without loading app-globals (React and the rest of the app).
const { appSendFallback } = vi.hoisted(() => ({ appSendFallback: vi.fn(() => true) }));
vi.mock("../../web/src/app-globals.js", () => ({ appSend: appSendFallback }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** Observe settlement using microtasks, never timers or an unresolved test timeout. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	await Promise.resolve();
	return settled;
}

const message: ClientMessage = { type: "get_state" };

beforeEach(() => {
	setAppAdmit(null);
	appSendFallback.mockClear();
});

afterEach(() => {
	setAppAdmit(null);
	expect(appSendFallback).not.toHaveBeenCalled();
});

describe("appAdmit registry", () => {
	it("returns a false Promise when unbound, without invoking the removed handler or transport", async () => {
		const removed = vi.fn(async () => true);
		setAppAdmit(removed);
		setAppAdmit(null);
		const result = appAdmit(message);
		expect(result).toBeInstanceOf(Promise);
		await expect(result).resolves.toBe(false);
		expect(removed).not.toHaveBeenCalled();
	});

	it("forwards the exact complete object once without cloning, trimming or mutation", async () => {
		const attachment = { path: "notes.txt", mode: "reference" as const, name: " notes " };
		const attachments = [attachment];
		const original: ClientMessage = {
			type: "prompt",
			text: "  preserve whitespace\n",
			id: "fixture-prompt",
			queue: true,
			attachments,
		};
		const before = structuredClone(original);
		Object.freeze(attachment);
		Object.freeze(attachments);
		Object.freeze(original);
		const handler = vi.fn(async (received: ClientMessage) => {
			expect(received).toBe(original);
			expect(received.type).toBe("prompt");
			if (received.type === "prompt") expect(received.attachments).toBe(attachments);
			return true;
		});
		setAppAdmit(handler);
		await expect(appAdmit(original)).resolves.toBe(true);
		expect(original).toEqual(before);
		expect(handler).toHaveBeenCalledExactlyOnceWith(original);
	});

	it("does not settle before the handler; calls it exactly once", async () => {
		const pending = deferred<boolean>();
		const handler = vi.fn((_msg: ClientMessage) => pending.promise);
		setAppAdmit(handler);
		const result = appAdmit(message);
		expect(await hasSettled(result)).toBe(false);
		expect(handler).toHaveBeenCalledExactlyOnceWith(message);
		pending.resolve(true);
		await expect(result).resolves.toBe(true);
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it.each([true, false, undefined, null, 0, 1, "", "true", {}, [], new Boolean(true)])(
		"accepts only literal true, not general truthiness (%j)",
		async (value) => {
			// Deliberately violate the static handler result type at the runtime boundary.
			const handler = vi.fn(async (_msg: ClientMessage) => value);
			setAppAdmit(handler as unknown as AppAdmit);
			await expect(appAdmit(message)).resolves.toBe(value === true);
			expect(handler).toHaveBeenCalledExactlyOnceWith(message);
		},
	);

	it.each([new Error("checkpoint failed"), { payloadCommitted: true }, "rejected", null, undefined])(
		"propagates the exact rejection without retry or fallback (%j)",
		async (reason) => {
			const handler = vi.fn((_msg: ClientMessage): Promise<boolean> => Promise.reject(reason));
			setAppAdmit(handler);
			await expect(appAdmit(message)).rejects.toBe(reason);
			expect(handler).toHaveBeenCalledExactlyOnceWith(message);
		},
	);

	it("turns a synchronous handler throw into rejection of the exact error", async () => {
		const reason = new Error("synchronous handler failure");
		const handler = vi.fn((_msg: ClientMessage): Promise<boolean> => {
			throw reason;
		});
		setAppAdmit(handler);
		let result!: Promise<boolean>;
		expect(() => {
			result = appAdmit(message);
		}).not.toThrow();
		await expect(result).rejects.toBe(reason);
		expect(handler).toHaveBeenCalledExactlyOnceWith(message);
	});

	it("does not cache success or deduplicate calls with the same object", async () => {
		const handler = vi.fn(async (_msg: ClientMessage) => true);
		setAppAdmit(handler);
		await expect(appAdmit(message)).resolves.toBe(true);
		await expect(appAdmit(message)).resolves.toBe(true);
		expect(handler.mock.calls).toEqual([[message], [message]]);
	});

	it.each([true, false])("replacement affects later calls, not the in-flight result (%s)", async (firstResult) => {
		const pending = deferred<boolean>();
		const first = vi.fn((_msg: ClientMessage) => pending.promise);
		const replacement = vi.fn(async (_msg: ClientMessage) => !firstResult);
		setAppAdmit(first);
		const inFlight = appAdmit(message);
		setAppAdmit(replacement);
		await expect(appAdmit(message)).resolves.toBe(!firstResult);
		expect(await hasSettled(inFlight)).toBe(false);
		pending.resolve(firstResult);
		await expect(inFlight).resolves.toBe(firstResult);
		expect(first).toHaveBeenCalledExactlyOnceWith(message);
		expect(replacement).toHaveBeenCalledExactlyOnceWith(message);
	});

	it.each([true, false])("null reset neither cancels nor certifies an in-flight call (%s)", async (value) => {
		const pending = deferred<boolean>();
		const handler = vi.fn((_msg: ClientMessage) => pending.promise);
		setAppAdmit(handler);
		const inFlight = appAdmit(message);
		setAppAdmit(null);
		await expect(appAdmit(message)).resolves.toBe(false);
		expect(await hasSettled(inFlight)).toBe(false);
		pending.resolve(value);
		await expect(inFlight).resolves.toBe(value);
		expect(handler).toHaveBeenCalledExactlyOnceWith(message);
	});

	it("preserves an in-flight rejection after replacement without invoking the replacement", async () => {
		const pending = deferred<boolean>();
		const reason = { payloadCommitted: true, outcome: "unconfirmed" };
		const first = vi.fn((_msg: ClientMessage) => pending.promise);
		const replacement = vi.fn(async () => true);
		setAppAdmit(first);
		const inFlight = appAdmit(message);
		const rejected = expect(inFlight).rejects.toBe(reason);
		setAppAdmit(replacement);
		pending.reject(reason);
		await rejected;
		expect(first).toHaveBeenCalledExactlyOnceWith(message);
		expect(replacement).not.toHaveBeenCalled();
	});
});

describe("controlled behavioral negatives (deliberately broken local adapters)", () => {
	it("the pending probe detects eager success rather than a missing module/import", async () => {
		const pending = deferred<boolean>();
		const handler = vi.fn((_msg: ClientMessage) => pending.promise);
		const eager: AppAdmit = async (msg) => {
			void handler(msg);
			return true;
		};
		const result = eager(message);
		expect(await hasSettled(result)).toBe(true); // Must be false in the real registry.
		pending.resolve(false);
		await expect(result).resolves.toBe(true); // Wrong even though admission was refused.
		expect(handler).toHaveBeenCalledExactlyOnceWith(message);
	});

	it("the literal-result probe distinguishes a truthy adapter from the real registry", async () => {
		const handler = vi.fn(async (_msg: ClientMessage): Promise<unknown> => "accepted");
		const truthy: AppAdmit = async (msg) => Boolean(await handler(msg));
		setAppAdmit(handler as unknown as AppAdmit);
		await expect(appAdmit(message)).resolves.toBe(false);
		await expect(truthy(message)).resolves.toBe(true); // Contract violation, not old behavior.
	});

	it("the unbound probe detects a successful appSend-style fallback", async () => {
		const transport = vi.fn((_msg: ClientMessage) => true);
		const fallback: AppAdmit = async (msg) => transport(msg);
		await expect(appAdmit(message)).resolves.toBe(false);
		expect(transport).not.toHaveBeenCalled();
		await expect(fallback(message)).resolves.toBe(true); // Unbound admission must be false.
		expect(transport).toHaveBeenCalledExactlyOnceWith(message);
	});
});
