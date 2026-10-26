import { describe, expect, it } from "vitest";
import {
	COMPOSER_CHECKPOINT_PREFIX,
	composerCheckpointKey,
	createComposerCheckpointStore,
	decodeComposerCheckpoint,
	inspectComposerCheckpoints,
	snapshotComposerCheckpoint,
} from "../../web/src/composer-checkpoint";
import type {
	ComposerCheckpoint,
	ComposerCheckpointOptions,
	ComposerCheckpointStorage,
} from "../../web/src/composer-checkpoint";
import {
	exportComposerCheckpointRecovery,
	readComposerCheckpointRecovery,
} from "../../web/src/composer-checkpoint-reader";

class MemoryStorage implements ComposerCheckpointStorage {
	data = new Map<string, string>();
	writes = 0;
	onSet?: (key: string, value: string) => void;
	onGet?: (key: string) => string | null;
	get length() {
		return this.data.size;
	}
	key(index: number) {
		return [...this.data.keys()][index] ?? null;
	}
	getItem(key: string) {
		return this.onGet ? this.onGet(key) : (this.data.get(key) ?? null);
	}
	setItem(key: string, value: string) {
		this.writes++;
		if (this.onSet) this.onSet(key, value);
		else this.data.set(key, value);
	}
}

function fixture(): ComposerCheckpoint {
	const source = {
		text: " \tuser\r\n e\u0301 😀 漢字\u0000\ud800 X \udfff \n",
		attachments: [
			{
				path: "/synthetic/keep",
				name: " original \t",
				mode: "reference" as const,
				isDir: false,
				lines: { start: 2, end: 9 },
				key: "kept",
				size: 0,
			},
		],
	};
	const incoming = {
		text: " \n<script>globalThis.executed = true</script>\r\n",
		attachments: [
			{ path: "", name: "pixel.png", imageData: "AAEC/w==", mimeType: "image/png", key: "image", size: 4 },
			{ path: "", name: "bytes.bin", fileData: "AP8BAg==", mimeType: "application/octet-stream", size: 4, key: "file" },
			{
				path: "https://reference-only.invalid/path?x=1#opaque",
				name: "<img onerror=evil()>",
				mode: "page" as const,
				isDir: false,
				key: "page",
			},
			{
				path: "",
				name: "conversation",
				mode: "conversation" as const,
				conversationId: "synthetic-other",
				sessionPath: "/never/read/session.jsonl",
				key: "conversation",
			},
			{
				path: "/never/read/directory",
				name: "directory",
				mode: "inline" as const,
				isDir: true,
				lines: { start: 1, end: 1 },
				conversationId: "opaque-extra",
				sessionPath: "opaque/history",
				mimeType: "text/plain",
				size: 12,
				key: "all-metadata",
			},
		],
	};
	return {
		kind: "pi-web-ui/composer-checkpoint",
		version: 1,
		purpose: "composer-injection",
		recordId: "synthetic-injection-1",
		createdAt: 1780000000000,
		binding: {
			ownerId: "original-owner",
			composerId: "original-composer",
			conversationId: "original-CID",
			sessionId: "original-SID",
			revision: 7,
		},
		nextRevision: 8,
		source,
		incoming,
		effective: { text: source.text + incoming.text, attachments: [...source.attachments, ...incoming.attachments] },
	};
}

function setup(owns: ComposerCheckpointOptions["owns"] = () => true) {
	const storage = new MemoryStorage();
	storage.data.set("another-purpose", "original unrelated bytes");
	const store = createComposerCheckpointStore({ storage, owns, enabled: true });
	return { storage, store };
}

function assertNoDamage(storage: MemoryStorage) {
	expect(storage.data.get("another-purpose")).toBe("original unrelated bytes");
}

