// RTPI/1 serialized journal and checkpoint (Ops #136, unit C0): fixed stage cases with naive "old code" counterfactuals.
// Synthetic rtpi-fixture records in private temporary directories only: no real chat, store or model call.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	appendFile,
	chmod,
	open as fsOpen,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRtpiFixtureCapability,
	rtpiCheckpointDigest,
	rtpiEncodeFrame,
	rtpiRecoverSegment,
	rtpiStructural,
	rtpiValidate,
	type RtpiAccepted,
	type RtpiRef,
	type RtpiVerdict,
} from "../../server/rtpi-core.js";
import { RtpiJournal, rtpiJournalGrant, type RtpiJournalGrant } from "../../server/rtpi-journal.js";

type J = Record<string, unknown>;
const ref = (kind: string, id: string, revision = "1"): RtpiRef => ({ namespace: "rtpi-fixture", kind, id, revision });
const SOURCE = ref("source", "fixture-source");
const ISSUER = ref("issuer", "fixture-issuer");
const SUBJECT = ref("subject", "role-ops");
const LINEAGE = ref("lineage", "lineage-ops");
const CAP = createRtpiFixtureCapability({
	source: SOURCE,
	issuer: ISSUER,
	subject: SUBJECT,
	roots: ["rtpi/event/1", "rtpi/checkpoint/1"],
	facts: ["queue-snapshot"],
	policyAccepted: true,
	acceptedSidecars: [],
	seams: { inputHook: true, atomicOutbox: true, ownerPrincipal: true, confinedReader: true, issuerRegistry: true },
});
const COUNTS = { ready: 1, working: 1, asking: 0, stuck: 0, waiting: 0, blocked: 0, done: 0 };

function ok(v: RtpiVerdict): RtpiAccepted {
	if (v.status !== "accepted") throw new Error(`${v.status}: ${v.reason}`);
	return v;
}
/** Queue snapshot n of one lineage, qualified by rtpiValidate; `done` changes the bytes but not the dedup key. */
function snapshot(n: number, done = n, eventId = `event-${n}`): RtpiAccepted {
	const context: J = { queue: ref("queue", "queue-ops"), taskId: null, planRevision: null, session: null, epoch: null };
	for (const k of ["turn", "run", "attempt", "recipient", "action", "artifact", "owner", "client", "window"])
		context[k] = null;
	for (const k of ["projection", "coverage", "policy", "challenge"]) context[k] = null;
	context.channel = "role";
	const record = {
		schema: "rtpi/event/1",
		eventId,
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		lineage: LINEAGE,
		incarnation: "inc-1",
		sequence: n,
		revision: n,
		expectedRevision: n - 1,
		occurredAt: 1000 + n,
		context,
		body: {
			fact: "queue-snapshot",
			status: "known",
			capacity: 4,
			occupied: 2,
			counts: { ...COUNTS, done },
			fullIndex: true,
			refs: [],
		},
	};
	return ok(
		rtpiValidate(record, CAP, {
			lineage: LINEAGE,
			incarnation: "inc-1",
			currentRevision: n - 1,
			currentSequence: n - 1,
			sourceCommitted: true,
			serverNow: 5000,
		}),
	);
}
function checkpoint(sequence: number, held: RtpiRef[] = [], objectId = `cp-${sequence}`): RtpiAccepted {
	const c: J = {
		schema: "rtpi/checkpoint/1",
		objectId,
		source: SOURCE,
		issuer: ISSUER,
		subject: SUBJECT,
		lineage: LINEAGE,
		sequence,
		sourceWatermark: sequence,
		captureStart: 0,
		cutoff: 1000 + sequence,
		gapFree: true,
		durable: true,
		policy: ref("policy", "capture-policy"),
		dedup: [],
		accepted: [],
		held,
		acknowledged: [],
		needed: [],
	};
	return ok(
		rtpiValidate({ ...c, hash: rtpiCheckpointDigest(c) }, CAP, {
			lineage: LINEAGE,
			sourceCommitted: true,
			checkpointReconciled: true,
		}),
	);
}

