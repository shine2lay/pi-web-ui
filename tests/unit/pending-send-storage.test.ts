import { describe, expect, it } from "vitest";
import { isDeepStrictEqual } from "node:util";
import {
	createPendingSendStorage,
	PendingSendStorageError,
	type PendingRecoveryBackend,
	type RecoveryRecord,
} from "../../web/src/pending-send-storage";
import {
	MAX_PENDING_STORAGE_CHARS,
	PENDING_STORAGE_KEY,
	idsToCheck,
	onReconnect,
	parsePending,
	retryPending,
	serializePending,
	type PendingSend,
} from "../../web/src/pending-sends";

// Independent fixtures: all complete bytes/metadata are compared, never attachment counts alone.
function pending(overrides: Partial<PendingSend> = {}): PendingSend {
	return {
		id: "prompt-原始-🧪",
		conversationId: "c1",
		sessionId: "session-一",
		text: "\r\n完整 text é 🌈\n",
		queue: true,
		createdAt: 1723456789,
		status: "sending",
		anchorId: "before",
		sameTextBefore: ["older"],
		queueBase: 2,
		whileWorking: true,
		...overrides,
	};
}
function boundary(length: number): PendingSend {
	const p = pending({
		attachments: [{ path: "", imageData: "", name: "边界-🖼️.png", mimeType: "image/png", size: 123 }],
	});
	const remaining = length - JSON.stringify([p]).length;
	p.attachments![0].imageData = "QUJD".repeat(Math.floor(remaining / 4));
	p.text += " ".repeat(remaining % 4);
	return p;
}
const bytes = Buffer.from(Array.from({ length: 1_200_003 }, (_, i) => i % 256)).toString("base64");
const multi = pending({
	text: "", // attachment-only send
	attachments: [
		{ path: "", imageData: bytes, mimeType: "image/png", name: "图-一.png", size: 1_200_003 },
		{
			path: "",
			fileData: Buffer.from(Array.from({ length: 1_200_003 }, (_, i) => 255 - (i % 256))).toString("base64"),
			mimeType: "application/octet-stream",
			name: "nul-\u0000-é.bin",
			size: 1_200_003,
		},
		{ path: "blob:synthetic", imageData: bytes, mimeType: "image/webp", name: "second.webp", size: 1_200_003 },
		{ path: "", fileData: "AP8BAgM=", mimeType: "text/plain;charset=utf-8", name: "零\n行.txt", size: 5 },
	],
});
const restored = (list: readonly PendingSend[]) =>
	list.map((p) => (p.status === "sending" ? { ...p, needsCheck: true } : p));
const key = (record: RecoveryRecord) => JSON.stringify(record.key);

/** Transactional test double only. Native transaction completion/abort is tested in real Chromium. */
class MemoryBackend implements PendingRecoveryBackend {
	records = new Map<string, RecoveryRecord>();
	writeFailure: unknown;
	releaseFailure: unknown;
	readFailure: unknown;
	beforeCommit?: () => Promise<void>;
	async read(ownerId: string) {
		if (this.readFailure) throw this.readFailure;
		return structuredClone([...this.records.values()].filter((r) => r.ownerId === ownerId));
	}
	async write(records: readonly RecoveryRecord[]) {
		const staged = new Map(this.records);
		for (const record of records) {
			const old = staged.get(key(record));
			if (old?.state === "released") throw new PendingSendStorageError("released", "Released send");
			if (old && old.contentDigest !== record.contentDigest)
				throw new PendingSendStorageError("conflict", "Different body");
			staged.set(key(record), structuredClone(record));
		}
		await this.beforeCommit?.();
		if (this.writeFailure) throw this.writeFailure;
		this.records = staged;
	}
	async release(record: RecoveryRecord & { state: "released" }) {
		if (this.releaseFailure) throw this.releaseFailure;
		const old = this.records.get(key(record));
		if (old && old.contentDigest !== record.contentDigest)
			throw new PendingSendStorageError("conflict", "Wrong acknowledgement body");
		this.records.set(key(record), structuredClone(record));
	}
}
function fixture(ownerId = "tab-a", backend = new MemoryBackend()) {
	const values = new Map<string, string>();
	const storage = {
		getItem: (name: string) => values.get(name) ?? null,
		setItem: (name: string, value: string) => {
			values.set(name, value);
		},
	};
	return { values, storage, backend, api: createPendingSendStorage({ ownerId, storage, backend }) };
}

