import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkRecordsFile } from "../../server/work-records.js";
import { PI_QUEUE_READERS_KEY } from "../../server/pi-queue-readers.js";

it("a canonical bridge arriving after startup refreshes unavailable data without a registry write", async () => {
	const globals = globalThis as Record<symbol, unknown>;
	const v4 = Symbol.for("pi-queue.readers.v4");
	const old = globals[PI_QUEUE_READERS_KEY],
		old4 = globals[v4];
	const dir = mkdtempSync(join(tmpdir(), "delivery-cache-"));
	const file = join(dir, "events.jsonl");
	const r = {
		id: "i",
		kind: "initiative",
		name: "I",
		outcome: "Direction",
		lead: "ops",
		status: "active",
		doneWhen: ["One"],
		met: [],
	};
	try {
		delete globals[PI_QUEUE_READERS_KEY];
		delete globals[v4];
		writeFileSync(file, JSON.stringify({ v: 1, op: "initiative.create", ...r }) + "\n");
		const reader = new WorkRecordsFile(() => file);
		expect((await reader.get()).initiatives[0].currentProject?.state).toBe("unavailable");
		globals[PI_QUEUE_READERS_KEY] = {
			version: 1,
			replay() {},
			readWork: () => ({ initiatives: new Map([["i", r]]), projects: new Map(), links: new Map() }),
		};
		globals[v4] = {
			version: 4,
			deliveryProjection: () => ({
				initiatives: [
					{
						id: "i",
						outcome: "Direction",
						doneWhen: [{ item: "One", met: false }],
						taskRefs: [],
						currentProject: { state: "unselected" },
					},
				],
				projects: [],
			}),
		};
		expect((await reader.get()).initiatives[0].currentProject?.state).toBe("unselected");
		delete globals[v4];
		expect((await reader.get()).initiatives[0].currentProject?.state).toBe("unavailable");
	} finally {
		if (old === undefined) delete globals[PI_QUEUE_READERS_KEY];
		else globals[PI_QUEUE_READERS_KEY] = old;
		if (old4 === undefined) delete globals[v4];
		else globals[v4] = old4;
		rmSync(dir, { recursive: true, force: true });
	}
});
