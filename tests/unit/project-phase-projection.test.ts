import { afterEach, expect, it, vi } from "vitest";
import { deliveryFromState, taskPhaseResolver } from "../../server/project-phase-projection.js";
import { workRecordsFrom, workRecordsFromState } from "../../server/work-records.js";
import { taskOf } from "../../server/roles-task-next.js";
import { buildTaskBoard } from "../../server/roles-by-project.js";
const key = Symbol.for("pi-queue.readers.v3");
const globals = globalThis as Record<symbol, unknown>;
const original = globals[key];
afterEach(() => {
	if (original === undefined) delete globals[key];
	else globals[key] = original;
});
const project = {
	id: "p",
	kind: "project",
	name: "P",
	outcome: "Useful slice",
	lead: "ops",
	status: "active",
	initiative: null,
	doneWhen: ["Legacy"],
	met: [],
};
it("fallback explicitly reports unsupported phases without fabricating zero delivery", () => {
	const log =
		[
			{ v: 1, op: "project.create", ...project },
			{ v: 1, op: "project.phase", id: "p", phase: { action: "reorder", ids: [] } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n";
	expect(workRecordsFrom(log)).toMatchObject({
		problem: "unknown-change",
		projects: [{ outcome: "Useful slice", delivery: { state: "unavailable" } }],
	});
});
it("legacy projects remain absent; known phases without v3 are unavailable", () => {
	delete globals[key];
	expect(deliveryFromState({}, "p", false)).toBeUndefined();
	expect(
		workRecordsFromState({ initiatives: new Map(), projects: new Map([["p", { ...project, phases: [] }]]) }),
	).toMatchObject({ projects: [{ delivery: { state: "unavailable" } }] });
});
it("forwards canonical count and full task incarnation without a local join", () => {
	const state = { initiatives: new Map(), projects: new Map([["p", { ...project, phases: [] }]]) };
	const delivery = { state: "available", phases: [], deliveredCount: 0 };
	const projectDelivery = vi.fn(() => delivery),
		taskPhase = vi.fn(() => "a"),
		readWork = vi.fn(() => state);
	globals[key] = { version: 3, readWork, projectDelivery, taskPhase };
	expect(workRecordsFromState(state)).toMatchObject({ projects: [{ delivery }] });
	expect(projectDelivery).toHaveBeenCalledWith(state, "p");
	const resolver = taskPhaseResolver("/synthetic/work", "/synthetic/queue");
	expect(resolver("p", 2, 123)).toBe("a");
	expect(taskPhase).toHaveBeenCalledWith(state, "p", "/synthetic/queue", 2, 123);
	expect(readWork).toHaveBeenCalledTimes(1);
});
it("task projection leaves dependencies and lane data alone, board retains phase annotation", () => {
	const phaseOf = vi.fn(() => null);
	const task: any = {
		id: 2,
		status: "ready",
		addedAt: 123,
		plan: { title: "Task" },
		parent: { project: "p" },
		after: [1],
		touches: ["repo"],
	};
	const before = structuredClone(task);
	const row = taskOf(task, "ops", undefined, { phaseOf });
	expect(row).toMatchObject({ phaseId: null, dependsOnRefs: ["ops #1"] });
	expect(task).toEqual(before);
	expect(phaseOf).toHaveBeenCalledWith("p", 2, 123);
	expect(buildTaskBoard({ at: 1000, rows: [{ task: row, queueIndex: 0 }], roster: [] }).tasks[0]).toMatchObject({
		phaseId: null,
	});
});
