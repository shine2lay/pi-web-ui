import { expect, it, vi } from "vitest";
import { requesterInputOf, requesterOf } from "../../server/queue-requester.js";
import { requesterInputOf as queueInput, requesterOf as queueRequester } from "../../../pi-queue-ops-task-1120/queue-requester.ts";
// Reuse the queue owner's exact exported vectors, without registering its node:test suite.
vi.mock("node:test", () => ({ test: () => {} }));
import { requesterVectors } from "../../../pi-queue-ops-task-1120/tests/inbox-requester-acceptance.test.ts";

it.each(requesterVectors)("U4 real web requester and queue parity: $id", ({ raw, expected }) => {
	const envelope = { v: 1, inputs: [raw] };
	const wanted = expected ? { v: 1, inputs: [expected] } : undefined;
	expect.soft(requesterInputOf(raw)).toEqual(expected);
	expect.soft(requesterOf(envelope)).toEqual(wanted);
	expect.soft(requesterInputOf(raw)).toEqual(queueInput(raw));
	expect.soft(requesterOf(envelope)).toEqual(queueRequester(envelope));
});