let dir = "";
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "rtpi-journal-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});
const grant = (directory = dir): RtpiJournalGrant | null => rtpiJournalGrant({ enabled: true, directory });
const openJournal = async (): Promise<RtpiJournal> => RtpiJournal.open(grant());
const SEGMENT = () => join(dir, "segment-000001.rtpi");
/** Name -> content hash (regular files) or mode (anything else, never read): proves nothing was changed or deleted. */
async function fingerprint(): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const name of (await readdir(dir)).sort()) {
		const st = await lstat(join(dir, name));
		out[name] = st.isFile()
			? createHash("sha256")
					.update(await readFile(join(dir, name)))
					.digest("hex")
			: `mode ${st.mode}`;
	}
	return out;
}
async function seeded(n = 3): Promise<RtpiJournal> {
	const j = await openJournal();
	for (let i = 1; i <= n; i++) expect(await j.append(snapshot(i))).toEqual({ status: "appended", sequence: i });
	return j;
}

describe("D-INERT and V18: off by default", () => {
	it("without a grant the journal is unavailable and touches no file", async () => {
		expect(rtpiJournalGrant({ enabled: false, directory: dir })).toBeNull();
		expect(rtpiJournalGrant({ enabled: "true" as unknown as boolean, directory: dir })).toBeNull();
		const j = await RtpiJournal.open(null);
		expect(j.state).toMatchObject({ status: "unavailable", reason: "journal-off" });
		expect(await j.append(snapshot(1))).toEqual({ status: "unavailable", reason: "journal-off" });
		expect(await j.writeCheckpoint(checkpoint(1))).toEqual({ status: "unavailable", reason: "journal-off" });
		expect(await readdir(dir)).toEqual([]);
	});

	it("a copied or forged grant is no grant", async () => {
		const real = grant();
		expect(() => JSON.stringify(real)).toThrow("journal-grant-not-serializable");
		const j = await RtpiJournal.open({ directory: dir });
		expect(j.state.status).toBe("unavailable");
		expect(await j.append(snapshot(1))).toEqual({ status: "unavailable", reason: "journal-off" });
		expect(await readdir(dir)).toEqual([]);
	});

	it("needs an absolute, normalized, private directory owned by this user", async () => {
		expect(() => grant("journal")).toThrow("journal-directory-not-absolute");
		expect(() => grant(`${dir}/../x`)).toThrow("journal-directory-not-absolute");
		expect((await RtpiJournal.open(grant(join(dir, "missing")))).state).toMatchObject({
			status: "unavailable",
			reason: "journal-missing",
		});
		await chmod(dir, 0o755);
		expect((await openJournal()).state).toMatchObject({
			status: "unavailable",
			reason: "journal-directory-not-confined",
		});
		await chmod(dir, 0o700);
		const alias = `${dir}-alias`;
		await symlink(dir, alias);
		try {
			expect((await RtpiJournal.open(grant(alias))).state).toMatchObject({
				status: "unavailable",
				reason: "journal-directory-not-confined",
			});
		} finally {
			await rm(alias);
		}
	});

	it("switching it off and on again loses, reclassifies and resends nothing", async () => {
		const j = await seeded();
		expect(await j.writeCheckpoint(checkpoint(3))).toEqual({ status: "written", sequence: 3 });
		const before = await fingerprint();
		const off = await RtpiJournal.open(null);
		expect(off.state.status).toBe("unavailable");
		expect(off.records()).toEqual([]);
		expect(await fingerprint()).toEqual(before);
		const on = await openJournal();
		expect(on.state).toMatchObject({ status: "clean", lastSequence: 3, checkpointSequence: 3 });
		expect(on.records().map((f) => f.record.digest)).toEqual([1, 2, 3].map((n) => snapshot(n).digest));
		expect(await on.append(snapshot(3))).toEqual({ status: "duplicate", sequence: 3 });
		expect(await fingerprint()).toEqual(before);
	});
});

