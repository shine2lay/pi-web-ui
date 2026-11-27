import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { requesterInputOf, requesterOf } from "../../server/queue-requester.js";
import {
	requesterInputOf as queueInput,
	requesterOf as queueRequester,
} from "../../../pi-queue-ops-task-1120/queue-requester.ts";
import { requesterVectors } from "../../../pi-queue-ops-task-1120/tests/inbox-requester-vectors.ts";

// Queue 427c089: one pure shared vector source; no node:test import/registration.
const bytes = readFileSync(
	new URL("../../../pi-queue-ops-task-1120/tests/inbox-requester-vectors.ts", import.meta.url),
);
if (
	createHash("sha256").update(bytes).digest("hex") !==
	"69100f10ba641e89da39edc7cd6e189f8b182e791062e562cfd770bf0c18430a"
) {
	throw new Error("Shared inbox requester vectors changed; review the cross-repo pin");
}

it.each(requesterVectors)("U4 real web requester and queue parity: $id", ({ raw, expected }) => {
	const envelope = { v: 1, inputs: [raw] };
	const wanted = expected ? { v: 1, inputs: [expected] } : undefined;
	expect.soft(requesterInputOf(raw)).toEqual(expected);
	expect.soft(requesterOf(envelope)).toEqual(wanted);
	expect.soft(requesterInputOf(raw)).toEqual(queueInput(raw));
	expect.soft(requesterOf(envelope)).toEqual(queueRequester(envelope));
});
