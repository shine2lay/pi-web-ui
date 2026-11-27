// Bridge the queue owner's existing native test fixture into this opt-in Vitest suite.
// No queue implementation or requester validator is copied here.
import { vi } from "vitest";
import { inboxRepoFile } from "./inbox-repo-roots.js";
vi.mock("node:test", async () => {
	const { afterAll, afterEach, beforeEach, vi } = await import("vitest");
	return ({
	after: afterAll,
	afterEach,
	beforeEach,
	mock: {
		timers: {
			enable: ({ now }: { now: number }) => {
				vi.useFakeTimers({ toFake: ["Date"] });
				vi.setSystemTime(now);
			},
			reset: () => vi.useRealTimers(),
		},
		method: (object: object, key: never, implementation: never) => vi.spyOn(object, key).mockImplementation(implementation),
		restoreAll: () => vi.restoreAllMocks(),
	},
});
});
export const { fixture, session, plan } = (await import(
	inboxRepoFile("pi-queue", "tests/inbox-helper-fixture.ts").href
)) as typeof import("../../../pi-queue/tests/inbox-helper-fixture.ts");
