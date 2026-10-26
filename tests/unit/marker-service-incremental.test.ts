import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ClientStateStore, MarkerSettings } from "../../server/client-state.js";
import {
	MarkerBranchCursors,
	MarkerService,
	type MarkerHost,
	type MarkerSessionManager,
} from "../../server/marker-service.js";
import { initTodoState, type TodoState } from "../../server/markers/builtins/todo.js";
import { loadStateFromBranch, STORE_CUSTOM_TYPE } from "../../server/markers/store.js";

/**
 * marker-incremental-cursor (Ops #565, W1-B): MarkerService reads a chat's marker state (the todo
 * list and the other markers' stores) from the latest store snapshot on the chat's branch. It used
 * to walk the whole branch on every read (70k entries in the longest chats, several reads a turn);
 * now a cursor per session manager folds only the entries added since the last read, and must give
 * exactly what the full scan gives (loadStateFromBranch over getBranch()) after any branch move.
 */

const SETTINGS: MarkerSettings = { markersEnabled: true, disabledMarkers: [] };

function makeService(getManager: () => MarkerSessionManager | undefined): MarkerService {
	const host = {
		clientId: "test-client",
		stateStore: {
			getMarkerSettings: () => SETTINGS,
			saveMarkerSettings: () => {},
		} as unknown as ClientStateStore,
		emit: () => {},
		isDisposed: () => false,
		getActiveConversationId: () => "c1",
		getSessionManager: () => getManager(),
		renameConversation: () => {},
		refreshMarkers: () => {},
	} satisfies MarkerHost;
	return new MarkerService(host);
}

let clock = 1;
function addMessage(sm: SessionManager, text: string, role: "user" | "assistant" = "user"): string {
	if (role === "user") return sm.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
	return sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: clock++,
		stopReason: "stop",
	} as never);
}

function addSnapshot(sm: SessionManager, namespace: string, state: unknown, ts: number = clock++): string {
	return sm.appendCustomEntry(STORE_CUSTOM_TYPE, { namespace, version: 1, state, ts });
}

function todoState(n: number): TodoState {
	const tasks = Array.from({ length: (n % 9) + 1 }, (_, k) => ({
		id: k + 1,
		subject: `task ${n}.${k}`,
		status: "pending" as const,
		blockedBy: [],
		createdAt: n,
	}));
	return { tasks, nextId: tasks.length + 1 };
}

/** The old read, for comparison: walk the whole branch. */
function fullScan(sm: MarkerSessionManager, namespace: string): unknown {
	return loadStateFromBranch(sm.getBranch(), namespace);
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? 0;
}

function percentile(xs: number[], p: number): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
}

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("marker state on a 70k-entry branch", () => {
	it("reads incrementally in under 5 ms a turn, byte-for-byte what a full scan reads", async () => {
		const sm = SessionManager.inMemory("/tmp");
		for (let i = 0; i < 70_000; i++) {
			if (i % 500 === 250) addSnapshot(sm, "todo", todoState(i));
			else addMessage(sm, `message ${i}`, i % 2 ? "assistant" : "user");
		}
		expect(sm.getBranch().length).toBe(70_000);

		const svc = makeService(() => sm);
		expect(JSON.stringify(svc.getRawState("c1", "todo"))).toBe(JSON.stringify(fullScan(sm, "todo")));
		expect(svc.branchCursors.fullFolds).toBe(1);

		const reads: number[] = [];
		for (let turn = 0; turn < 200; turn++) {
			addMessage(sm, `question ${turn}`);
			addMessage(sm, `answer ${turn} [[todo:new:turn task ${turn}]]`, "assistant");
			// The service reads the todo state, adds the task and appends a new store snapshot.
			await svc.handleAssistantText("c1", `answer ${turn} [[todo:new:turn task ${turn}]]`);
			const t0 = performance.now();
			const state = svc.getRawState("c1", "todo");
			reads.push(performance.now() - t0);
			if (turn % 20 === 19) expect(JSON.stringify(state)).toBe(JSON.stringify(fullScan(sm, "todo")));
		}

		// No turn walked the branch from the root again.
		expect(svc.branchCursors.fullFolds).toBe(1);
		expect(median(reads)).toBeLessThan(5);
		expect(percentile(reads, 0.9)).toBeLessThan(5);
		const final = svc.getRawState("c1", "todo") as TodoState;
		expect(final.tasks.filter((t) => t.subject.startsWith("turn task"))).toHaveLength(200);
		expect(JSON.stringify(final)).toBe(JSON.stringify(fullScan(sm, "todo")));
		expect(sm.getBranch().length).toBe(70_000 + 200 * 3);
	});
});