describe("V04, S02 and S05: framed, serialized, deduplicated appends", () => {
	it("appends fsynced frames to a private segment and recovers them after a restart", async () => {
		const j = await seeded();
		expect(j.state).toMatchObject({ status: "clean", lastSequence: 3, segments: 1 });
		expect(await readdir(dir)).toEqual(["segment-000001.rtpi"]);
		expect((await stat(SEGMENT())).mode & 0o777).toBe(0o600);
		const again = await openJournal();
		expect(again.state).toMatchObject({ status: "clean", lastSequence: 3, segments: 1 });
		expect(again.records().map((f) => f.sequence)).toEqual([1, 2, 3]);
		expect(again.records().map((f) => f.record.digest)).toEqual([1, 2, 3].map((n) => snapshot(n).digest));
	});

	it("the same record returns its first receipt; other bytes under the same key are a conflict; neither writes", async () => {
		const j = await seeded(1);
		const before = await fingerprint();
		expect(await j.append(snapshot(1))).toEqual({ status: "duplicate", sequence: 1 });
		expect(await j.append(snapshot(1, 9))).toEqual({ status: "conflict", sequence: 1, reason: "dedup-key-conflict" });
		expect(await fingerprint()).toEqual(before);
		// After a restart (crash before the caller saw the ack) the same record still has one receipt, no second effect.
		expect(await (await openJournal()).append(snapshot(1))).toEqual({ status: "duplicate", sequence: 1 });
		expect(await fingerprint()).toEqual(before);
	});

	it("only records qualified by rtpiValidate enter the journal", async () => {
		const j = await openJournal();
		const structural = ok(rtpiStructural(JSON.parse(snapshot(1).canonical)));
		expect(structural.qualified).toBe(false);
		expect(await j.append(structural)).toEqual({ status: "rejected", reason: "record-not-qualified" });
		expect(await j.append({ ...snapshot(1) })).toEqual({ status: "rejected", reason: "frame-record-not-validated" });
		expect(await readdir(dir)).toEqual([]);
	});

	it("serializes concurrent appends: twenty at once get 1..20 in order", async () => {
		const expected = Array.from({ length: 20 }, (_, i) => i + 1);
		// Counterfactual: computing "last + 1" before an await hands every caller the same sequence.
		let last = 0;
		const naive = await Promise.all(
			expected.map(async () => {
				const s = last + 1;
				await Promise.resolve();
				last = s;
				return s;
			}),
		);
		expect(new Set(naive).size).toBe(1);
		const j = await openJournal();
		const results = await Promise.all(expected.map((n) => j.append(snapshot(n))));
		expect(results).toEqual(expected.map((sequence) => ({ status: "appended", sequence })));
		expect((await openJournal()).records().map((f) => f.sequence)).toEqual(expected);
	});
});

describe("Security rm-b79f71e9 note 2: an id never names a file", () => {
	it("records with ids '.', '..' and 'a:b' are kept under the fixed names only", async () => {
		const root = join(dir, "journal");
		await mkdir(root, { mode: 0o700 });
		// Old-code counterfactual: a store that named files by id would write over its root or escape it.
		expect(join(root, ".")).toBe(root);
		expect(join(root, "..")).toBe(dir);
		const j = await RtpiJournal.open(grant(root));
		expect(await j.append(snapshot(1, 1, "."))).toEqual({ status: "appended", sequence: 1 });
		expect(await j.append(snapshot(2, 2, ".."))).toEqual({ status: "appended", sequence: 2 });
		expect(await j.append(snapshot(3, 3, "a:b"))).toEqual({ status: "appended", sequence: 3 });
		expect(await j.writeCheckpoint(checkpoint(3, [], ".."))).toEqual({ status: "written", sequence: 3 });
		expect((await readdir(root)).sort()).toEqual(["checkpoint.rtpi", "segment-000001.rtpi"]);
		expect(await readdir(dir)).toEqual(["journal"]);
		const again = await RtpiJournal.open(grant(root));
		expect(again.state).toMatchObject({ status: "clean", lastSequence: 3, checkpointSequence: 3 });
		expect(again.records().map((f) => f.record.root.eventId)).toEqual([".", "..", "a:b"]);
		expect(again.checkpoint()?.root.objectId).toBe("..");
	});
});