describe("exact-content (baseline counterfactual uses unchanged legacy serializer)", () => {
	for (const [name, p] of [
		["just below existing boundary", boundary(MAX_PENDING_STORAGE_CHARS - 1)],
		["at existing boundary", boundary(MAX_PENDING_STORAGE_CHARS)],
		["just above existing boundary", boundary(MAX_PENDING_STORAGE_CHARS + 1)],
		["multiple large images/files, Unicode and attachment-only", multi],
	] as const) {
		it(name, async () => {
			const expected = restored([p]);
			if (process.env.PENDING_RECOVERY_BASELINE === "1") {
				// Intentional red control: exactly the production baseline save/load transform.
				expect(
					isDeepStrictEqual(parsePending(serializePending([p])), expected),
					"complete byte/metadata equality",
				).toBe(true);
				return;
			}
			const f = fixture();
			await f.api.save([p]);
			const nextPage = createPendingSendStorage({ ownerId: "tab-a", backend: f.backend, storage: f.storage });
			expect(await nextPage.restore()).toEqual({ pending: expected, blocked: [], issues: [], complete: true });
			const raw = f.values.get(PENDING_STORAGE_KEY)!;
			expect(raw.length).toBeLessThanOrEqual(MAX_PENDING_STORAGE_CHARS);
			if (JSON.stringify([p]).length > MAX_PENDING_STORAGE_CHARS) {
				expect(raw).not.toContain(p.attachments![0].imageData);
				expect(JSON.parse(raw).keys[0]).toEqual(["tab-a", "session", p.sessionId, p.id]);
			} else expect(JSON.parse(raw)).toEqual([p]);
		});
	}
});