describe("composer checkpoint fixed-input codec and ownership", () => {
	it("roundtrips every supported field, exact text and opaque metadata through a fresh reader", () => {
		const { storage, store } = setup();
		const input = fixture();
		const result = store.checkpoint(input);
		expect(result.ok).toBe(true);
		expect("then" in result).toBe(false);
		if (!result.ok) throw new Error(result.detail);
		expect(result.record).toStrictEqual(input);
		expect(result.record).not.toBe(input);
		expect(result.record.source).not.toBe(input.source);
		expect(Object.isFrozen(result.record.incoming.attachments?.[4].lines)).toBe(true);
		const reader = createComposerCheckpointStore({ storage, owns: () => false });
		const recovered = reader.read(input.recordId, input.binding);
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) throw new Error(recovered.code);
		expect(recovered.record).toStrictEqual(input);
		expect(recovered.retired).toBe(false);
		const inspection = readComposerCheckpointRecovery(storage);
		expect(inspection.entries[0].record).toStrictEqual(input);
		const exported = JSON.parse(exportComposerCheckpointRecovery(inspection));
		expect(exported.inspection.entries[0].raw).toBe(JSON.stringify(result.record));
		expect(exported.inspection.entries[0].record).toStrictEqual(input);
		assertNoDamage(storage);
	});

	it("copies before ownership callbacks and never aliases caller input", () => {
		const input = fixture();
		const original = structuredClone(input);
		const { storage, store } = setup(() => {
			input.source.text = "mutated inside ownership callback";
			input.incoming.attachments![0].imageData = "AAAA";
			return true;
		});
		const result = store.checkpoint(input);
		if (!result.ok) throw new Error(result.detail);
		input.effective.attachments[0].lines!.start = 99;
		input.incoming.attachments!.push({ path: "/later", name: "later" });
		expect(result.record).toStrictEqual(original);
		expect(Reflect.set(result.record.source, "text", "cannot mutate")).toBe(false);
		expect(Reflect.set(result.record.source.attachments[0].lines!, "start", 100)).toBe(false);
		expect(decodeComposerCheckpoint(storage.getItem(composerCheckpointKey(result.record))!)).toStrictEqual({
			ok: true,
			record: original,
		});
	});

	it("has no old truncation limit: multiple complete inline attachments over 1,500,000 characters each", () => {
		const { store, storage } = setup();
		const input = fixture();
		const first = Buffer.alloc(1_125_003, 0xa7).toString("base64");
		const second = Buffer.alloc(1_125_006, 0x35).toString("base64");
		expect(first.length).toBeGreaterThan(1_500_000);
		expect(second.length).toBeGreaterThan(1_500_000);
		input.incoming.attachments = [
			{ path: "", name: "a.png", imageData: first },
			{ path: "", name: "b.bin", fileData: second, size: 1_125_006 },
		];
		input.effective.attachments = [...input.source.attachments, ...input.incoming.attachments];
		const result = store.checkpoint(input);
		expect(result.ok).toBe(true);
		const entries = readComposerCheckpointRecovery(storage).entries;
		expect(entries[0].record).toStrictEqual(input);
		expect(
			JSON.parse(exportComposerCheckpointRecovery({ ok: true, entries, errors: [] })).inspection.entries[0].record,
		).toStrictEqual(input);
	});

	it("preserves omitted optionals, empty file bytes, ordinary carrier-looking text and empty source", () => {
		const { store } = setup();
		const input = fixture();
		input.source = { text: "", attachments: [] };
		input.incoming = { attachments: [{ path: "", name: "", fileData: "", size: 0, isDir: false }] };
		input.effective = { text: JSON.stringify(fixture()), attachments: input.incoming.attachments! };
		const result = store.checkpoint(input);
		if (!result.ok) throw new Error(result.detail);
		expect(result.record).toStrictEqual(input);
		expect("text" in result.record.incoming).toBe(false);
		expect("mode" in result.record.incoming.attachments![0]).toBe(false);
	});

	it.each([
		["unknown root", (r: ComposerCheckpoint) => Object.assign(r, { future: "must not strip" })],
		[
			"unknown metadata",
			(r: ComposerCheckpoint) => Object.assign(r.incoming.attachments![0], { blobUrl: "blob:unresolved" }),
		],
		["unknown source", (r: ComposerCheckpoint) => Object.assign(r.source, { extra: "original" })],
		["unknown effective", (r: ComposerCheckpoint) => Object.assign(r.effective, { extra: "original" })],
		["unknown binding", (r: ComposerCheckpoint) => Object.assign(r.binding, { target: "later" })],
		["unknown incoming", (r: ComposerCheckpoint) => Object.assign(r.incoming, { transient: true })],
		["wrong purpose", (r: ComposerCheckpoint) => Object.assign(r, { purpose: "pending-send" })],
		["wrong version", (r: ComposerCheckpoint) => Object.assign(r, { version: 2 })],
		[
			"missing SID",
			(r: ComposerCheckpoint) => {
				r.binding.sessionId = "";
			},
		],
		[
			"fractional revision",
			(r: ComposerCheckpoint) => {
				r.binding.revision = 0.5;
			},
		],
		[
			"unsafe revision",
			(r: ComposerCheckpoint) => {
				r.binding.revision = Number.MAX_SAFE_INTEGER;
				r.nextRevision = Number.MAX_SAFE_INTEGER + 1;
			},
		],
		[
			"wrong next revision",
			(r: ComposerCheckpoint) => {
				r.nextRevision = 9;
			},
		],
		[
			"negative zero",
			(r: ComposerCheckpoint) => {
				r.createdAt = -0;
			},
		],
		[
			"nonfinite size",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments![0].size = Infinity;
			},
		],
		[
			"backward lines",
			(r: ComposerCheckpoint) => {
				r.source.attachments[0].lines = { start: 9, end: 2 };
			},
		],
		[
			"line zero",
			(r: ComposerCheckpoint) => {
				r.source.attachments[0].lines!.start = 0;
			},
		],
		["unknown line field", (r: ComposerCheckpoint) => Object.assign(r.source.attachments[0].lines!, { extra: 1 })],
		[
			"bad inline bytes",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments![0].imageData = "not a complete blob";
			},
		],
		[
			"noncanonical base64",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments![0].imageData = "AB==";
			},
		],
		[
			"empty image",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments![0].imageData = "";
			},
		],
		[
			"placeholder",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments = [{ path: "", name: "still uploading", key: "temporary" }];
			},
		],
		[
			"unresolved conversation",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments = [{ path: "", name: "missing", mode: "conversation" }];
			},
		],
		[
			"unresolved page",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments = [{ path: "", name: "missing", mode: "page", fileData: "" }];
			},
		],
		[
			"missing line range",
			(r: ComposerCheckpoint) => {
				r.incoming.attachments = [{ path: "/opaque", name: "missing", mode: "lines" }];
			},
		],
		[
			"explicit undefined",
			(r: ComposerCheckpoint) => {
				r.incoming.text = undefined;
			},
		],
		[
			"sparse array",
			(r: ComposerCheckpoint) => {
				r.source.attachments = new Array(2);
			},
		],
		["extended array", (r: ComposerCheckpoint) => Object.assign(r.source.attachments, { extra: "must not strip" })],
	])("refuses %s without writing or stripping", (_name, mutate) => {
		const input = fixture();
		mutate(input);
		const { store, storage } = setup();
		expect(store.checkpoint(input)).toMatchObject({ ok: false, code: "invalid-record", payloadCommitted: false });
		expect(storage.writes).toBe(0);
		assertNoDamage(storage);
	});

	it("rejects symbols, accessors, non-enumerable fields and exotic objects without invoking getters", () => {
		let invoked = 0;
		for (const mutate of [
			(r: ComposerCheckpoint) =>
				Object.defineProperty(r.incoming, "text", {
					enumerable: true,
					get() {
						invoked++;
						return "getter";
					},
				}),
			(r: ComposerCheckpoint) =>
				Object.defineProperty(r.source.attachments, "0", {
					enumerable: true,
					get() {
						invoked++;
						return {};
					},
				}),
			(r: ComposerCheckpoint) => Object.defineProperty(r.source, "text", { enumerable: false, value: "hidden" }),
			(r: ComposerCheckpoint) => Object.assign(r.incoming, { [Symbol("opaque")]: "never strip" }),
			(r: ComposerCheckpoint) => Object.setPrototypeOf(r.source, { extra: "inherited" }),
		]) {
			const input = fixture();
			mutate(input);
			expect(snapshotComposerCheckpoint(input).ok).toBe(false);
		}
		expect(invoked).toBe(0);
	});

	it("defaults off and refuses unavailable storage and truthy/async ownership without a Promise result", () => {
		const storage = new MemoryStorage();
		expect(createComposerCheckpointStore({ storage, owns: () => true }).checkpoint(fixture())).toMatchObject({
			ok: false,
			code: "disabled",
		});
		expect(
			createComposerCheckpointStore({ storage: null, owns: () => true, enabled: true }).checkpoint(fixture()),
		).toMatchObject({ ok: false, code: "unavailable" });
		for (const owns of [
			() => false,
			() => {
				throw new Error("lost");
			},
			(() => Promise.resolve(true)) as unknown as ComposerCheckpointOptions["owns"],
			(() => "true") as unknown as ComposerCheckpointOptions["owns"],
		]) {
			const result = createComposerCheckpointStore({ storage, owns, enabled: true }).checkpoint(fixture());
			expect(result).toMatchObject({ ok: false, code: "not-owner" });
			expect("then" in result).toBe(false);
		}
		expect(storage.writes).toBe(0);
	});

	it("immutable key collision refuses, identical retry is read-only, owner/CID/SID/revision remain exact", () => {
		const { storage, store } = setup();
		const input = fixture();
		expect(store.checkpoint(input).ok).toBe(true);
		const original = [...storage.data];
		expect(store.checkpoint(input).ok).toBe(true);
		expect(storage.writes).toBe(1);
		const changed = fixture();
		changed.source.text = "different original";
		expect(store.checkpoint(changed)).toMatchObject({ ok: false, code: "collision" });
		expect([...storage.data]).toStrictEqual(original);
		for (const field of ["ownerId", "composerId", "conversationId", "sessionId"] as const) {
			expect(store.read(input.recordId, { ...input.binding, [field]: "later-global" })).toMatchObject({
				ok: false,
				code: "missing",
			});
		}
		expect(store.read(input.recordId, { ...input.binding, revision: 8 })).toMatchObject({
			ok: false,
			code: "wrong-binding",
		});
	});
});

