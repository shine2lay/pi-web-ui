import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
	createPendingRecoveryCoordinator,
	catalogPendingRecovery,
	readPendingRecoveryArtifact,
	createPendingRecoveryReaderHtml,
	PENDING_OWNER_KEY,
	PENDING_OWNER_ENVELOPE_PREFIX,
	type RecoveryWork,
	type RecoveryOwnership,
	type RecoveryCoordinatorOptions,
} from "../../web/src/pending-recovery-coordinator";
import {
	createPendingSendStorage,
	PendingSendStorageError,
	type PendingRecoveryBackend,
	type RecoveryRecord,
} from "../../web/src/pending-send-storage";
import { applyPromptAck, PENDING_STORAGE_KEY } from "../../web/src/pending-sends";

const clone = <T>(value: T): T => structuredClone(value);
function prompt(id = "p-原始"): RecoveryWork & { kind: "prompt" } {
	return {
		kind: "prompt",
		pending: {
			id,
			conversationId: "c1",
			sessionId: "session-一",
			text: "原始\r\n é 🌈",
			queue: true,
			createdAt: 42,
			status: "sending",
			sameTextBefore: ["old"],
			queueBase: 1,
			attachments: [
				{ path: "blob:expired-but-inline", imageData: "AP8BAgM=", mimeType: "image/png", name: "零-图.png", size: 5 },
				{ path: "", fileData: "AAEC", name: "a\n.bin", size: 3 },
			],
		},
	};
}
const command = (id = "command-1"): RecoveryWork & { kind: "command" } => ({
	kind: "command",
	id,
	conversationId: "c1",
	sessionId: "session-一",
	createdAt: 43,
	payload: '{ "type": "prompt", "text": "/opaque \\u4e00", "unknown": [0, false] }\r\n',
});
class MemoryStorage implements Storage {
	values = new Map<string, string>();
	get length() {
		return this.values.size;
	}
	key(i: number) {
		return [...this.values.keys()][i] ?? null;
	}
	getItem(key: string) {
		return this.values.get(key) ?? null;
	}
	setItem(key: string, value: string) {
		this.values.set(key, value);
	}
	removeItem(key: string) {
		this.values.delete(key);
	}
	clear() {
		this.values.clear();
	}
}
class MemoryBackend implements PendingRecoveryBackend {
	records = new Map<string, RecoveryRecord>();
	writeFailure: unknown;
	readFailure: unknown;
	releaseFailure: unknown;
	beforeCommit?: () => Promise<void>;
	writes = 0;
	async read(owner: string) {
		if (this.readFailure) throw this.readFailure;
		return clone([...this.records.values()].filter((r) => r.ownerId === owner));
	}
	async write(records: readonly RecoveryRecord[]) {
		this.writes++;
		const staged = new Map(this.records);
		for (const record of records) {
			const key = JSON.stringify(record.key);
			const prior = staged.get(key);
			if (prior?.state === "released") throw new PendingSendStorageError("released", "Released");
			if (prior && prior.contentDigest !== record.contentDigest)
				throw new PendingSendStorageError("conflict", "Different body");
			staged.set(key, clone(record));
		}
		await this.beforeCommit?.();
		if (this.writeFailure) throw this.writeFailure;
		this.records = staged;
	}
	async release(record: RecoveryRecord & { state: "released" }) {
		if (this.releaseFailure) throw this.releaseFailure;
		const key = JSON.stringify(record.key);
		const prior = this.records.get(key);
		if (prior && prior.contentDigest !== record.contentDigest)
			throw new PendingSendStorageError("conflict", "Different release body");
		this.records.set(key, clone(record));
	}
}
class Ownership implements RecoveryOwnership {
	held = new Set<string>();
	async acquire(owner: string) {
		if (this.held.has(owner)) return null;
		this.held.add(owner);
		return {
			release: () => {
				this.held.delete(owner);
			},
		};
	}
	async active() {
		return [...this.held];
	}
}
function fixture(extra: RecoveryCoordinatorOptions = {}, create = createPendingRecoveryCoordinator) {
	const backend = new MemoryBackend();
	const tabStorage = new MemoryStorage();
	const envelopes = new MemoryStorage();
	const ownership = new Ownership();
	const options = {
		backend,
		tabStorage,
		envelopes,
		ownership,
		newOwnerId: () => "owner-a",
		listOwners: async () => [...new Set([...backend.records.values()].map((r) => r.ownerId))],
		...extra,
	};
	return { backend, tabStorage, envelopes, ownership, options, api: create(options) };
}
async function ready(extra: RecoveryCoordinatorOptions = {}) {
	const f = fixture(extra);
	expect((await f.api.start()).state).toBe("ready");
	return f;
}
async function saved(f: Awaited<ReturnType<typeof ready>>, work: RecoveryWork = prompt()) {
	const result = await f.api.prepare(work);
	expect(result.ok).toBe(true);
	if (!result.ok) throw Error("fixture not prepared");
	return result.prepared;
}
const pendingRecords = (backend: MemoryBackend) => [...backend.records.values()].filter((r) => r.state === "pending");
function resign(value: Record<string, unknown>) {
	const { checksum: _checksum, ...body } = value;
	return JSON.stringify({ ...body, checksum: createHash("sha256").update(JSON.stringify(body)).digest("hex") });
}

