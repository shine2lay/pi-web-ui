import { appendFileSync } from "node:fs";
import { expect, it } from "vitest";
import { InboxRuntime } from "../../server/inbox-runtime.js";
import { ownTaskOf } from "../../server/own-task.js";
import { queueEntriesOf } from "../../server/role-messages.js";
import { taskQueueAll } from "../../server/task-queue.js";
import { chat, useGuardWorld } from "../unit/role-message-guard-host-harness.js";
import { core, seed, view } from "./inbox-core-fixture.js";
import { setup } from "./inbox-world.js";

useGuardWorld();
/** Native queue journal envelopes; priority is never passed directly to the inbox. */
function queueEntry(file: string, data: Record<string, unknown>) {
	appendFileSync(file, JSON.stringify({ type: "custom", customType: "queue", data: { v: 1, ...data } }) + "\n");
}
for (const id of ["C-PRI-14", "C-PRI-15"]) {
	it(`${id} HOME reader uses verified existing task priority`, async () => {
		const c = core(id),
			h = await setup();
		const task = c.input.sender_task as { readable: boolean; status: string; priority: string };
		const workerFile = chat("core-worker"),
			queueFile = chat("core-parent-queue");
		queueEntry(workerFile, {
			op: "assigned",
			id: 7,
			plan: { title: "Existing task" },
			from: { file: queueFile, title: "Alpha queue" },
		});
		queueEntry(queueFile, { op: "add", id: 7, plan: { title: "Existing task" }, priority: task.priority });
		queueEntry(queueFile, { op: "start", id: 7 });
		if (task.status === "done") queueEntry(queueFile, { op: "done", id: 7, summary: "Completed" });
		const own = ownTaskOf(await queueEntriesOf(workerFile));
		if (!own?.queueChat) throw new Error("Canonical worker binding missing");
		const queue = taskQueueAll(await queueEntriesOf(own.queueChat, true));
		expect(own.id).toBe(7);
		expect(queue.tasks.find((t) => t.id === own.id)).toMatchObject({
			priority: task.priority,
			status: task.status === "running" ? "working" : task.status,
		});
		await seed(h, (records) => {
			const r = records.find((r) => r.id === h.id)!;
			Object.assign(r, c.input.record);
			r.from = { ...r.from, file: workerFile, chat: "Queue #7" };
		});
		h.runtime = new InboxRuntime({
			...h.runtime.ports,
			senderTask: (file) => (file === workerFile ? { own, queue } : undefined),
		});
		const actual = view(h);
		expect(actual.class).toBe(c.expect.class);
		expect(actual.basePriority).toBe(c.expect.base);
		expect(actual.route).toBe(c.expect.route);
		expect(actual.reason).toBe(c.expect.reason);
	});
}
