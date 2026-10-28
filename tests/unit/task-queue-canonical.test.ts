/**
 * canonical-readers (Ops #621): the Queue panel's replay tests once more, with pi-queue's readers loaded, as they
 * are in the server once a chat has loaded pi-queue. taskQueueFromEntries and taskQueueAll then replay with
 * pi-queue's own replay (server/pi-queue-readers.ts) and must give the page what they give with apply(), this
 * repo's mirror of it, which the same tests check in their own files without the readers.
 */

import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { piQueueReaders } from "../../server/pi-queue-readers.js";

const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
const readersFile = join(pkg, "readers.ts");
if (!existsSync(readersFile))
	throw new Error(`pi-queue's readers not found at ${readersFile} (set PI_QUEUE_PKG; Ops #620)`);
// pi-queue's readers.ts publishes them on globalThis when it loads, as pi-queue's index.ts does in a chat.
await import(/* @vite-ignore */ pathToFileURL(readersFile).href);

it("pi-queue's readers are loaded, so the tests below replay with pi-queue's own replay", () => {
	expect(piQueueReaders()?.version).toBe(1);
});

await import("./task-queue.test.js");
await import("./queue-autonomy.test.js");
await import("./queue-blocks.test.js");
await import("./queue-lead-reminders.test.js");
await import("./queue-profiles.test.js");
await import("./queue-requester.test.js");
await import("./roles-lanes.test.js");
