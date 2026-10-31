/** Runs before application/extension imports; every data lookup belongs to this temporary world. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "question-coupled-"));
const values: Record<string, string | undefined> = {
	HOME: root,
	PI_CODING_AGENT_DIR: join(root, "agent"),
	PI_WEB_DATA_DIR: join(root, "web"),
	PI_IDENTITY_DIR: join(root, "roles"),
	PI_MEMORY_DIR: join(root, "memory"),
	PI_WORK_DIR: join(root, "work"),
	PI_QUEUE_TEST_FREEZE: "1",
	PI_QUEUE: undefined,
	PI_QUEUE_LANES: undefined,
	PI_QUEUE_LEAD_RECALL: undefined,
};
const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
for (const [name, value] of Object.entries(values)) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
for (const name of ["agent", "web", "roles", "memory", "work"]) mkdirSync(join(root, name), { recursive: true });
writeFileSync(join(root, "agent", "pi-queue.json"), JSON.stringify({ stalledAfterMinutes: 0, wakeOnDone: false }));
afterAll(() => {
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
