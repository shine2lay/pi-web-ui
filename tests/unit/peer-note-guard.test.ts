import { describe, expect, it } from "vitest";
import { peerGuardRoute, stampGuardedPeer, type PeerGuardEnvelope } from "../../server/peer-note-guard.js";
import type { GuardCommandAny } from "../../server/role-message-guard-contract-v2.js";
import type { RoleMessageRecord } from "../../server/role-messages.js";

// Synthetic native envelopes only; these fixtures confer no real authority.
const envelope: PeerGuardEnvelope = {
	id: "pn-1111111111111111",
	target: "/task2.jsonl",
	textHash: "raw-hash",
	peer: { v: 1, queue: "/home.jsonl", fromTask: 1, toTask: 2, kind: "question" },
	sender: { role: "architecture", title: "Architecture", file: "/task1.jsonl", chat: "task #1", handling: 12 },
	draft: {
		kind: "question",
		text: "technical question",
		to: { role: "architecture", title: "Architecture" },
		replyTo: null,
		initiative: "",
	},
	decision: { result: "allow", records_added: 1 },
};
const command = {
	kind: "business_send",
	identity: { actor: { role: "architecture", sessionFile: "/task1.jsonl" } },
	to: "architecture",
	text: "technical question",
	businessKind: "question",
	replyTo: null,
} as unknown as Extract<GuardCommandAny, { kind: "business_send" }>;
const record: RoleMessageRecord = {
	id: envelope.id,
	target: envelope.target,
	at: 1,
	from: { role: "architecture", title: "Architecture", chat: "task #1", file: "/task1.jsonl" },
	to: envelope.draft.to,
	kind: "question",
	chain: 13,
	text: envelope.draft.text,
	state: "waiting",
	sends: 0,
	attempts: 0,
};
describe("peer guard native envelope", () => {
	it("leaves ordinary business sends unchanged", () => {
		expect(peerGuardRoute(undefined, command)).toBeUndefined();
		expect(stampGuardedPeer(record, undefined)).toBe(record);
	});
	it("sets only native identity and routing, not authority", () => {
		expect(peerGuardRoute(envelope, command)).toEqual({ id: envelope.id, target: envelope.target });
	});
	it.each(["text", "to", "replyTo", "businessKind"] as const)("rejects a mismatched %s", (field) => {
		expect(() => peerGuardRoute(envelope, { ...command, [field]: "different" } as typeof command)).toThrow(
			/does not match/,
		);
	});
	it("persists metadata with the native outbox record without changing its admitted chain", () => {
		const stored = stampGuardedPeer(record, envelope);
		expect(JSON.parse(JSON.stringify(stored))).toMatchObject({
			peer: envelope.peer,
			peerTextHash: "raw-hash",
			scanFrom: 0,
			chain: 13,
			id: envelope.id,
			target: envelope.target,
		});
		expect(record.peer).toBeUndefined();
	});
	it("rejects mismatched materialized identity or route", () => {
		expect(() => stampGuardedPeer({ ...record, id: "rm-11111111" }, envelope)).toThrow(/mismatch/);
		expect(() => stampGuardedPeer({ ...record, target: "/home.jsonl" }, envelope)).toThrow(/mismatch/);
	});
});