describe("marker branch cursor matches a full scan", () => {
	it("after appends, branch moves, summaries, resets and new sessions (randomized, seeded)", () => {
		const rand = mulberry32(565);
		const namespaces = ["todo", "bits", "other"];
		const sm = SessionManager.inMemory("/tmp");
		const cursors = new MarkerBranchCursors();
		let ids: string[] = [];
		const pick = (): string => ids[Math.floor(rand() * ids.length)] as string;
		let rewinds = 0;
		let appendsChecked = 0;

		for (let step = 0; step < 2000; step++) {
			const r = rand();
			const before = cursors.fullFolds;
			let appendOnly = true;
			if (r < 0.4) {
				ids.push(addMessage(sm, `m${step}`));
			} else if (r < 0.75) {
				const ns = namespaces[Math.floor(rand() * namespaces.length)] ?? "todo";
				// Small ts range: ties and out-of-order stamps happen (the later entry wins a tie).
				ids.push(addSnapshot(sm, ns, { step, ns }, Math.floor(rand() * 40)));
			} else if (r < 0.78) {
				ids.push(addSnapshot(sm, "todo", undefined)); // a snapshot without state: skipped
			} else if (r < 0.8) {
				ids.push(sm.appendCustomEntry("something-else", { namespace: "todo", state: { wrong: true }, ts: 99 }));
			} else if (r < 0.81) {
				ids.push(sm.appendCustomEntry(STORE_CUSTOM_TYPE, null));
			} else if (r < 0.9 && ids.length > 0) {
				appendOnly = false;
				rewinds++;
				sm.branch(pick());
			} else if (r < 0.95 && ids.length > 0) {
				appendOnly = false;
				rewinds++;
				ids.push(sm.branchWithSummary(pick(), `summary ${step}`));
			} else if (r < 0.985) {
				appendOnly = false;
				rewinds++;
				sm.resetLeaf();
			} else {
				appendOnly = false;
				rewinds++;
				sm.newSession();
				ids = [];
			}

			for (const ns of namespaces) {
				expect(cursors.snapshot(sm, ns)?.state).toBe(fullScan(sm, ns));
			}
			if (appendOnly && step > 0) {
				expect(cursors.fullFolds).toBe(before);
				appendsChecked++;
			}
		}
		expect(appendsChecked).toBeGreaterThan(1000);
		expect(cursors.fullFolds).toBeGreaterThan(10); // the fallback was really exercised
		expect(cursors.fullFolds).toBeLessThanOrEqual(1 + rewinds);
	});

	it("folds from the root again when the same ids come back as new objects (a reload)", () => {
		const fake = new FakeManager();
		fake.append({ type: "message" });
		fake.append(storeEntry("todo", { v: 1 }, 1));
		fake.append({ type: "message" });
		const cursors = new MarkerBranchCursors();
		expect(cursors.snapshot(fake, "todo")?.state).toEqual({ v: 1 });
		expect(cursors.fullFolds).toBe(1);

		fake.reload();
		const afterReload = cursors.snapshot(fake, "todo")?.state;
		expect(afterReload).toBe(fullScan(fake, "todo"));
		expect(cursors.fullFolds).toBe(2);

		fake.append(storeEntry("todo", { v: 2 }, 2));
		expect(cursors.snapshot(fake, "todo")?.state).toEqual({ v: 2 });
		expect(cursors.fullFolds).toBe(2);

		// Another session behind the same manager object: from the root.
		fake.sessionId = "other";
		expect(cursors.snapshot(fake, "todo")?.state).toBe(fullScan(fake, "todo"));
		expect(cursors.fullFolds).toBe(3);
	});

	it("folds only the new tail when the manager has nothing but getBranch()", () => {
		let branch: unknown[] = [{ type: "message", id: "a" }, storeEntry("todo", { v: 1 }, 1, "b")];
		const mgr: MarkerSessionManager = { getBranch: () => branch.slice() };
		const cursors = new MarkerBranchCursors();
		expect(cursors.snapshot(mgr, "todo")?.state).toEqual({ v: 1 });

		branch = [...branch, { type: "message", id: "c" }, storeEntry("todo", { v: 2 }, 2, "d")];
		expect(cursors.snapshot(mgr, "todo")?.state).toEqual({ v: 2 });
		branch = [...branch, storeEntry("todo", { v: 3 }, 1, "e")]; // older stamp: doesn't win
		expect(cursors.snapshot(mgr, "todo")?.state).toEqual({ v: 2 });
		expect(cursors.fullFolds).toBe(1);

		branch = branch.slice(0, 2); // rewound
		expect(cursors.snapshot(mgr, "todo")?.state).toEqual({ v: 1 });
		expect(cursors.fullFolds).toBe(2);
	});

	it("keeps the service's old fallback when the branch can't be read", () => {
		let branch: unknown[] = [storeEntry("todo", { tasks: [], nextId: 7 }, 1, "a")];
		const mgr: MarkerSessionManager = { getBranch: () => branch.slice() };
		const svc = makeService(() => mgr);
		expect(svc.getRawState("c1", "todo")).toEqual({ tasks: [], nextId: 7 });

		branch = [...branch, null]; // a broken entry: the full scan threw here too
		expect(() => fullScan(mgr, "todo")).toThrow();
		expect(svc.getRawState("c1", "todo")).toEqual({ tasks: [], nextId: 7 }); // last good state

		branch = [storeEntry("todo", { tasks: [], nextId: 9 }, 2, "z")];
		expect(svc.getRawState("c1", "todo")).toEqual({ tasks: [], nextId: 9 });
	});

	it("gives each read its own copy", () => {
		const sm = SessionManager.inMemory("/tmp");
		addSnapshot(sm, "todo", todoState(3));
		const svc = makeService(() => sm);
		const a = svc.getRawState("c1", "todo") as TodoState;
		a.tasks.length = 0;
		expect((svc.getRawState("c1", "todo") as TodoState).tasks.length).toBeGreaterThan(0);
		expect(svc.getRawState("c1", "nothing-stored")).toEqual({});
		expect(makeService(() => undefined).getRawState("c1", "todo")).toEqual(initTodoState());
	});
});

