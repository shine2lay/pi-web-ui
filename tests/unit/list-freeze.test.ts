/**
 * list-freeze: rebuilding the running-chats list must not freeze the server.
 *
 * It used to ask pi for each chat's full stats (`getSessionStats()`, which also re-projects the whole
 * context: seconds on a 30k-message chat), in every window, and each window's rebuild set all the
 * others off again. The server froze for 10–20 s and every page's 5 s watchdog reconnected.
 * - messageCountOf: the same count, without the stats, remembered until the chat changes;
 * - pokeExternalRunning: each other window rebuilds once per turn of the event loop.
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { AgentService } from "../../server/agent-service.js";
import { messageCountOf } from "../../server/message-count.js";

/** A stand-in for pi's SessionManager: an append-only entry list with a leaf, counting getEntries() calls. */
function fakeManager() {
	const fileEntries: Array<{ type: string; id: string }> = [{ type: "session", id: "header" }];
	let leaf: string | null = null;
	let calls = 0;
	return {
		fileEntries,
		getLeafId: () => leaf,
		getEntries: () => {
			calls++;
			return fileEntries.filter((e) => e.type !== "session");
		},
		append(type: string): string {
			const id = `e${fileEntries.length}`;
			fileEntries.push({ type, id });
			leaf = id;
			return id;
		},
		moveTo(id: string | null): void {
			leaf = id;
		},
		get calls(): number {
			return calls;
		},
	};
}

/** A session whose full stats must never be asked for. */
const sessionOf = (sessionManager: ReturnType<typeof fakeManager> | SessionManager) => ({
	sessionManager,
	getSessionStats: (): { totalMessages: number } => {
		throw new Error("getSessionStats() must not be called");
	},
});

describe("messageCountOf", () => {
	it("counts the message entries on every branch, like getSessionStats().totalMessages", () => {
		const sm = fakeManager();
		const first = sm.append("message");
		sm.append("message");
		sm.append("custom");
		sm.append("model_change");
		sm.moveTo(first);
		sm.append("message"); // a second branch from the first message
		expect(messageCountOf(sessionOf(sm))).toBe(3);
	});

	it("remembers the count until the chat gets a new entry", () => {
		const sm = fakeManager();
		sm.append("message");
		const session = sessionOf(sm);
		expect(messageCountOf(session)).toBe(1);
		expect(messageCountOf(session)).toBe(1);
		expect(messageCountOf(session)).toBe(1);
		expect(sm.calls).toBe(1);
		sm.append("message");
		expect(messageCountOf(session)).toBe(2);
		expect(sm.calls).toBe(2);
	});

	it("recounts when the chat goes back to a counted leaf after new entries elsewhere", () => {
		const sm = fakeManager();
		const a = sm.append("message");
		const session = sessionOf(sm);
		expect(messageCountOf(session)).toBe(1);
		sm.append("message"); // not counted meanwhile
		sm.moveTo(a); // same leaf as the remembered count, but one entry more
		expect(messageCountOf(session)).toBe(2);
	});

	it("asks getSessionStats() when the session has no session manager (test fakes)", () => {
		expect(messageCountOf({ getSessionStats: () => ({ totalMessages: 7 }) })).toBe(7);
	});

	it("works on pi's own SessionManager and notices new entries", () => {
		const sm = SessionManager.inMemory("/tmp");
		// The cheap change key reads pi's own entry array; if pi renames it, the count still works
		// (the leaf alone keys it) but this flags the rename for the PATCHES.md syncing notes.
		expect(Array.isArray((sm as unknown as { fileEntries?: unknown }).fileEntries)).toBe(true);
		const session = sessionOf(sm);
		expect(messageCountOf(session)).toBe(0);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() });
		sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() } as never);
		sm.appendCustomEntry("tldr", { text: "not a message" });
		expect(messageCountOf(session)).toBe(2);
		sm.appendMessage({ role: "user", content: [{ type: "text", text: "again" }], timestamp: Date.now() });
		expect(messageCountOf(session)).toBe(3);
		expect(messageCountOf(session)).toBe(sm.getEntries().filter((e) => e.type === "message").length);
	});
});

const poke = AgentService.prototype.pokeExternalRunning as unknown as (this: unknown, excludeClientId: string) => void;
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The fields pokeExternalRunning uses, on a fake service with windows that record their refreshes. */
function fakeService(ids: string[], failing: string[] = []) {
	const refreshed: string[] = [];
	const clients = new Map(
		ids.map((id) => [
			id,
			{
				refreshExternalRunning: () => {
					refreshed.push(id);
					if (failing.includes(id)) throw new Error("broken window");
				},
			},
		]),
	);
	return { clients, pokedClients: new Set<string>(), pokeTimer: null, refreshed };
}

describe("pokeExternalRunning", () => {
	it("refreshes each other window once, however many pokes come in the same turn", async () => {
		const svc = fakeService(["a", "b", "c"]);
		// Each window's rebuild pokes all the others: before, this made 6 rebuilds straight away.
		poke.call(svc, "a");
		poke.call(svc, "b");
		poke.call(svc, "c");
		expect(svc.refreshed).toEqual([]);
		await nextTurn();
		expect([...svc.refreshed].sort()).toEqual(["a", "b", "c"]);
	});

	it("never refreshes the window that poked, when it's the only one poking", async () => {
		const svc = fakeService(["a", "b", "c"]);
		poke.call(svc, "a");
		await nextTurn();
		expect([...svc.refreshed].sort()).toEqual(["b", "c"]);
	});

	it("skips a window that closed before its turn, and a broken window doesn't stop the rest", async () => {
		const svc = fakeService(["a", "b", "c", "d"], ["b"]);
		poke.call(svc, "a");
		svc.clients.delete("c");
		await nextTurn();
		expect([...svc.refreshed].sort()).toEqual(["b", "d"]);
		// And a later poke works again.
		poke.call(svc, "d");
		await nextTurn();
		expect([...svc.refreshed].sort()).toEqual(["a", "b", "b", "d"]);
	});

	it("does nothing when there's no other window", async () => {
		const svc = fakeService(["a"]);
		poke.call(svc, "a");
		expect(svc.pokeTimer).toBeNull();
		await nextTurn();
		expect(svc.refreshed).toEqual([]);
	});
});