describe("S05 recovery: quarantine, never repair", () => {
	it("a torn tail (crash mid-append) is quarantined and left exactly as it was", async () => {
		await seeded();
		await appendFile(SEGMENT(), '{"digest":"');
		const before = await fingerprint();
		const j = await openJournal();
		expect(j.state).toMatchObject({ status: "quarantine", reason: "torn-tail", lastSequence: 3 });
		expect(j.records()).toEqual([]);
		expect(await j.append(snapshot(4))).toEqual({ status: "quarantine", reason: "torn-tail" });
		expect(await fingerprint()).toEqual(before);
	});

	it("a corrupt, duplicated, skipped or replayed frame is quarantined", async () => {
		await seeded();
		const text = await readFile(SEGMENT(), "utf8");
		const lines = text
			.split("\n")
			.filter(Boolean)
			.map((l) => `${l}\n`);
		const states: unknown[] = [];
		for (const body of [
			lines[0]! + lines[1]!.replace('"done":2', '"done":7') + lines[2]!,
			lines[0]! + lines[0]!,
			lines[0]! + lines[2]!,
			text + rtpiEncodeFrame(4, snapshot(1)),
			text + rtpiEncodeFrame(4, snapshot(1, 9)),
		]) {
			await writeFile(SEGMENT(), body);
			states.push((await openJournal()).state.reason);
		}
		expect(states).toEqual([
			"frame-digest-mismatch",
			"frame-sequence-duplicate",
			"frame-sequence-gap",
			"frame-dedup-replay",
			"frame-dedup-conflict",
		]);
		// Counterfactual: the per-frame checks alone accept the replay as a fourth record.
		expect(rtpiRecoverSegment(text + rtpiEncodeFrame(4, snapshot(1)), 0)).toMatchObject({
			state: "clean",
			lastSequence: 4,
		});
	});

	it("a missing segment, a symlink, a hard link or a FIFO is quarantined", async () => {
		await seeded();
		await writeFile(join(dir, "segment-000003.rtpi"), "");
		expect((await openJournal()).state).toMatchObject({ status: "quarantine", reason: "segment-gap" });
		await rm(join(dir, "segment-000003.rtpi"));
		const real = join(dir, "real.bin");
		await rename(SEGMENT(), real);
		await symlink(real, SEGMENT());
		expect((await openJournal()).state).toMatchObject({ status: "quarantine", reason: "journal-file-not-regular" });
		await rm(SEGMENT());
		await link(real, SEGMENT());
		expect((await openJournal()).state).toMatchObject({ status: "quarantine", reason: "journal-file-not-regular" });
		await rm(SEGMENT());
		execFileSync("mkfifo", [SEGMENT()]);
		expect((await openJournal()).state).toMatchObject({ status: "quarantine", reason: "journal-file-not-regular" });
	});

	it("a foreign write between appends is quarantined and never written over", async () => {
		const j = await seeded(1);
		await appendFile(SEGMENT(), "x");
		const before = await fingerprint();
		expect(await j.append(snapshot(2))).toEqual({ status: "quarantine", reason: "journal-foreign-write" });
		expect(await j.append(snapshot(2))).toEqual({ status: "quarantine", reason: "journal-foreign-write" });
		expect(await fingerprint()).toEqual(before);
	});
});

describe("S07 and C05 caps: overflow is unavailable and deletes nothing", () => {
	it("a segment over 1 MiB or more than 10 segments makes the journal unavailable", async () => {
		await writeFile(SEGMENT(), Buffer.alloc(1048577, 0x20));
		let before = await fingerprint();
		expect((await openJournal()).state).toMatchObject({ status: "unavailable", reason: "journal-read-cap" });
		expect(await fingerprint()).toEqual(before);
		for (let n = 1; n <= 11; n++) await writeFile(join(dir, `segment-${String(n).padStart(6, "0")}.rtpi`), "");
		before = await fingerprint();
		expect((await openJournal()).state).toMatchObject({ status: "unavailable", reason: "journal-active-read-cap" });
		expect(await fingerprint()).toEqual(before);
	});

	it("a crowded directory makes the journal unavailable", async () => {
		for (let i = 0; i < 65; i++) await writeFile(join(dir, `other-${i}`), "");
		const before = await fingerprint();
		expect((await openJournal()).state).toMatchObject({ status: "unavailable", reason: "journal-directory-crowded" });
		expect(await fingerprint()).toEqual(before);
	});
});