describe("unchanged-baseline behavioral contract", () => {
	it("refuses a second cloned active owner mutation", async () => {
		const f = await ready();
		await saved(f);
		const clonedTab = new MemoryStorage();
		clonedTab.setItem(PENDING_OWNER_KEY, "owner-a");
		if (process.env.PENDING_COORDINATOR_BASELINE === "1") {
			// The unchanged #578 API namespaces by caller token, but does not enforce exclusive ownership.
			const a = createPendingSendStorage({ ownerId: "owner-a", storage: f.tabStorage, backend: f.backend });
			await a.save([prompt("clone").pending]);
			expect(
				pendingRecords(f.backend).some((r) => r.key[3] === "clone"),
				"cloned owner must not mutate",
			).toBe(false);
			return;
		}
		const other = createPendingRecoveryCoordinator({ ...f.options, tabStorage: clonedTab });
		expect((await other.start()).state).toBe("conflict");
		expect(await other.prepare(prompt("clone"))).toMatchObject({ ok: false, payloadCommitted: false });
		expect(pendingRecords(f.backend)).toHaveLength(1);
	});
	it("retains a volatile positive ack without persisted proof", async () => {
		const p = prompt().pending;
		if (process.env.PENDING_COORDINATOR_BASELINE === "1") {
			expect(
				applyPromptAck([p], { id: p.id, conversationId: "c1", ok: true }, null),
				"volatile queue ack is not persistence",
			).toEqual([p]);
			return;
		}
		const f = await ready();
		await saved(f);
		expect(await f.api.observe({ kind: "volatile" })).toEqual({ released: false });
		expect(pendingRecords(f.backend)).toHaveLength(1);
	});
	it("positive control: unknown ack leaves baseline pending unchanged", () => {
		const p = prompt().pending;
		expect(applyPromptAck([p], { id: "another-id", conversationId: "c1", ok: true }, null)).toEqual([p]);
	});
	it("positive control: distinct owners may mutate distinct recovery sets", async () => {
		const f = await ready();
		await saved(f);
		const other = createPendingRecoveryCoordinator({
			...f.options,
			tabStorage: new MemoryStorage(),
			newOwnerId: () => "owner-b",
		});
		expect((await other.start()).state).toBe("ready");
		expect((await other.prepare(command())).ok).toBe(true);
		expect(pendingRecords(f.backend)).toHaveLength(2);
		await other.close();
	});
});

// Frozen-source mode uses the very same public APIs, not a missing export/import as its red.
const collisionApi: typeof import("../../web/src/pending-recovery-coordinator") = process.env.PENDING_CARRIER_SOURCE
	? await import(process.env.PENDING_CARRIER_SOURCE)
	: await import("../../web/src/pending-recovery-coordinator");
const provenance = "__piWebPendingRecovery";
function legacyCases() {
	const malformed = { format: "pi-web-pending-work-v1", work: { kind: "command", payload: false } };
	const nested = command("nested-original");
	nested.attachments = clone(prompt().pending.attachments);
	const collision = {
		...prompt("command:nested-original").pending,
		text: JSON.stringify({ format: "pi-web-pending-work-v1", work: nested }),
		createdAt: nested.createdAt,
		queue: false,
		sameTextBefore: [],
		queueBase: 0,
	};
	const cases: [string, ReturnType<typeof prompt>["pending"]][] = [
		["marker-only", { ...prompt().pending, text: '{"format":"pi-web-pending-work-v1"}' }],
		["malformed nested work", { ...prompt("prompt:literal").pending, text: JSON.stringify(malformed) }],
		[
			"well-shaped nested work",
			{ ...prompt().pending, text: JSON.stringify({ format: "pi-web-pending-work-v1", work: prompt("nested") }) },
		],
		["exact old carrier skeleton and ID-prefix collision", collision],
		[
			"ordinary text and ID-prefix collision",
			{ ...prompt("command:ordinary").pending, text: "ordinary\r\n é 🌈", sameTextBefore: [], queueBase: 0 },
		],
		[
			"future-looking marker remains text",
			{ ...prompt("prompt:command:literal").pending, text: '{"format":"pi-web-pending-work-v99","work":null}' },
		],
	];
	return cases.map(([name, p]) => [name, { ...p, status: "failed" as const }] as const);
}

