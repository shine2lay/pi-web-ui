/** Ops #732: fabricated native records, real canonical resolver, stuck selection, router, hold store and COO desk.
 * Assertions are occurrence/count/clock metadata only; no models, real chats or captured model requests. */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskHub, stuckAsk } from "../../server/asks.js";
import { CooOwnerQuestionDesk } from "../../server/owner-question-coo.js";
import { HOLD_SAFETY_NET_MS, OwnerQuestionHolds, holdKeyOfStuck } from "../../server/owner-question-holds.js";
import { OwnerQuestionRouter } from "../../server/owner-question-router.js";
import * as readers from "../../server/pi-queue-readers.js";
import * as durability from "../../server/queue-question-durability.js";
import { nativeOwnerQuestionBinding, nativeOwnerQuestionOccurrence } from "../../server/queue-question-native.js";
import * as port from "../../server/queue-question-port.js";
import {
	stuckAskId,
	stuckSig,
	stuckSigForOccurrence,
	wantedStuckAsks,
	type StuckSource,
	type StuckWanted,
} from "../../server/stuck-asks.js";
import { taskQueueFromEntries } from "../../server/task-queue.js";

const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
const { ownerQuestionFixture } = await import(
	/* @vite-ignore */ pathToFileURL(join(pkg, "tests/owner-question-fixture.ts")).href
);
const { resolveOwnerQuestion } = await import(
	/* @vite-ignore */ pathToFileURL(join(pkg, "owner-question-occurrence.ts")).href
);
let dir: string, now: number;
const T0 = Date.UTC(2026, 10, 1, 9);
const cleanups: (() => void)[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oq-continuity-"));
	now = T0;
	vi.useFakeTimers();
});
afterEach(() => {
	for (const fn of cleanups.splice(0).reverse()) fn();
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

function sources() {
	const f = ownerQuestionFixture(dir);
	let missing = false;
	const nativeRead = vi.fn((_entries, _sessionId, file, id) =>
		resolveOwnerQuestion(file === f.workerFile ? f.worker : f.home, file, id, missing ? () => undefined : f.read),
	);
	vi.spyOn(readers, "piQueueOccurrenceReader").mockReturnValue(nativeRead);
	const session = (home: boolean) =>
		({
			sessionManager: {
				getSessionFile: () => (home ? f.queueFile : f.workerFile),
				getSessionId: () => (home ? f.home.queueId : f.worker.queueId),
				getBranch: () => (home ? f.homeEntries : f.workerEntries),
			},
		}) as unknown as AgentSession;
	const source = (home: boolean): StuckSource => {
		const s = session(home);
		return {
			file: s.sessionManager.getSessionFile()!,
			queue: taskQueueFromEntries(
				s.sessionManager.getBranch(),
				true,
				undefined,
				undefined,
				s.sessionManager.getSessionId(),
			),
			meta: {},
			questionOccurrence: (id) => nativeOwnerQuestionOccurrence(s, id),
		};
	};
	return {
		...f,
		session,
		source,
		nativeRead,
		unavailable: (value: boolean) => {
			missing = value;
		},
	};
}
function runtime(file = join(dir, "holds.json")) {
	const hub = new AskHub(() => now),
		holds = new OwnerQuestionHolds(file, { now: () => now });
	const router = new OwnerQuestionRouter({ enabled: () => true, hub, holds: () => holds, now: () => now });
	let deliveries = 0,
		current: { id: string; sig: string } | undefined;
	const desk = new CooOwnerQuestionDesk({
		routingOn: () => true,
		hear: (fn) => hub.observe(fn),
		heldAsks: () => hub.heldList(),
		holdKeyOf: (id) => router.holdKeyOf(id),
		holds: () => router.holds(),
		heldUntil: (id) => router.heldUntil(id),
		release: (id, by, note, rec) => router.release(id, by, note, rec),
		returnToAsker: (id, note) => router.returnToAsker(id, note),
		askerOf: () => ({ chat: "task", role: { id: "ops", title: "Ops" } }),
		now: () => now,
		log: () => {},
		deliver: async (compose) => {
			if (compose() !== undefined) deliveries++;
			return { ok: true };
		},
	});
	desk.start();
	const close = () => {
		desk.stop();
		router.dispose();
	};
	cleanups.push(close);
	const add = (wanted?: StuckWanted) => {
		const sig = wanted && stuckSig(wanted);
		if (current && current.sig === sig && wanted) return current.id;
		if (current) hub.settle(current.id, { how: "gone", reason: "synthetic source transition" });
		current = undefined;
		if (!wanted) return undefined;
		const id = stuckAskId(wanted, 1);
		const ask = stuckAsk(
			id,
			{ taskId: wanted.taskId, taskTitle: wanted.taskTitle, question: wanted.question, choices: wanted.choices },
			wanted.meta,
			now,
		);
		const route = router.routeAsk(ask, {}, { key: wanted.key, sig: sig! });
		hub.add(ask, () => ({ ok: true }), route);
		current = { id, sig: sig! };
		return id;
	};
	return { hub, holds, router, desk, add, close, deliveries: () => deliveries };
}
const one = (sources: StuckSource[]) => [...wantedStuckAsks(sources).wanted.values()][0];

describe("verified owner-question identity continuity", () => {
	it.each(["held", "released"])(
		"%s: worker→home→worker, missing→restored, simultaneous refresh and restart keep one admission/delivery/clock",
		async (state) => {
			const f = sources(),
				r = runtime(),
				original = one([f.source(false)])!;
			const key = holdKeyOfStuck(original.key, stuckSig(original)),
				id = r.add(original)!;
			await r.desk.flush();
			expect(r.deliveries()).toBe(1);
			if (state === "released") expect(r.router.release(id, "coo").ok).toBe(true);
			const first = structuredClone(r.holds.get(key));
			for (const list of [
				[f.source(true)],
				[f.source(false)],
				[f.source(true), f.source(false)],
				[f.source(false), f.source(true)],
			]) {
				now += 1_000;
				const next = one(list)!;
				expect(stuckSig(next)).toBe(stuckSig(original));
				expect(
					stuckSigForOccurrence(
						next.task!,
						nativeOwnerQuestionOccurrence(f.session(list.length === 1 && list[0].file === f.queueFile), 7),
					),
				).toBe(stuckSig(original));
				r.add(next);
				await r.desk.flush();
			}
			f.unavailable(true);
			expect(one([f.source(true)])).toBeUndefined();
			r.add(undefined);
			now += 60_000;
			r.router.sweep();
			f.unavailable(false);
			r.add(one([f.source(true)]));
			await r.desk.flush();
			expect(r.deliveries()).toBe(1);
			expect(r.holds.get(key)).toEqual(first);
			r.add(undefined);
			r.close();
			const reopened = runtime();
			reopened.add(one([f.source(true)]));
			await reopened.desk.flush();
			expect(reopened.deliveries()).toBe(0);
			expect(reopened.holds.get(key)).toEqual(first);
			if (state === "held") expect(reopened.router.heldUntil(id)).toBe(T0 + HOLD_SAFETY_NET_MS);
			else expect(reopened.hub.get(id)?.route).toMatchObject({ to: "coo", releasedBy: "coo" });
		},
	);

	it.each(["write support", "endpoint", "empty ownerBinding"])(
		"%s loss: old binding disappears but read-only routing remains canonical",
		(loss) => {
			const f = sources(),
				expected = nativeOwnerQuestionOccurrence(f.session(false), 7);
			expect(expected.status).toBe("bound");
			vi.spyOn(durability, "supportsNativeQuestionWrite").mockReturnValue(loss !== "write support");
			const general = vi.fn(() => (expected.status === "bound" ? expected.binding : undefined));
			vi.spyOn(port, "questionEndpoint").mockReturnValue(
				loss === "endpoint"
					? undefined
					: ({ binding: general, ownerBinding: () => undefined } as unknown as port.QuestionCommitEndpoint),
			);
			expect(nativeOwnerQuestionBinding(f.session(false), 7)).toBeUndefined();
			expect(nativeOwnerQuestionOccurrence(f.session(false), 7)).toEqual(expected);
			expect(general).not.toHaveBeenCalled();
		},
	);

	it("old-code negative: losing only binding manufactures another hold/delivery; new resolution does not", async () => {
		const f = sources(),
			expected = nativeOwnerQuestionOccurrence(f.session(false), 7),
			r = runtime();
		vi.spyOn(durability, "supportsNativeQuestionWrite").mockReturnValue(true);
		vi.spyOn(port, "questionEndpoint").mockImplementation((sessionId): port.QuestionCommitEndpoint => ({
			version: 1,
			sessionId,
			file: sessionId === f.worker.queueId ? f.workerFile : f.queueFile,
			binding: () => undefined,
			commit: () => ({ status: "refused", reason: "read-only fixture" }),
			ownerBinding: () =>
				sessionId === f.worker.queueId && expected.status === "bound" ? expected.binding : undefined,
		}));
		// Exercise the unchanged pre-repair native binding + source-selection path, not a copied old algorithm.
		const oldSource = (home: boolean): StuckSource => ({
			...f.source(home),
			questionOccurrence: undefined,
			questionBinding: (id) => nativeOwnerQuestionBinding(f.session(home), id),
		});
		const bound = one([oldSource(false)])!,
			unbound = one([oldSource(true)])!;
		expect(bound.binding).toBeDefined();
		expect(unbound.binding).toBeUndefined();
		r.add(bound);
		await r.desk.flush();
		const oldKey = holdKeyOfStuck(bound.key, stuckSig(bound));
		now += 1_000;
		r.add(unbound);
		await r.desk.flush();
		expect(r.deliveries()).toBe(2);
		expect(holdKeyOfStuck(unbound.key, stuckSig(unbound))).not.toBe(oldKey);
		expect(r.holds.get(oldKey)?.createdAt).toBe(T0);
		// Preserve this historical duplicate, then recover the verified key: not a third admission.
		const oldUnbound = structuredClone(r.holds.get(holdKeyOfStuck(unbound.key, stuckSig(unbound))));
		r.add(one([f.source(true)]));
		await r.desk.flush();
		expect(r.deliveries()).toBe(2);
		expect(r.holds.get(oldKey)?.createdAt).toBe(T0);
		expect(r.holds.get(holdKeyOfStuck(unbound.key, stuckSig(unbound)))).toEqual(oldUnbound);
	});

	it("safety net expires the original absent-source hold; restoration stays released", async () => {
		const f = sources(),
			r = runtime(),
			w = one([f.source(false)])!,
			id = r.add(w)!;
		await r.desk.flush();
		r.add(undefined);
		now = T0 + HOLD_SAFETY_NET_MS;
		r.router.sweep();
		r.add(one([f.source(true)]));
		await r.desk.flush();
		expect(r.hub.get(id)?.route).toMatchObject({ releasedBy: "safety-net" });
		expect(r.deliveries()).toBe(1);
	});

	it("package or native occurrence replacements remain distinct, including after answer", () => {
		const f = sources(),
			original = one([f.source(false)])!,
			key = holdKeyOfStuck(original.key, stuckSig(original));
		for (const field of ["n", "at", "revision", "escalation"] as const) {
			const binding = { ...original.binding! };
			if (field === "escalation") binding.escalation = "r000000000002";
			else binding[field]++;
			expect(holdKeyOfStuck(original.key, stuckSig({ ...original, binding }))).not.toBe(key);
		}
		for (const changed of [{ question: "Changed" }, { choices: ["C", "D"] }, { detail: "Changed" }])
			expect(holdKeyOfStuck(original.key, stuckSig({ ...original, ...changed }))).not.toBe(key);
		const r = runtime();
		const id = r.add(original)!;
		r.router.release(id, "coo");
		r.hub.settle(id, { how: "answered", from: "browser", summary: "A" });
		const before = structuredClone(r.holds.get(key));
		f.worker.tasks[0].ask.ownerAdmission = { rid: "r000000000003", answer: "A", from: "browser", ts: now };
		expect(stuckSig(one([f.source(true)])!)).toBe(stuckSig(original));
		expect(r.holds.get(key)).toEqual(before);
		f.worker.tasks[0].status = "working";
		expect(one([f.source(true)])).toBeUndefined();
		expect(r.holds.get(key)).toEqual(before);
	});
});