describe("R07 and S05 checkpoints", () => {
	it("writes a verified checkpoint atomically and restores it after a restart", async () => {
		const j = await seeded(2);
		expect(await j.writeCheckpoint(checkpoint(2))).toEqual({ status: "written", sequence: 2 });
		expect((await readdir(dir)).sort()).toEqual(["checkpoint.rtpi", "segment-000001.rtpi"]);
		const again = await openJournal();
		expect(again.state).toMatchObject({ status: "clean", checkpointSequence: 2 });
		expect(again.checkpoint()?.digest).toBe(checkpoint(2).digest);
	});

	it("refuses a checkpoint ahead of the journal, a regression, a lost live reference or an unqualified one", async () => {
		const j = await seeded();
		const held = [ref("operation", "op1")];
		expect(await j.writeCheckpoint(checkpoint(4))).toEqual({
			status: "rejected",
			reason: "checkpoint-ahead-of-journal",
		});
		expect(await j.writeCheckpoint(checkpoint(2, held))).toEqual({ status: "written", sequence: 2 });
		expect(await j.writeCheckpoint(checkpoint(1, held))).toEqual({
			status: "rejected",
			reason: "checkpoint-regression",
		});
		expect(await j.writeCheckpoint(checkpoint(3))).toEqual({
			status: "rejected",
			reason: "checkpoint-live-reference-lost-held",
		});
		const structural = ok(rtpiStructural(JSON.parse(checkpoint(3, held).canonical)));
		expect(await j.writeCheckpoint(structural)).toEqual({ status: "rejected", reason: "checkpoint-not-validated" });
		expect(await j.writeCheckpoint(checkpoint(3, held))).toEqual({ status: "written", sequence: 3 });
	});

	it("a tampered checkpoint, or a journal rolled back behind it, is quarantined", async () => {
		const j = await seeded();
		const full = await readFile(SEGMENT(), "utf8");
		expect(await j.writeCheckpoint(checkpoint(3))).toEqual({ status: "written", sequence: 3 });
		const cp = join(dir, "checkpoint.rtpi");
		const good = await readFile(cp, "utf8");
		const tampered = good.replace('"cutoff":1003', '"cutoff":1004');
		expect(tampered).not.toBe(good);
		JSON.parse(tampered); // counterfactual: still well-formed JSON with a 64-hex hash
		await writeFile(cp, tampered);
		expect((await openJournal()).state).toMatchObject({ status: "quarantine", reason: "checkpoint-corrupt" });
		await writeFile(cp, good);
		const lines = full.split("\n").filter(Boolean);
		await writeFile(SEGMENT(), `${lines[0]}\n${lines[1]}\n`);
		expect((await openJournal()).state).toMatchObject({ status: "quarantine", reason: "journal-behind-checkpoint" });
	});

	it("a hard link planted at checkpoint.next is refused and its target is not emptied", async () => {
		// Counterfactual: opening the scratch name with O_TRUNC empties the file a planted hard link points to.
		const other = join(dir, "other.bin");
		await writeFile(other, "keep me");
		await link(other, join(dir, "naive.next"));
		await (await fsOpen(join(dir, "naive.next"), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC)).close();
		expect(await readFile(other, "utf8")).toBe("");
		await rm(other);
		await rm(join(dir, "naive.next"));
		const j = await seeded(1);
		const victim = join(dir, "victim.bin");
		await writeFile(victim, "keep me");
		await link(victim, join(dir, "checkpoint.next"));
		expect(await j.writeCheckpoint(checkpoint(1))).toEqual({
			status: "quarantine",
			reason: "journal-file-not-regular",
		});
		expect(await readFile(victim, "utf8")).toBe("keep me");
		expect(await readdir(dir)).not.toContain("checkpoint.rtpi");
	});
});