describe("complete recovery, explicit failures and ownership", () => {
	it("does not publish a reference before atomic commit; snapshots caller bytes before awaiting", async () => {
		const f = fixture();
		let commit!: () => void;
		let started!: () => void;
		const began = new Promise<void>((r) => {
			started = r;
		});
		f.backend.beforeCommit = () => {
			started();
			return new Promise<void>((r) => {
				commit = r;
			});
		};
		const p = structuredClone(multi);
		const saving = f.api.save([p]);
		p.text = "a later composer edit";
		p.attachments![0].imageData = "changed";
		await began;
		expect(f.values.has(PENDING_STORAGE_KEY)).toBe(false);
		expect(f.backend.records.size).toBe(0);
		commit();
		await saving;
		expect((await f.api.restore()).pending).toEqual(restored([multi]));
	});

	for (const cause of [
		new DOMException("Synthetic abort", "AbortError"),
		new DOMException("Synthetic full disk", "QuotaExceededError"),
	]) {
		it(`keeps old records, envelope and complete input on ${cause.name}`, async () => {
			const f = fixture();
			const old = pending({ id: "already-saved" });
			await f.api.save([old]);
			const raw = f.values.get(PENDING_STORAGE_KEY);
			const original = structuredClone(multi);
			f.backend.writeFailure = cause;
			await expect(f.api.save([old, multi])).rejects.toMatchObject({
				name: "PendingSendStorageError",
				payloadCommitted: false,
				cause,
			});
			expect(multi).toEqual(original);
			expect(f.values.get(PENDING_STORAGE_KEY)).toBe(raw);
			f.backend.writeFailure = undefined;
			expect((await f.api.restore()).pending).toEqual(restored([old]));
		});
	}

	it("discovers a committed payload after envelope quota failure/interruption without a published reference", async () => {
		const f = fixture();
		const api = createPendingSendStorage({
			ownerId: "tab-a",
			backend: f.backend,
			storage: {
				getItem: f.storage.getItem,
				setItem: () => {
					throw new DOMException("Synthetic quota", "QuotaExceededError");
				},
			},
		});
		await expect(api.save([multi])).rejects.toMatchObject({ code: "envelope", payloadCommitted: true });
		expect(f.values.size).toBe(0);
		expect((await f.api.restore()).pending).toEqual(restored([multi]));
	});

	it("reports disabled IDB and sessionStorage explicitly, without altering caller work", async () => {
		const f = fixture();
		const disabled = createPendingSendStorage({ ownerId: "tab-a", indexedDB: null, storage: f.storage });
		await expect(disabled.save([multi])).rejects.toMatchObject({ code: "unavailable", payloadCommitted: false });
		expect(await disabled.restore()).toMatchObject({ complete: false, issues: [{ code: "unavailable" }] });
		const noSession = createPendingSendStorage({ ownerId: "tab-a", backend: f.backend, storage: null });
		await expect(noSession.save([multi])).rejects.toMatchObject({ code: "envelope", payloadCommitted: true });
		expect(await noSession.restore()).toMatchObject({
			pending: restored([multi]),
			complete: false,
			issues: [{ code: "envelope" }],
		});
	});

	it("does not consume other tab/session records; the same prompt ID may belong to distinct sessions", async () => {
		const a = fixture();
		const b = fixture("tab-b", a.backend);
		const differentSession = { ...multi, sessionId: "other-session" };
		await a.api.save([multi, differentSession]);
		await b.api.save([{ ...multi, text: "other tab" }]);
		expect((await a.api.restore()).pending).toEqual(restored([multi, differentSession]));
		expect((await b.api.restore()).pending).toEqual(restored([{ ...multi, text: "other tab" }]));
		await b.api.release({ ...multi, text: "other tab" }, "discarded");
		expect((await a.api.restore()).pending).toEqual(restored([multi, differentSession]));
	});

	it("keeps ID, exact body and order through reconnect/retry and renumbered conversations", async () => {
		const f = fixture();
		await f.api.save([multi]);
		const list = (await f.api.restore()).pending;
		expect(idsToCheck(onReconnect(list))).toEqual([multi.id]);
		const retry = retryPending(list, multi.id, null);
		await f.api.save(retry.map((p) => ({ ...p, conversationId: "c99" })));
		expect((await f.api.restore()).pending).toEqual(restored([{ ...retry[0], conversationId: "c99" }]));
		expect((await f.api.restore()).pending[0].attachments).toEqual(multi.attachments);
	});

	it("retains omitted and confirmed entries until explicit committed acknowledgement/discard", async () => {
		const f = fixture();
		await f.api.save([multi, pending({ id: "confirmed", confirmedRev: 20 })]);
		await f.api.save([]);
		expect((await f.api.restore()).pending).toEqual(restored([multi, pending({ id: "confirmed", confirmedRev: 20 })]));
		await f.api.release(multi, "acknowledged");
		await f.api.release(pending({ id: "confirmed", confirmedRev: 20 }), "discarded");
		expect((await f.api.restore()).pending).toEqual([]);
		await expect(f.api.save([multi])).rejects.toMatchObject({ code: "released" });
		expect([...f.backend.records.values()].every((r) => r.state === "released" && !("payload" in r))).toBe(true);
	});

	it("rejects changed body/ack identity and retains full data on cleanup abort", async () => {
		const f = fixture();
		await f.api.save([multi]);
		await expect(f.api.save([{ ...multi, text: "different bytes, same ID" }])).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(f.api.release({ ...multi, queue: false }, "acknowledged")).rejects.toMatchObject({ code: "conflict" });
		f.backend.releaseFailure = new DOMException("Synthetic abort", "AbortError");
		await expect(f.api.release(multi, "acknowledged")).rejects.toMatchObject({ payloadCommitted: false });
		expect((await f.api.restore()).pending).toEqual(restored([multi]));
	});

	it("retains unresolved manifests and corrupt payloads instead of manufacturing empty attachments", async () => {
		const f = fixture();
		await f.api.save([multi]);
		const raw = f.values.get(PENDING_STORAGE_KEY);
		const record = [...f.backend.records.values()][0];
		f.backend.records.clear();
		expect(await f.api.restore()).toMatchObject({
			pending: [],
			complete: false,
			issues: [{ code: "missing", key: record.key }],
		});
		expect(f.values.get(PENDING_STORAGE_KEY)).toBe(raw);
		if (record.state !== "pending") throw new Error("fixture");
		f.backend.records.set(key(record), { ...record, payload: JSON.stringify({ ...multi, attachments: [] }) });
		expect(await f.api.restore()).toMatchObject({ pending: [], complete: false, issues: [{ code: "corrupt" }] });
		expect(f.backend.records.size).toBe(1);
	});

	it("reads legacy small/minimal/failed records without writes and suppresses released legacy copies", async () => {
		const f = fixture();
		const old = [
			{ id: "minimal", conversationId: "c-old", text: "old text" },
			pending({ id: "failed", status: "failed", reason: "offline" }),
		];
		const raw = JSON.stringify(old);
		f.values.set(PENDING_STORAGE_KEY, raw);
		expect((await f.api.restore()).pending).toEqual(parsePending(raw));
		expect(f.values.get(PENDING_STORAGE_KEY)).toBe(raw);
		expect(f.backend.records.size).toBe(0);
		await f.api.release(parsePending(raw)[0], "discarded");
		expect((await f.api.restore()).pending).toEqual([parsePending(raw)[1]]);
	});

	it("imports omitted legacy payloads before replacing their only envelope", async () => {
		const f = fixture();
		const old = pending({ id: "legacy-only", attachments: [{ path: "", fileData: "AP8BAgM=", name: "old.bin" }] });
		f.values.set(PENDING_STORAGE_KEY, serializePending([old]));
		await f.api.save([]);
		expect((await f.api.restore()).pending).toEqual(restored([old]));
		expect(f.backend.records.size).toBe(1);
	});

	it("does not overwrite unresolved source references, but can repair a missing commit from a complete draft", async () => {
		const f = fixture();
		await f.api.save([multi]);
		const raw = f.values.get(PENDING_STORAGE_KEY);
		f.backend.records.clear();
		await expect(f.api.save([])).rejects.toMatchObject({ code: "missing" });
		expect(f.values.get(PENDING_STORAGE_KEY)).toBe(raw);
		await f.api.save([multi]);
		expect((await f.api.restore()).pending).toEqual(restored([multi]));
	});

	it("requires actual external reference resolution, preserving all metadata and blocked source", async () => {
		const f = fixture();
		const attachments = [
			{ path: "/fixture/notes.md", name: "笔记.md", mode: "lines" as const, lines: { start: 2, end: 7 } },
			{
				path: "",
				uploadPath: "/fixture/uploads/a.bin",
				name: "uploaded.bin",
				mimeType: "application/octet-stream",
				size: 3,
			},
		];
		const p = pending({ attachments });
		await expect(f.api.save([p])).rejects.toMatchObject({ code: "reference" });
		const verified = createPendingSendStorage({
			ownerId: "tab-a",
			backend: f.backend,
			storage: f.storage,
			verifyReference: async (a) => attachments.some((known) => JSON.stringify(known) === JSON.stringify(a)),
		});
		await verified.save([p]);
		expect((await verified.restore()).pending).toEqual(restored([p]));
		expect(await f.api.restore()).toMatchObject({
			pending: [],
			blocked: restored([p]),
			complete: false,
			issues: [{ code: "reference" }],
		});
		const blob = pending({ id: "blob-only", attachments: [{ path: "blob:expired", name: "not durable.png" }] });
		await expect(verified.save([blob])).rejects.toMatchObject({ code: "reference" });
	});

	it("reports malformed legacy data/foreign envelopes without erasing anything", async () => {
		const f = fixture();
		for (const raw of [
			"{truncated",
			JSON.stringify([null, { id: "lost" }]),
			JSON.stringify({ format: "pi-web-pending-recovery", version: 1, ownerId: "tab-b", keys: [] }),
		]) {
			f.values.set(PENDING_STORAGE_KEY, raw);
			expect((await f.api.restore()).complete).toBe(false);
			expect(f.values.get(PENDING_STORAGE_KEY)).toBe(raw);
		}
		expect(() => createPendingSendStorage({ ownerId: "" })).toThrow(PendingSendStorageError);
	});
});