describe("composer checkpoint synchronous storage failures", () => {
	it.each(["quota", "before-write", "no-op", "partial", "throw-after-write", "corrupt", "read-throws", "read-missing"])(
		"fails honestly on %s and retains unrelated originals",
		(mode) => {
			const { storage, store } = setup();
			let wrote = false;
			storage.onSet = (key, raw) => {
				if (mode === "quota") throw new DOMException("synthetic quota", "QuotaExceededError");
				if (mode === "before-write") throw new Error("synthetic unavailable");
				if (mode === "no-op") return;
				wrote = true;
				storage.data.set(
					key,
					mode === "partial" ? raw.slice(0, -3) : mode === "corrupt" ? raw.replace("pixel.png", "other.png") : raw,
				);
				if (mode === "throw-after-write") throw new Error("committed then failed");
			};
			storage.onGet = (key) => {
				if (wrote && mode === "read-throws") throw new Error("read unavailable");
				if (wrote && mode === "read-missing") return null;
				return storage.data.get(key) ?? null;
			};
			const result = store.checkpoint(fixture());
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("failure reported acceptance");
			expect(result.payloadCommitted).toBe(
				mode === "throw-after-write"
					? true
					: ["quota", "before-write", "no-op", "read-missing"].includes(mode)
						? false
						: "unknown",
			);
			if (wrote) expect(storage.data.size).toBe(2); // never cleanup a partial/possibly committed original
			assertNoDamage(storage);
		},
	);

	it("refuses Promise/thenable setItem even when it already wrote complete bytes", () => {
		// oxlint-disable-next-line unicorn/no-thenable -- Deliberately malformed adapter return; refusal is the test.
		for (const returned of [Promise.resolve(), { then: true }]) {
			const { storage } = setup();
			const adapter: ComposerCheckpointStorage = {
				get length() {
					return storage.length;
				},
				key: (i) => storage.key(i),
				getItem: (key) => storage.getItem(key),
				setItem(key, raw) {
					storage.setItem(key, raw);
					return returned;
				},
			};
			const store = createComposerCheckpointStore({ storage: adapter, owns: () => true, enabled: true });
			const result = store.checkpoint(fixture());
			expect(result).toMatchObject({ ok: false, code: "write-failed", payloadCommitted: true });
			expect("then" in result).toBe(false);
			expect(readComposerCheckpointRecovery(storage).entries[0].record).toStrictEqual(fixture());
			expect(store.retire(fixture())).toMatchObject({ ok: false, code: "write-failed", payloadCommitted: "unknown" });
			assertNoDamage(storage);
		}
	});

	it("preflight read failure never writes", () => {
		const { storage, store } = setup();
		storage.onGet = () => {
			throw new Error("blocked");
		};
		expect(store.checkpoint(fixture())).toMatchObject({ ok: false, code: "unavailable", payloadCommitted: "unknown" });
		expect(storage.writes).toBe(0);
		assertNoDamage(storage);
	});

	it("ownership loss after full readback is committed-but-refused, not success", () => {
		let calls = 0;
		const { storage, store } = setup(() => ++calls === 1);
		expect(store.checkpoint(fixture())).toMatchObject({ ok: false, code: "not-owner", payloadCommitted: true });
		expect(calls).toBe(2);
		expect(inspectComposerCheckpoints(storage).entries[0].record).toStrictEqual(fixture());
	});

	it("catches reentrant storage changes in the post-readback ownership check", () => {
		let calls = 0;
		const storage = new MemoryStorage();
		const store = createComposerCheckpointStore({
			storage,
			enabled: true,
			owns: () => {
				if (++calls === 2) storage.data.set([...storage.data.keys()][0], "changed during owns");
				return true;
			},
		});
		expect(store.checkpoint(fixture())).toMatchObject({
			ok: false,
			code: "readback-failed",
			payloadCommitted: "unknown",
		});
	});
});

