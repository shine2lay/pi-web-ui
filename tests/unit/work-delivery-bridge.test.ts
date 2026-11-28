import { afterEach, expect, it, vi } from "vitest";
import { workRecordsFrom, workRecordsFromState } from "../../server/work-records.js";
import { workDeliveryReader } from "../../server/work-delivery-bridge.js";

const key = Symbol.for("pi-queue.readers.v4");
const globals = globalThis as Record<symbol, unknown>;
const original = globals[key];
afterEach(() => {
	if (original === undefined) delete globals[key];
	else globals[key] = original;
});
const initiative = {
	kind: "initiative",
	id: "i",
	name: "I",
	outcome: "Direction result",
	lead: "ops",
	status: "active",
	doneWhen: ["One", "Two"],
	met: [{ item: "One", proof: "Observed build", by: "ops", at: 100 }],
};
const state = () => ({ initiatives: new Map([["i", initiative]]), projects: new Map(), links: new Map() });
it("forwards native proof and exact refs without reconstructing either", () => {
	const projected = {
		id: "i",
		outcome: "Direction result",
		doneWhen: [
			{ item: "One", met: true, evidence: { proof: "Observed build", by: "ops", at: 100 } },
			{ item: "Two", met: false },
		],
		currentProject: { state: "selected", projectId: "p" },
		taskRefs: [{ queue: "/synthetic/ops.jsonl", task: 7, added: 123 }],
	};
	const deliveryProjection = vi.fn(() => ({ initiatives: [projected], projects: [] }));
	globals[key] = { version: 4, deliveryProjection };
	const s = state();
	expect(workRecordsFromState(s)?.initiatives[0]).toMatchObject({ ...projected, items: 2, met: 1 });
	expect(deliveryProjection).toHaveBeenCalledWith(s);
});
it("older canonical producer means unavailable focus/proof, not unmet or unselected", () => {
	delete globals[key];
	const r = workRecordsFromState(state())!.initiatives[0];
	expect(r.outcome).toBe("Direction result");
	expect(r.doneWhen).toEqual([
		{ item: "One", met: true },
		{ item: "Two", met: false },
	]);
	expect(r.currentProject?.state).toBe("unavailable");
	expect(r.taskRefs).toBeUndefined();
});
it("fallback never guesses focus or parses proof from events", () => {
	const log =
		[
			{ v: 1, op: "initiative.create", ...initiative },
			{ v: 1, op: "initiative.met", id: "i", item: "One", proof: "Observed build", by: "ops", ts: 100 },
			{ v: 1, op: "initiative.change", id: "i", changes: { currentProject: "p" } },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n";
	const r = workRecordsFrom(log).initiatives[0];
	expect(r.doneWhen).toEqual([
		{ item: "One", met: true },
		{ item: "Two", met: false },
	]);
	expect(r.currentProject?.state).toBe("unavailable");
	expect(r.outcome).toBe("Direction result");
});
it("missing, wrong-version and throwing bridges do not fabricate focus", () => {
	globals[key] = {
		version: 3,
		deliveryProjection() {
			throw new Error("old");
		},
	};
	expect(workDeliveryReader()).toBeUndefined();
	globals[key] = {
		version: 4,
		deliveryProjection() {
			throw new Error("unavailable");
		},
	};
	expect(workRecordsFromState(state())?.initiatives[0].currentProject?.state).toBe("unavailable");
});