interface FakeEntry {
	id?: string;
	parentId?: string | null;
	type: string;
	customType?: string;
	data?: unknown;
}

function storeEntry(namespace: string, state: unknown, ts: number, id?: string): FakeEntry {
	return {
		...(id ? { id } : {}),
		type: "custom",
		customType: STORE_CUSTOM_TYPE,
		data: { namespace, version: 1, state, ts },
	};
}

/** A session manager with the tree reads the cursor uses, whose entries can be swapped for copies. */
class FakeManager implements MarkerSessionManager {
	private byId = new Map<string, FakeEntry>();
	private leaf: string | null = null;
	private next = 1;
	sessionId = "s1";

	append(entry: FakeEntry): void {
		const id = `e${this.next++}`;
		const full = { ...entry, id, parentId: this.leaf };
		this.byId.set(id, full);
		this.leaf = id;
	}

	reload(): void {
		this.byId = new Map([...this.byId].map(([id, e]) => [id, structuredClone(e)]));
	}

	getBranch(): unknown[] {
		const out: FakeEntry[] = [];
		let id = this.leaf;
		while (id) {
			const e = this.byId.get(id);
			if (!e) break;
			out.push(e);
			id = e.parentId ?? null;
		}
		return out.reverse();
	}

	getLeafId(): string | null {
		return this.leaf;
	}

	getEntry(id: string): unknown {
		return this.byId.get(id);
	}

	getEntryCount(): number {
		return this.byId.size;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getSessionFile(): string | undefined {
		return "/tmp/fake.jsonl";
	}
}