describe("carrier recognition public API", () => {
	for (const [name, pending] of legacyCases()) {
		it(`legacy ${name}: exact owner restore, independent read/export/import without nested substitution`, async () => {
			const f = fixture({}, collisionApi.createPendingRecoveryCoordinator);
			const source = JSON.stringify([pending]);
			f.tabStorage.setItem(PENDING_STORAGE_KEY, source);
			const expected: RecoveryWork = { kind: "prompt", pending };
			const initial = await f.api.start();
			expect(initial.state, "valid ordinary legacy work must be usable, not merely retained raw").toBe("ready");
			expect(initial.entries.map((e) => e.prepared.work)).toEqual([expected]);
			expect(initial.entries[0].prepared).toMatchObject({
				ownerId: "owner-a",
				kind: "prompt",
				id: pending.id,
				sessionId: pending.sessionId,
			});
			expect(initial.entries[0].prepared.contentDigest).toBe(
				createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
			);
			expect(await f.api.returnToComposer(initial.entries[0].prepared)).toEqual(expected);
			expect(await f.api.observe({ kind: "volatile" })).toEqual({ released: false });
			expect(pendingRecords(f.backend)).toHaveLength(1);
			expect(f.tabStorage.getItem(PENDING_STORAGE_KEY)).toBe(source);
			const artifact = await f.api.exportArtifact();
			expect(await collisionApi.readPendingRecoveryArtifact(artifact)).toMatchObject({
				complete: true,
				work: [expected],
			});
			await f.api.close();
			const reloaded = collisionApi.createPendingRecoveryCoordinator(f.options);
			expect(await reloaded.start()).toMatchObject({
				state: "ready",
				entries: [{ lifecycle: "unresolved", prepared: { work: expected } }],
			});
			expect((await reloaded.restore()).entries.map((e) => e.prepared.work)).toEqual([expected]);
			expect(await reloaded.prepare(expected)).toMatchObject({ ok: true, dispatch: "status-required" });
			await reloaded.close();
			const target = fixture({}, collisionApi.createPendingRecoveryCoordinator);
			expect((await target.api.start()).state).toBe("ready");
			expect((await target.api.importArtifact(artifact)).entries.map((e) => e.prepared.work)).toEqual([expected]);
			expect((await collisionApi.readPendingRecoveryArtifact(await target.api.exportArtifact())).work).toEqual([
				expected,
			]);
		});
	}
	for (const text of ['{"format":"pi-web-pending-work-v1"}', "ordinary native text"]) {
		it(`ordinary native #578 prompt stays literal: ${text}`, async () => {
			const f = fixture({}, collisionApi.createPendingRecoveryCoordinator);
			const pending = { ...prompt("prompt:native-literal").pending, text, status: "failed" as const };
			await createPendingSendStorage({ ownerId: "owner-a", backend: f.backend, storage: f.envelopes }).save([pending]);
			// Move only the test store's envelope into the actual coordinator owner slot.
			f.envelopes.setItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`, f.envelopes.getItem(PENDING_STORAGE_KEY)!);
			expect(await f.api.start()).toMatchObject({
				state: "ready",
				entries: [{ prepared: { work: { kind: "prompt", pending } } }],
			});
			expect(await collisionApi.readPendingRecoveryArtifact(await f.api.exportArtifact())).toMatchObject({
				complete: true,
				work: [{ kind: "prompt", pending }],
			});
		});
	}
	for (const [name, pending] of legacyCases().filter(([, p]) => p.sameTextBefore.length > 0)) {
		it(`unambiguous old literal artifact ${name}: independent read then public import`, async () => {
			const f = fixture({}, collisionApi.createPendingRecoveryCoordinator);
			await f.api.start();
			const artifact = JSON.parse(await f.api.exportArtifact());
			artifact.envelope = JSON.stringify([pending]);
			const raw = resign(artifact);
			const expected: RecoveryWork = { kind: "prompt", pending };
			expect(await collisionApi.readPendingRecoveryArtifact(raw)).toMatchObject({
				complete: true,
				work: [expected],
			});
			expect((await f.api.importArtifact(raw)).entries.map((e) => e.prepared.work)).toEqual([expected]);
			expect((await collisionApi.readPendingRecoveryArtifact(await f.api.exportArtifact())).work).toEqual([expected]);
		});
	}
	it("control: genuinely prepared prompt and opaque command round-trip exact originals", async () => {
		const f = fixture({}, collisionApi.createPendingRecoveryCoordinator);
		await f.api.start();
		const p = prompt("prompt:command:genuine");
		p.pending.text = '{"format":"pi-web-pending-work-v1"}';
		for (const work of [p, command()]) expect((await f.api.prepare(work)).ok).toBe(true);
		expect((await f.api.restore()).entries.map((e) => e.prepared.work)).toEqual([p, command()]);
		const artifact = await f.api.exportArtifact();
		expect(await collisionApi.readPendingRecoveryArtifact(artifact)).toMatchObject({
			complete: true,
			work: [p, command()],
		});
		const target = fixture({}, collisionApi.createPendingRecoveryCoordinator);
		await target.api.start();
		expect((await target.api.importArtifact(artifact)).entries.map((e) => e.prepared.work)).toEqual([p, command()]);
	});
});

describe("producer provenance and non-destructive compatibility", () => {
	it("private producer fields survive the real #578 serialization, not just coordinator memory", async () => {
		const f = await ready();
		await saved(f);
		await saved(f, command());
		const stored = await createPendingSendStorage({
			ownerId: "owner-a",
			backend: f.backend,
			storage: {
				getItem: () => f.envelopes.getItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`),
				setItem: () => {
					throw Error("read only");
				},
			},
		}).restore();
		expect(stored.complete).toBe(true);
		for (const p of stored.pending)
			expect((p as unknown as Record<string, unknown>)[provenance]).toEqual({
				format: "pi-web-pending-work",
				version: 2,
				kind: "carrier",
			});
	});
	for (const { kind, attachmentMode } of ["carrier", "literal"].flatMap((kind) =>
		["absent", "empty", "nonempty"].map((attachmentMode) => ({ kind, attachmentMode })),
	)) {
		for (const operation of ["prepare", "import"]) {
			it(`retains ${kind} ${attachmentMode} attachments after envelope-only ${operation}, reload and import`, async () => {
				const f = fixture();
				const pending = {
					...legacyCases().find(([name]) => name.startsWith("exact"))![1],
					originalMetadata: { unknown: [false, 0, "原始"] },
				};
				if (attachmentMode === "absent") delete pending.attachments;
				if (attachmentMode === "empty") pending.attachments = [];
				const expected: RecoveryWork = kind === "literal" ? { kind: "prompt", pending } : command();
				if (expected.kind === "command" && pending.attachments !== undefined)
					expected.attachments = clone(pending.attachments);
				if (kind === "literal") f.tabStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([pending]));
				expect((await f.api.start()).state).toBe("ready");
				if (kind === "carrier") await saved(f, expected);
				await f.api.close();
				f.backend.records.clear();
				const next = createPendingRecoveryCoordinator(f.options);
				expect(await next.start()).toMatchObject({ state: "ready", entries: [{ prepared: { work: expected } }] });
				expect(await readPendingRecoveryArtifact(await next.exportArtifact())).toMatchObject({
					complete: true,
					work: [expected],
				});
				const original = JSON.parse(f.envelopes.getItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`)!)[0];
				const additional = prompt("additional");
				additional.pending.createdAt = 44;
				if (operation === "prepare") expect((await next.prepare(additional)).ok).toBe(true);
				else {
					const imported = await ready();
					await saved(imported, additional);
					await next.importArtifact(await imported.api.exportArtifact());
				}
				expect(pendingRecords(f.backend).find((r) => r.key[3] === original.id)?.payload).toBe(JSON.stringify(original));
				expect((await next.restore()).entries.map((e) => e.prepared.work)).toEqual([expected, additional]);
				await next.close();
				const reloaded = createPendingRecoveryCoordinator(f.options);
				expect((await reloaded.start()).entries.map((e) => e.prepared.work)).toEqual([expected, additional]);
				const artifact = await reloaded.exportArtifact();
				expect(await readPendingRecoveryArtifact(artifact)).toMatchObject({
					complete: true,
					work: [expected, additional],
				});
				const target = await ready();
				expect((await target.api.importArtifact(artifact)).entries.map((e) => e.prepared.work)).toEqual([
					expected,
					additional,
				]);
				expect(pendingRecords(target.backend)).toHaveLength(2);
			});
		}
	}
	for (const operation of ["prepare", "import"]) {
		it(`stored-key/provenance collision refuses ${operation} without replacing literal work`, async () => {
			const f = fixture();
			const pending = legacyCases().find(([name]) => name.startsWith("exact"))![1];
			const expected: RecoveryWork = { kind: "prompt", pending };
			const nested = JSON.parse(pending.text).work as RecoveryWork;
			f.tabStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([pending]));
			const initial = await f.api.start();
			expect(initial.entries.map((e) => e.prepared.work)).toEqual([expected]);
			const incoming = await ready();
			await saved(incoming, nested);
			expect(pendingRecords(f.backend)[0].contentDigest).toBe(pendingRecords(incoming.backend)[0].contentDigest);
			const before = await f.api.exportArtifact();
			const writes = f.backend.writes;
			if (operation === "prepare")
				expect(await f.api.prepare(nested)).toMatchObject({
					ok: false,
					payloadCommitted: false,
					error: { code: "conflict" },
				});
			else
				await expect(f.api.importArtifact(await incoming.api.exportArtifact())).rejects.toMatchObject({
					code: "conflict",
				});
			expect(f.backend.writes).toBe(writes);
			expect(await f.api.returnToComposer(initial.entries[0].prepared)).toEqual(expected);
			expect((await f.api.restore()).entries.map((e) => e.prepared.work)).toEqual([expected]);
			expect(await f.api.exportArtifact()).toBe(before);
			expect((await readPendingRecoveryArtifact(before)).work).toEqual([expected]);
			await f.api.close();
			expect((await createPendingRecoveryCoordinator(f.options).start()).entries.map((e) => e.prepared.work)).toEqual([
				expected,
			]);
		});
	}
	it("a native row rejected for foreign key-owner cannot substitute readable envelope text", async () => {
		const f = fixture();
		const pending = { ...prompt("unambiguous-literal").pending, status: "failed" as const };
		const bad = { ...pending, text: "rejected native bytes must never replace the original" };
		const payload = JSON.stringify(bad);
		const record: RecoveryRecord = {
			key: ["foreign-owner", "session", pending.sessionId!, pending.id],
			ownerId: "owner-a",
			state: "pending",
			payload,
			digest: createHash("sha256").update(payload).digest("hex"),
			contentDigest: createHash("sha256")
				.update(JSON.stringify([bad.id, bad.sessionId, bad.text, bad.attachments, bad.queue, bad.createdAt]))
				.digest("hex"),
		};
		f.backend.records.set(JSON.stringify(record.key), record);
		const raw = JSON.stringify([pending]);
		f.envelopes.setItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`, raw);
		const initial = await f.api.start();
		expect(initial).toMatchObject({ state: "incomplete", issues: [{ code: "identity" }] });
		expect(initial.entries.map((e) => e.prepared.work)).toEqual([{ kind: "prompt", pending }]);
		expect(await f.api.returnToComposer(initial.entries[0].prepared)).toEqual({ kind: "prompt", pending });
		expect(await f.api.prepare(command())).toMatchObject({ ok: false });
		await expect(readPendingRecoveryArtifact(await f.api.exportArtifact())).rejects.toMatchObject({ code: "identity" });
		expect(f.envelopes.getItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`)).toBe(raw);
		expect(await f.backend.read("owner-a")).toEqual([record]);
		expect(f.backend.writes).toBe(0);
	});
	it("literal sending metadata stays exact without manufacturing a UI retry-check hint", async () => {
		const f = fixture();
		const pending = prompt().pending;
		pending.text = '{"format":"pi-web-pending-work-v1"}';
		const source = JSON.stringify([pending]);
		f.tabStorage.setItem(PENDING_STORAGE_KEY, source);
		expect(await f.api.start()).toMatchObject({
			state: "ready",
			entries: [{ prepared: { work: { kind: "prompt", pending } } }],
		});
		expect((await readPendingRecoveryArtifact(await f.api.exportArtifact())).work).toEqual([
			{ kind: "prompt", pending },
		]);
		expect(f.tabStorage.getItem(PENDING_STORAGE_KEY)).toBe(source);
	});
	it("an interrupted legacy setup with the exact copied envelope still imports opaque user text", async () => {
		const f = fixture();
		const pending = legacyCases().find(([name]) => name.startsWith("exact"))![1];
		const raw = JSON.stringify([pending]);
		f.tabStorage.setItem(PENDING_STORAGE_KEY, raw);
		f.tabStorage.setItem(PENDING_OWNER_KEY, "owner-a");
		f.envelopes.setItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`, raw);
		expect(await f.api.start()).toMatchObject({
			state: "ready",
			entries: [{ prepared: { work: { kind: "prompt", pending } } }],
		});
		expect(f.tabStorage.getItem(PENDING_STORAGE_KEY)).toBe(raw);
	});
	for (const mode of [
		"marker-only body",
		"malformed nested work",
		"unknown body format",
		"unknown producer version",
		"unknown producer kind",
		"null producer",
		"outer metadata mismatch",
		"attachment mismatch",
		"removed native producer",
	]) {
		it(`rejects known internal ${mode} without plain-prompt demotion, writes or release`, async () => {
			const source = await ready();
			const work = command();
			work.attachments = clone(prompt().pending.attachments);
			await saved(source, work);
			const artifact = JSON.parse(await source.api.exportArtifact());
			const record = artifact.records[0];
			const p = JSON.parse(record.payload);
			if (mode === "marker-only body") p.text = '{"format":"pi-web-pending-work-v1"}';
			if (mode === "malformed nested work") p.text = '{"format":"pi-web-pending-work-v1","work":{"kind":"unknown"}}';
			if (mode === "unknown body format") p.text = '{"format":"pi-web-pending-work-v99","work":null}';
			if (mode === "unknown producer version") p[provenance].version = 99;
			if (mode === "unknown producer kind") p[provenance].kind = "unknown";
			if (mode === "null producer") p[provenance] = null;
			if (mode === "outer metadata mismatch") p.createdAt++;
			if (mode === "attachment mismatch") p.attachments[0].imageData = "AA==";
			if (mode === "removed native producer") delete p[provenance];
			record.payload = JSON.stringify(p);
			record.digest = createHash("sha256").update(record.payload).digest("hex");
			record.contentDigest = createHash("sha256")
				.update(JSON.stringify([p.id, p.sessionId || p.conversationId, p.text, p.attachments, p.queue, p.createdAt]))
				.digest("hex");
			if (mode !== "removed native producer") artifact.envelope = JSON.stringify([p]);
			const text = resign(artifact);
			const read = await readPendingRecoveryArtifact(text);
			expect(read.complete).toBe(false);
			expect(read.work).toEqual([]);
			expect(read.issues.some((i) => i.code === "corrupt")).toBe(true);
			const target = await ready();
			await expect(target.api.importArtifact(text)).rejects.toMatchObject({ code: "incomplete" });
			expect(target.backend.writes).toBe(0);
			const damaged = fixture();
			damaged.backend.records.set(JSON.stringify(record.key), clone(record));
			damaged.envelopes.setItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`, artifact.envelope);
			const original = clone([...damaged.backend.records]);
			expect(await damaged.api.start()).toMatchObject({ state: "incomplete", entries: [] });
			expect(await damaged.api.prepare(prompt())).toMatchObject({ ok: false });
			expect(
				await damaged.api.discard({
					intent: "discard",
					identity: {
						ownerId: "owner-a",
						kind: "command",
						id: work.id,
						sessionId: work.sessionId,
						contentDigest: "0".repeat(64),
					},
				}),
			).toMatchObject({ released: false });
			expect(damaged.backend.writes).toBe(0);
			expect([...damaged.backend.records]).toEqual(original);
			expect(JSON.parse(await damaged.api.exportArtifact()).records).toEqual(artifact.records);
		});
	}
	for (const classification of ["literal", "carrier"] as const) {
		it(`explicitly classified ${classification} COPY recovers without converting or deleting ambiguous originals`, async () => {
			const producer = await ready();
			await saved(producer, command());
			const artifact = JSON.parse(await producer.api.exportArtifact());
			const record = artifact.records[0];
			const p =
				classification === "literal"
					? clone(legacyCases().find(([name]) => name.startsWith("exact"))![1])
					: JSON.parse(record.payload);
			delete p[provenance];
			record.key = ["owner-a", "session", p.sessionId, p.id];
			record.payload = JSON.stringify(p);
			record.digest = createHash("sha256").update(record.payload).digest("hex");
			record.contentDigest = createHash("sha256")
				.update(JSON.stringify([p.id, p.sessionId || p.conversationId, p.text, p.attachments, p.queue, p.createdAt]))
				.digest("hex");
			artifact.envelope = JSON.stringify([p]);
			const original = resign(artifact);
			const source = fixture();
			source.backend.records.set(JSON.stringify(record.key), clone(record));
			source.envelopes.setItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`, artifact.envelope);
			expect(await source.api.start()).toMatchObject({ state: "incomplete", issues: [{ code: "compatibility" }] });
			expect((await readPendingRecoveryArtifact(original)).complete).toBe(false);
			// This is an explicit classification of a separate artifact, not production inference.
			p[provenance] = { format: "pi-web-pending-work", version: 2, kind: classification };
			record.payload = JSON.stringify(p);
			record.digest = createHash("sha256").update(record.payload).digest("hex");
			artifact.envelope = JSON.stringify([p]);
			const copy = resign(artifact);
			const pending = clone(p);
			delete pending[provenance];
			const expected: RecoveryWork = classification === "literal" ? { kind: "prompt", pending } : command();
			expect(await readPendingRecoveryArtifact(copy)).toMatchObject({ complete: true, work: [expected] });
			const target = await ready();
			expect((await target.api.importArtifact(copy)).entries.map((e) => e.prepared.work)).toEqual([expected]);
			expect(await source.api.exportArtifact()).toBe(original);
			expect(source.backend.writes).toBe(0);
		});
	}
	for (const body of ["unchanged", "damaged JSON {", '{"format":"pi-web-pending-work-v99"}', "ordinary text"]) {
		it(`untagged old carrier-shaped sources stay ambiguous/raw regardless text: ${body}`, async () => {
			const f = await ready();
			await saved(f, command());
			const artifact = JSON.parse(await f.api.exportArtifact());
			const record = artifact.records[0];
			const old = JSON.parse(record.payload);
			delete old[provenance];
			if (body !== "unchanged") old.text = body;
			record.contentDigest = createHash("sha256")
				.update(
					JSON.stringify([
						old.id,
						old.sessionId || old.conversationId,
						old.text,
						old.attachments,
						old.queue,
						old.createdAt,
					]),
				)
				.digest("hex");
			record.payload = JSON.stringify(old);
			record.digest = createHash("sha256").update(record.payload).digest("hex");
			// Private provenance stays outside #578 body identity; existing store contract is unchanged.
			artifact.envelope = JSON.stringify([old]);
			const text = resign(artifact);
			expect(await readPendingRecoveryArtifact(text)).toMatchObject({
				complete: false,
				work: [],
				issues: [{ code: "compatibility" }],
			});
			const target = await ready();
			await expect(target.api.importArtifact(text)).rejects.toMatchObject({ code: "incomplete" });
			expect(target.backend.writes).toBe(0);
			const source = fixture();
			source.backend.records.set(JSON.stringify(record.key), clone(record));
			source.envelopes.setItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`, artifact.envelope);
			expect(await source.api.start()).toMatchObject({
				state: "incomplete",
				entries: [],
				issues: [{ code: "compatibility" }],
			});
			expect(JSON.parse(await source.api.exportArtifact()).records).toEqual(artifact.records);
			expect(source.backend.writes).toBe(0);
		});
	}
});

describe("preparation, ordering and immutable full work", () => {
	it("refuses before startup and does not write or authorize caller send/clear", async () => {
		const f = fixture();
		expect(await f.api.prepare(prompt())).toMatchObject({ ok: false, payloadCommitted: false });
		expect(f.backend.writes).toBe(0);
		expect(f.tabStorage.length).toBe(0);
	});
	it("captures prompt, bytes, original session and opaque command before any await, waits for commit", async () => {
		const f = await ready();
		let enter!: () => void;
		const entered = new Promise<void>((r) => {
			enter = r;
		});
		let finish!: () => void;
		const wait = new Promise<void>((r) => {
			finish = r;
		});
		f.backend.beforeCommit = async () => {
			enter();
			await wait;
		};
		const work = prompt();
		const original = clone(work);
		const preparing = f.api.prepare(work);
		work.pending.text = "new composer";
		work.pending.sessionId = "new-session";
		work.pending.attachments![0].imageData = "changed";
		const opaque = command();
		const opaqueOriginal = clone(opaque);
		const next = f.api.prepare(opaque);
		opaque.payload = "changed";
		let send = 0;
		let clear = 0;
		void preparing.then((r) => {
			if (r.ok && r.dispatch === "first-send") {
				send++;
				clear++;
			}
		});
		await entered;
		expect(send).toBe(0);
		expect(clear).toBe(0);
		expect(pendingRecords(f.backend)).toHaveLength(0);
		f.backend.beforeCommit = undefined;
		finish();
		const result = await preparing;
		expect(result).toMatchObject({
			ok: true,
			dispatch: "first-send",
			prepared: { work: original, sessionId: "session-一" },
		});
		expect(await next).toMatchObject({ ok: true, prepared: { work: opaqueOriginal } });
		if (!result.ok) throw Error("fixture");
		expect(Object.isFrozen(result.prepared.work)).toBe(true);
		expect(Object.isFrozen(result.prepared.work.kind === "prompt" && result.prepared.work.pending.attachments)).toBe(
			true,
		);
		expect(send).toBe(1);
		expect(clear).toBe(1);
		await f.api.close();
		const reloaded = createPendingRecoveryCoordinator(f.options);
		const snapshot = await reloaded.start();
		expect(snapshot.entries.map((e) => e.prepared.work)).toEqual([original, opaqueOriginal]);
		expect(snapshot.entries.every((e) => e.lifecycle === "unresolved")).toBe(true);
		expect(await reloaded.prepare(original)).toMatchObject({ ok: true, dispatch: "status-required" });
		await reloaded.close();
	});
	for (const cause of [
		new DOMException("Synthetic quota", "QuotaExceededError"),
		new DOMException("Synthetic abort", "AbortError"),
		new DOMException("Synthetic denied", "SecurityError"),
	]) {
		it(`fails closed with full draft on payload ${cause.name}`, async () => {
			const f = await ready();
			await saved(f, prompt("old"));
			const work = command();
			const original = clone(work);
			f.backend.writeFailure = cause;
			const result = await f.api.prepare(work);
			expect(result).toMatchObject({ ok: false, payloadCommitted: false, work: original });
			expect(pendingRecords(f.backend)).toHaveLength(1);
			expect(work).toEqual(original);
		});
	}
	it("reports committed payload followed by envelope failure as failure; restore/retry never silently dispatches", async () => {
		const f = await ready();
		const set = f.envelopes.setItem.bind(f.envelopes);
		f.envelopes.setItem = () => {
			throw new DOMException("Synthetic quota", "QuotaExceededError");
		};
		expect(await f.api.prepare(command())).toMatchObject({
			ok: false,
			payloadCommitted: true,
			error: { code: "envelope" },
			work: command(),
		});
		expect(f.api.snapshot().state).toBe("incomplete");
		expect(pendingRecords(f.backend)).toHaveLength(1);
		expect(await f.api.prepare(prompt("new"))).toMatchObject({ ok: false, payloadCommitted: false });
		f.envelopes.setItem = set;
		expect((await f.api.restore()).entries[0].prepared.work).toEqual(command());
		expect(await f.api.prepare(command())).toMatchObject({ ok: true, dispatch: "status-required" });
	});
	it("rejects changed content with the same identity; accepts the same original ID in a different session", async () => {
		const f = await ready();
		await saved(f);
		const changed = prompt();
		changed.pending.queue = false;
		expect(await f.api.prepare(changed)).toMatchObject({ ok: false, error: { code: "conflict" } });
		const other = prompt();
		other.pending.sessionId = "session-other";
		expect((await f.api.prepare(other)).ok).toBe(true);
		expect(pendingRecords(f.backend)).toHaveLength(2);
	});
	it("refuses non-JSON/incomplete data instead of silently losing content", async () => {
		const f = await ready();
		for (const work of [
			{ ...command(), sessionId: "" },
			{ ...command(), payload: undefined },
			{ kind: "prompt", pending: { ...prompt().pending, text: false } },
			{ ...command(), hidden: new Uint8Array([1]) },
		]) {
			expect(await f.api.prepare(work as unknown as RecoveryWork)).toMatchObject({
				ok: false,
				payloadCommitted: false,
			});
		}
		expect(pendingRecords(f.backend)).toHaveLength(0);
	});
});

describe("startup sources and exclusive reachable ownership", () => {
	it("reload reuses token; cloned active owner refuses even a different work ID; closed owner is discoverable and explicitly recoverable", async () => {
		const f = await ready();
		await saved(f, command());
		expect(f.tabStorage.getItem(PENDING_OWNER_KEY)).toBe("owner-a");
		expect(await catalogPendingRecovery(f.options)).toMatchObject({
			complete: true,
			owners: [{ ownerId: "owner-a", active: true }],
		});
		const cloneTab = new MemoryStorage();
		cloneTab.values = new Map(f.tabStorage.values);
		const cloneApi = createPendingRecoveryCoordinator({ ...f.options, tabStorage: cloneTab });
		expect((await cloneApi.start()).state).toBe("conflict");
		await f.api.close();
		expect(await catalogPendingRecovery(f.options)).toMatchObject({ owners: [{ ownerId: "owner-a", active: false }] });
		const orphan = createPendingRecoveryCoordinator({ ...f.options, tabStorage: new MemoryStorage() });
		expect(await orphan.start({ recoverOwnerId: "owner-a" })).toMatchObject({
			state: "ready",
			ownerId: "owner-a",
			entries: [{ prepared: { work: command() } }],
		});
		await orphan.close();
	});
	it("imports complete legacy work before publication; unchanged legacy source is recognized safely on subsequent reload", async () => {
		const f = fixture();
		const p = prompt().pending;
		f.tabStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([p]));
		expect((await f.api.start()).state).toBe("ready");
		expect(pendingRecords(f.backend)).toHaveLength(1);
		await saved(f, command());
		await f.api.close();
		const next = createPendingRecoveryCoordinator(f.options);
		expect((await next.start()).state).toBe("ready");
		expect(next.snapshot().entries).toHaveLength(2);
		expect(f.tabStorage.getItem(PENDING_STORAGE_KEY)).toBe(JSON.stringify([p]));
		await next.close();
	});
	it("incomplete/corrupt startup is read-only, retains unseen manifest and never repairs it from an incoming draft", async () => {
		const f = await ready();
		await saved(f);
		await f.api.close();
		const key = `${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`;
		const raw = '{"unreadable":true}';
		f.envelopes.setItem(key, raw);
		const next = createPendingRecoveryCoordinator(f.options);
		expect((await next.start()).state).toBe("incomplete");
		const writes = f.backend.writes;
		expect(await next.prepare(prompt())).toMatchObject({ ok: false, error: { code: "incomplete" } });
		expect(f.backend.writes).toBe(writes);
		expect(f.envelopes.getItem(key)).toBe(raw);
		const exported = await next.exportArtifact();
		expect((await readPendingRecoveryArtifact(exported)).complete).toBe(false);
		await next.close();
	});
	it("refuses ambiguous legacy and persistent sources, exports both raw, or rejects a nonempty orphan tab", async () => {
		const f = await ready();
		const original = await saved(f);
		await f.api.close();
		f.tabStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify([prompt("unseen").pending]));
		const next = createPendingRecoveryCoordinator(f.options);
		expect((await next.start()).state).toBe("conflict");
		const raw = JSON.parse(await next.exportArtifact());
		expect(raw.legacyEnvelope).toBe(f.tabStorage.getItem(PENDING_STORAGE_KEY));
		expect(raw.envelope).toBe(f.envelopes.getItem(`${PENDING_OWNER_ENVELOPE_PREFIX}owner-a`));
		expect(raw.records).toEqual(await f.backend.read("owner-a"));
		expect(await readPendingRecoveryArtifact(JSON.stringify(raw))).toMatchObject({
			complete: false,
			issues: [{ code: "conflict" }],
		});
		expect(await next.prepare(command())).toMatchObject({ ok: false });
		expect(await next.discard({ intent: "discard", identity: original })).toMatchObject({ released: false });
		await next.close();
		const own = new MemoryStorage();
		own.setItem(PENDING_OWNER_KEY, "another-owner");
		const other = createPendingRecoveryCoordinator({ ...f.options, tabStorage: own });
		expect((await other.start({ recoverOwnerId: "owner-a" })).state).toBe("conflict");
		const unowned = new MemoryStorage();
		const unseen = JSON.stringify([prompt("unseen-unowned").pending]);
		unowned.setItem(PENDING_STORAGE_KEY, unseen);
		const recovery = createPendingRecoveryCoordinator({ ...f.options, tabStorage: unowned });
		expect((await recovery.start({ recoverOwnerId: "owner-a" })).state).toBe("conflict");
		expect(unowned.getItem(PENDING_OWNER_KEY)).toBeNull();
		expect(unowned.getItem(PENDING_STORAGE_KEY)).toBe(unseen);
		expect(pendingRecords(f.backend)).toHaveLength(1);
	});
	it("ordinary reload remains readable/exportable under ongoing write-only storage failure", async () => {
		const f = await ready();
		await saved(f, command());
		await f.api.close();
		const writes = f.backend.writes;
		const denied = () => {
			throw new DOMException("Ongoing write-only quota", "QuotaExceededError");
		};
		f.envelopes.setItem = denied;
		f.tabStorage.setItem = denied;
		const next = createPendingRecoveryCoordinator(f.options);
		expect(await next.start()).toMatchObject({ state: "ready", entries: [{ prepared: { work: command() } }] });
		expect(f.backend.writes).toBe(writes);
		expect((await readPendingRecoveryArtifact(await next.exportArtifact())).work).toEqual([command()]);
		await next.close();
	});
	for (const mode of ["tab-get", "tab-set", "envelope-get", "no-owner-lock", "backend-read", "lock-denied"] as const) {
		it(`never enables mutation after setup ${mode} failure`, async () => {
			const f = fixture();
			const denied = () => {
				throw new DOMException("Synthetic denial", "SecurityError");
			};
			if (mode === "tab-get") f.tabStorage.getItem = denied;
			if (mode === "tab-set") f.tabStorage.setItem = denied;
			if (mode === "envelope-get") f.envelopes.getItem = denied;
			if (mode === "no-owner-lock")
				f.ownership.acquire = async () => {
					throw Error("Web Locks unavailable");
				};
			if (mode === "backend-read") f.backend.readFailure = Error("Read denied");
			if (mode === "lock-denied") f.ownership.held.add("owner-a");
			expect((await f.api.start()).state).not.toBe("ready");
			expect((await f.api.prepare(command())).ok).toBe(false);
			expect(f.backend.writes).toBe(0);
		});
	}
});

describe("lifecycle and exact persisted authority", () => {
	it("volatile/text/negative/unknown and missing verifier never release; return-to-composer retains work", async () => {
		const f = await ready();
		const item = await saved(f);
		for (const kind of ["volatile", "text-match", "negative", "unknown"] as const)
			expect(await f.api.observe({ kind })).toEqual({ released: false });
		expect(await f.api.observe({ kind: "persisted", identity: item, proof: { ok: true } })).toEqual({
			released: false,
		});
		expect(await f.api.returnToComposer(item)).toEqual(prompt());
		expect(f.api.snapshot().entries[0].lifecycle).toBe("returned");
		expect(await f.api.prepare(prompt())).toMatchObject({ ok: true, dispatch: "status-required" });
		expect(pendingRecords(f.backend)).toHaveLength(1);
	});
	it("only matching owner/session/ID/digest plus positive persistence verifier releases", async () => {
		const f = await ready({ verifyPersisted: async (proof) => (proof as { durable: boolean }).durable === true });
		const item = await saved(f, command());
		for (const wrong of [
			{ ...item, ownerId: "other" },
			{ ...item, sessionId: "other" },
			{ ...item, id: "other" },
			{ ...item, kind: "prompt" as const },
			{ ...item, contentDigest: "0".repeat(64) },
		]) {
			expect(await f.api.observe({ kind: "persisted", identity: wrong, proof: { durable: true } })).toMatchObject({
				released: false,
				error: { code: "identity" },
			});
		}
		expect(await f.api.observe({ kind: "persisted", identity: item, proof: { durable: false } })).toEqual({
			released: false,
		});
		expect(await f.api.observe({ kind: "persisted", identity: item, proof: { durable: true } })).toEqual({
			released: true,
		});
		expect(pendingRecords(f.backend)).toHaveLength(0);
		expect((await f.api.prepare(command())).ok).toBe(false);
	});
	it("explicit discard must match; release transaction failure retains complete work", async () => {
		const f = await ready();
		const item = await saved(f);
		expect(await f.api.discard({ intent: "return" as "discard", identity: item })).toMatchObject({ released: false });
		f.backend.releaseFailure = Error("Synthetic abort");
		expect(await f.api.discard({ intent: "discard", identity: item })).toMatchObject({ released: false });
		expect(pendingRecords(f.backend)).toHaveLength(1);
		f.backend.releaseFailure = undefined;
		expect(await f.api.discard({ intent: "discard", identity: item })).toEqual({ released: true });
		await f.api.close();
		const next = createPendingRecoveryCoordinator(f.options);
		expect((await next.start()).entries).toEqual([]);
		await next.close();
	});
	it("close waits for a running commit, never deletes data and refuses later mutation", async () => {
		const f = await ready();
		let entered!: () => void;
		const began = new Promise<void>((r) => {
			entered = r;
		});
		let finish!: () => void;
		f.backend.beforeCommit = () => {
			entered();
			return new Promise<void>((r) => {
				finish = r;
			});
		};
		const saving = f.api.prepare(command());
		await began;
		const closing = f.api.close();
		expect(f.ownership.held.has("owner-a")).toBe(true);
		finish();
		await saving;
		await closing;
		expect(pendingRecords(f.backend)).toHaveLength(1);
		expect((await f.api.prepare(prompt())).ok).toBe(false);
	});
});

describe("independent recovery artifact and rollback reader", () => {
	it("exports exact original prompt and opaque command; independently reads and restores in an empty backend", async () => {
		const f = await ready();
		await saved(f);
		await saved(f, command());
		const artifact = await f.api.exportArtifact();
		const read = await readPendingRecoveryArtifact(artifact);
		expect(read.complete).toBe(true);
		expect(read.work).toEqual([prompt(), command()]);
		await f.api.close();
		const fresh = await ready();
		expect((await fresh.api.importArtifact(artifact)).entries.map((e) => e.prepared.work)).toEqual([
			prompt(),
			command(),
		]);
		expect(await fresh.api.prepare(command())).toMatchObject({ ok: true, dispatch: "status-required" });
		const html = createPendingRecoveryReaderHtml("export const fixture = 1; // </script>");
		expect(html).toContain("Blob");
		expect(html).toContain("readPendingRecoveryArtifact");
		expect(html).toContain("\\u003c/script>");
	});
	it("refuses checksum, payload-digest, owner and session corruption before writing any target", async () => {
		const f = await ready();
		await saved(f);
		const artifact = await f.api.exportArtifact();
		const parsed = JSON.parse(artifact);
		const badChecksum = JSON.stringify({ ...parsed, checksum: "0".repeat(64) });
		const foreign = clone(parsed);
		foreign.records[0].ownerId = "other";
		const changed = clone(parsed);
		changed.records[0].payload += " ";
		const session = clone(parsed);
		session.records[0].key[2] = "other-session";
		const target = await ready();
		const before = target.backend.writes;
		for (const invalid of [badChecksum, resign(foreign), resign(changed), resign(session)])
			await expect(target.api.importArtifact(invalid)).rejects.toBeDefined();
		expect(target.backend.writes).toBe(before);
		expect(pendingRecords(target.backend)).toHaveLength(0);
	});
	it("refuses foreign owners, conflicting originals and resurrection of already released local work", async () => {
		const f = await ready();
		const item = await saved(f);
		const artifact = await f.api.exportArtifact();
		const other = await ready({ newOwnerId: () => "owner-b" });
		await expect(other.api.importArtifact(artifact)).rejects.toMatchObject({ code: "identity" });
		const conflict = await ready();
		const changed = prompt();
		changed.pending.text = "different";
		await saved(conflict, changed);
		await expect(conflict.api.importArtifact(artifact)).rejects.toMatchObject({ code: "conflict" });
		await f.api.discard({ intent: "discard", identity: item });
		await expect(f.api.importArtifact(artifact)).rejects.toMatchObject({ code: "released" });
		expect(pendingRecords(f.backend)).toHaveLength(0);
	});
	it("artifact release markers cannot delete an unresolved local copy", async () => {
		const f = await ready();
		const item = await saved(f);
		const pendingArtifact = await f.api.exportArtifact();
		await f.api.discard({ intent: "discard", identity: item });
		const releasedArtifact = await f.api.exportArtifact();
		const target = await ready();
		await target.api.importArtifact(pendingArtifact);
		await expect(target.api.importArtifact(releasedArtifact)).rejects.toMatchObject({ code: "conflict" });
		expect(pendingRecords(target.backend)).toHaveLength(1);
	});
	it("unresolved external references remain exportable but never import as complete bytes", async () => {
		const f = await ready({ verifyReference: async (a) => a.uploadPath === "/fixture.bin" });
		const work = prompt();
		work.pending.attachments = [{ path: "", uploadPath: "/fixture.bin", name: "durable.bin", size: 5 }];
		await saved(f, work);
		const artifact = await f.api.exportArtifact();
		expect(await readPendingRecoveryArtifact(artifact)).toMatchObject({
			complete: false,
			work: [work],
			issues: [{ code: "reference" }],
		});
		let inspected = false;
		expect(
			(
				await readPendingRecoveryArtifact(artifact, async (a, p) => {
					inspected = true;
					expect(Object.isFrozen(a)).toBe(true);
					expect(Object.isFrozen(p)).toBe(true);
					expect(Object.isFrozen(p.attachments)).toBe(true);
					return true;
				})
			).complete,
		).toBe(true);
		expect(inspected).toBe(true);
		const target = await ready();
		await expect(target.api.importArtifact(artifact)).rejects.toMatchObject({ code: "incomplete" });
		expect(pendingRecords(target.backend)).toHaveLength(0);
	});
	it("surfaces each blocked reference without hiding unrelated complete retained work", async () => {
		const f = await ready({ verifyReference: async () => true });
		const work = prompt();
		work.pending.attachments = [{ path: "", uploadPath: "/gone.bin", size: 5 }];
		await saved(f, work);
		await saved(f, command());
		await f.api.close();
		const next = createPendingRecoveryCoordinator({ ...f.options, verifyReference: undefined });
		const restored = await next.start();
		expect(restored.state).toBe("incomplete");
		expect(restored.entries).toHaveLength(2);
		const blocked = restored.entries.find((e) => e.prepared.kind === "prompt")!;
		const complete = restored.entries.find((e) => e.prepared.kind === "command")!;
		expect(blocked).toMatchObject({ complete: false, issues: [{ code: "reference" }], prepared: { work } });
		expect(complete).toMatchObject({ complete: true, issues: [], prepared: { work: command() } });
		expect(await next.returnToComposer(complete.prepared)).toEqual(command());
		expect(await next.prepare(command("another"))).toMatchObject({ ok: false, error: { code: "incomplete" } });
		expect(pendingRecords(f.backend)).toHaveLength(2);
		expect((await readPendingRecoveryArtifact(await next.exportArtifact())).work).toEqual([command(), work]);
		await next.close();
	});
});
