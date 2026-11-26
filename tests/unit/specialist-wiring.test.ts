/**
 * department-specialists (Ops #1101): the wiring around the shared-case seams that the acceptance suite
 * (department-specialists.test.ts) doesn't reach: the Queue panel's replay of pi-queue's specialist fields, the
 * header's sticky specialist read from a loaded chat (pi's session and a durable chat's), and the owner's list row.
 */
import { describe, expect, it } from "vitest";
import { specialistRowOf } from "../../server/specialist-messages.js";
import { withSpecialist } from "../../server/specialist-entry.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries, type TaskQueueEntryLike } from "../../server/task-queue.js";

const PLAN = {
	title: "Hunt the flaky test",
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
};
const FROM = { model: "queue", thinking: "app", speed: "app" };
let clock = 1000;
const queue = (ops: Array<Record<string, unknown>>): TaskQueueEntryLike[] =>
	ops.map((op) => ({ type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, ts: clock++, ...op } }));
const taskOf = (ops: Array<Record<string, unknown>>) =>
	taskQueueFromEntries(queue(ops), true).tasks[0] as unknown as Record<string, unknown> & {
		launch?: Record<string, unknown>;
	};

describe("Queue replay: a task's specialist and its launch snapshot (§3.1, §4.3)", () => {
	const snapshot = { slug: "flaky-hunter", title: "Flaky  Hunter", limits: { tools: ["read"] }, sha256: "ab" };

	it("add sets the slug; the start's snapshot keeps only slug and title; prepared keeps it", () => {
		const t = taskOf([
			{ op: "add", id: 1, plan: PLAN, specialist: "flaky-hunter" },
			{ op: "start", id: 1, lane: true, launch: { model: "a/m", from: FROM, specialist: snapshot } },
			{ op: "prepared", id: 1, launch: { model: "a/m2", from: FROM } },
		]);
		expect(t.specialist).toBe("flaky-hunter");
		expect(t.launch?.specialist).toEqual({ slug: "flaky-hunter", title: "Flaky Hunter" });
		expect(t.launch?.model).toBe("a/m2");
	});

	it("update with a slug changes it, null clears it, a malformed value changes nothing", () => {
		const base = { op: "add", id: 1, plan: PLAN, specialist: "flaky-hunter" };
		expect(taskOf([base, { op: "update", id: 1, plan: PLAN, specialist: "ghost" }]).specialist).toBe("ghost");
		expect("specialist" in taskOf([base, { op: "update", id: 1, plan: PLAN, specialist: null }])).toBe(false);
		expect(taskOf([base, { op: "update", id: 1, plan: PLAN, specialist: "Bad Slug" }]).specialist).toBe("flaky-hunter");
	});

	it("a task without one has no specialist key anywhere (R-SPEC-NOSPEC-1); a bad snapshot is dropped", () => {
		const t = taskOf([
			{ op: "add", id: 1, plan: PLAN, specialist: "../etc" },
			{ op: "start", id: 1, lane: true, launch: { from: FROM, specialist: { slug: "Nope!", title: "x" } } },
		]);
		expect("specialist" in t).toBe(false);
		expect(t.launch && "specialist" in t.launch).toBe(false);
	});
});

type Entry = { id: string; parentId: string | null; type: string; customType?: string; data?: unknown };
const identity = (data: Record<string, unknown>) => ({ type: "custom", customType: "identity", data });
const assigned = { type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, op: "assigned", id: 3 } };
function chain(...raw: Array<Omit<Entry, "id" | "parentId">>): Entry[] {
	return raw.map((e, i) => ({ ...e, id: `e${i}`, parentId: i ? `e${i - 1}` : null }));
}
/** pi's session (looks entries up by id) or a durable chat's (branch list only). */
function convOf(entries: Entry[], kind: "pi" | "durable") {
	const sm = {
		getSessionId: () => "s1",
		getLeafId: () => entries.at(-1)?.id ?? null,
		getBranch: () => [...entries],
		...(kind === "pi" ? { getEntry: (id: string) => entries.find((e) => e.id === id) } : {}),
	};
	return { session: { sessionManager: sm } };
}
const QA = { id: "qa", title: "QA" };
const bound = { v: 1, id: "qa", via: "queue", from: "/q.jsonl", specialist: "flaky-hunter" };

describe("withSpecialist: the header's identity in a specialist's task chat (§4.1, §4.3)", () => {
	for (const kind of ["pi", "durable"] as const) {
		it(`${kind}: carries the slug, and the title from the task's assigned snapshot`, () => {
			const snap = {
				...assigned,
				data: { ...assigned.data, launch: { specialist: { slug: "flaky-hunter", title: "Flaky Hunter" } } },
			};
			const conv = convOf(chain(snap, identity(bound), { type: "message" }), kind);
			expect(withSpecialist(QA, conv)).toEqual({ ...QA, specialist: { slug: "flaky-hunter", title: "Flaky Hunter" } });
		});
	}

	it("sticks across later entries (a plain identity entry can't unbind it), reading only the new part", () => {
		const entries = chain(identity(bound), { type: "message" });
		const conv = convOf(entries, "pi");
		expect(withSpecialist(QA, conv)?.specialist?.slug).toBe("flaky-hunter");
		entries.push({ ...identity({ v: 1, id: "qa", via: "command" }), id: "e2", parentId: "e1" });
		expect(withSpecialist(QA, conv)?.specialist).toEqual({ slug: "flaky-hunter" });
	});

	it("no specialist for another department's identity, a plain chat, an unusable entry, or a broken session", () => {
		expect(withSpecialist({ id: "ops", title: "Ops" }, convOf(chain(identity(bound)), "pi"))).toEqual({
			id: "ops",
			title: "Ops",
		});
		expect(withSpecialist(QA, convOf(chain(identity({ v: 1, id: "qa", via: "queue" })), "pi"))).toEqual(QA);
		const bad = identity({ ...bound, via: "command" });
		expect(withSpecialist(QA, convOf(chain(bad), "durable"))).toEqual(QA);
		expect(withSpecialist(QA, { session: { sessionManager: {} } })).toEqual(QA);
		expect(withSpecialist(undefined, convOf([], "pi"))).toBeUndefined();
	});
});

describe("the owner's message list row (§4.2)", () => {
	it("gains fromSpecialist only for a stamped record", () => {
		expect(specialistRowOf({ specialist: "flaky-hunter" })).toEqual({ fromSpecialist: "flaky-hunter" });
		expect(specialistRowOf({})).toEqual({});
	});
});