describe("append-only retirement and independent reader", () => {
	it("retains raw originals; explicit exact retirement appends a full marker and never reactivates", () => {
		const { store, storage } = setup();
		const input = fixture();
		expect(store.checkpoint(input).ok).toBe(true);
		const key = composerCheckpointKey(input);
		const original = storage.data.get(key)!;
		expect(store.retire(input).ok).toBe(true);
		expect(storage.data.get(key)).toBe(original);
		expect(store.read(input.recordId, input.binding)).toMatchObject({
			ok: true,
			retired: true,
			record: input,
			raw: original,
		});
		const inspected = readComposerCheckpointRecovery(storage);
		expect(inspected.entries.map((e) => e.status)).toStrictEqual(["retired", "retirement"]);
		expect(inspected.entries[1].retirement?.original).toBe(original);
		expect(JSON.parse(exportComposerCheckpointRecovery(inspected)).inspection.entries[0].record).toStrictEqual(input);
		expect(store.retire(input).ok).toBe(true);
		expect(storage.writes).toBe(2);
		expect(store.checkpoint(input)).toMatchObject({ ok: false, code: "retired" });
		assertNoDamage(storage);
	});

	it.each(["different-text", "newer-revision", "different-record", "wrong-owner"])(
		"stale retirement (%s) cannot delete or mark a newer/different original",
		(mode) => {
			const { store, storage } = setup();
			const original = fixture();
			expect(store.checkpoint(original).ok).toBe(true);
			const stale = fixture();
			if (mode === "different-text") stale.effective.text = "different";
			if (mode === "newer-revision") {
				stale.binding.revision++;
				stale.nextRevision++;
			}
			if (mode === "different-record") stale.recordId = "other";
			if (mode === "wrong-owner") stale.binding.ownerId = "other";
			const before = [...storage.data];
			expect(store.retire(stale)).toMatchObject({ ok: false, code: "stale-retirement" });
			expect([...storage.data]).toStrictEqual(before);
		},
	);

	it("late retirement with an old expected record preserves a replaced newer original", () => {
		const { store, storage } = setup();
		const old = fixture();
		expect(store.checkpoint(old).ok).toBe(true);
		const newer = fixture();
		newer.binding.revision++;
		newer.nextRevision++;
		newer.effective.text = "new user edits";
		const parsed = snapshotComposerCheckpoint(newer);
		if (!parsed.ok) throw new Error(parsed.detail);
		storage.data.set(composerCheckpointKey(old), JSON.stringify(parsed.record));
		const before = [...storage.data];
		expect(store.retire(old)).toMatchObject({ ok: false, code: "stale-retirement" });
		expect([...storage.data]).toStrictEqual(before);
	});

	it("retirement refuses changed ownership and retains originals on throw-after-marker", () => {
		const { store, storage } = setup();
		const input = fixture();
		expect(store.checkpoint(input).ok).toBe(true);
		const noOwner = createComposerCheckpointStore({ storage, owns: () => false, enabled: true });
		expect(noOwner.retire(input)).toMatchObject({ ok: false, code: "not-owner" });
		const key = composerCheckpointKey(input);
		const before = storage.data.get(key);
		storage.onSet = (k, v) => {
			storage.data.set(k, v);
			throw new Error("marker committed then failed");
		};
		expect(store.retire(input)).toMatchObject({ ok: false, code: "write-failed", payloadCommitted: "unknown" });
		expect(storage.data.get(key)).toBe(before);
		expect(readComposerCheckpointRecovery(storage).entries[0].record).toStrictEqual(input);
	});

	it("independent inspect/export retains unknown/corrupt/misbound/retired originals without writes", () => {
		const { store, storage } = setup();
		const input = fixture();
		expect(store.checkpoint(input).ok).toBe(true);
		expect(store.retire(input).ok).toBe(true);
		storage.data.set(`${COMPOSER_CHECKPOINT_PREFIX}future:v99:opaque`, "future opaque bytes <script>");
		storage.data.set(`${COMPOSER_CHECKPOINT_PREFIX}record:v1:broken`, "{broken");
		storage.data.set(`${COMPOSER_CHECKPOINT_PREFIX}record:v1:unknown`, '{"kind":"future","version":2}');
		storage.data.set(
			`${COMPOSER_CHECKPOINT_PREFIX}record:v1:misbound`,
			storage.data.get(composerCheckpointKey(input))!,
		);
		const before = [...storage.data];
		const inspection = readComposerCheckpointRecovery(storage);
		expect(inspection.ok).toBe(true);
		expect(inspection.entries.map((e) => e.status)).toStrictEqual([
			"retired",
			"retirement",
			"unknown",
			"corrupt",
			"unknown",
			"corrupt",
		]);
		const exported = JSON.parse(exportComposerCheckpointRecovery(inspection));
		for (const entry of inspection.entries)
			expect(exported.inspection.entries.find((e: { key: string }) => e.key === entry.key).raw).toBe(entry.raw);
		expect([...storage.data]).toStrictEqual(before);
		expect(storage.writes).toBe(2);
	});

	it("retains partial inspection results and reports unavailable/enumeration failures", () => {
		const { storage, store } = setup();
		expect(store.checkpoint(fixture()).ok).toBe(true);
		storage.data.set(`${COMPOSER_CHECKPOINT_PREFIX}future:blocked`, "unreadable");
		storage.onGet = (key) => {
			if (key.endsWith("blocked")) throw new Error("read blocked");
			return storage.data.get(key) ?? null;
		};
		const inspection = readComposerCheckpointRecovery(storage);
		expect(inspection.ok).toBe(false);
		expect(inspection.entries[0].record).toStrictEqual(fixture());
		expect(inspection.errors).toHaveLength(1);
		expect(
			readComposerCheckpointRecovery({
				...storage,
				get length(): number {
					throw new Error("blocked");
				},
				key: () => null,
				getItem: () => null,
				setItem: () => {
					throw new Error("never");
				},
			}).ok,
		).toBe(false);
	});

	it("direct read preserves unknown/corrupt raw originals without reporting acceptance", () => {
		const { store, storage } = setup();
		const input = fixture();
		const key = composerCheckpointKey(input);
		for (const raw of ["{broken", '{"kind":"future","version":99}']) {
			storage.data.set(key, raw);
			expect(store.read(input.recordId, input.binding)).toMatchObject({ ok: false, code: "invalid-record", raw });
			expect(storage.data.get(key)).toBe(raw);
		}
		expect(storage.writes).toBe(0);
	});

	it("keeps the complete original visible when only its retirement read fails", () => {
		const { store, storage } = setup();
		const input = fixture();
		expect(store.checkpoint(input).ok).toBe(true);
		const raw = storage.data.get(composerCheckpointKey(input));
		storage.onGet = (key) => {
			if (key.startsWith(`${COMPOSER_CHECKPOINT_PREFIX}retirement:`)) throw new Error("blocked retirement");
			return storage.data.get(key) ?? null;
		};
		const inspection = readComposerCheckpointRecovery(storage);
		expect(inspection.ok).toBe(false);
		expect(inspection.entries[0]).toMatchObject({ status: "unknown", raw, record: input });
		expect(store.read(input.recordId, input.binding)).toMatchObject({
			ok: false,
			code: "unavailable",
			raw,
			record: input,
		});
		expect(storage.writes).toBe(1);
	});

	it("refuses noncanonical/duplicate/lossy JSON without discarding the raw value", () => {
		const snapshot = snapshotComposerCheckpoint(fixture());
		if (!snapshot.ok) throw new Error(snapshot.detail);
		const raw = JSON.stringify(snapshot.record);
		for (const changed of [
			raw + " ",
			raw.replace('"version":1', '"version":1,"version":1'),
			raw.replace('"revision":7', '"revision":7.0000000000000001'),
			"{broken",
		]) {
			expect(decodeComposerCheckpoint(changed).ok).toBe(false);
			const { storage } = setup();
			storage.data.set(composerCheckpointKey(snapshot.record), changed);
			expect(readComposerCheckpointRecovery(storage).entries[0]).toMatchObject({ raw: changed, status: "corrupt" });
		}
	});
});
