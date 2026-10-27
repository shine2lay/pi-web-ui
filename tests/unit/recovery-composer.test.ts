import { describe, expect, it, vi } from "vitest";
import {
	createComposerRecovery,
	sameComposerBinding,
	type ComposerHostPort,
	type ComposerHostSnapshot,
} from "../../web/src/recovery-composer";
import type { ComposerCheckpointStorage } from "../../web/src/composer-checkpoint";
import type { ComposerPayload } from "../../web/src/composer-bridge";

function fixture() {
	const rows = new Map<string, string>();
	let onSet: (() => void) | undefined;
	const storage: ComposerCheckpointStorage = {
		get length() {
			return rows.size;
		},
		key: (index) => [...rows.keys()][index] ?? null,
		getItem: (key) => rows.get(key) ?? null,
		setItem: vi.fn((key, value) => {
			rows.set(key, value);
			onSet?.();
		}),
	};
	let state: ComposerHostSnapshot | null = {
		binding: { ownerId: "owner", conversationId: "c1", sessionId: "session-1", composerId: "composer-1", revision: 0 },
		draft: { text: "existing Ω", attachments: [{ path: "/old", name: "old", mode: "reference" }] },
	};
	let id = 0;
	const api = createComposerRecovery({ storage: () => storage, now: () => 123, newId: () => `record-${++id}` });
	const port: ComposerHostPort = {
		snapshot: () => state,
		apply: vi.fn((original, record) => {
			expect(rows.size).toBeGreaterThan(0);
			expect(state?.binding).toEqual(original.binding);
			state = {
				binding: { ...record.binding, revision: record.nextRevision },
				draft: structuredClone(record.effective),
			};
			return true;
		}),
		problem: vi.fn(),
	};
	const detach = api.attach(port);
	return {
		api,
		port,
		rows,
		storage,
		detach,
		get state() {
			return state;
		},
		set state(next) {
			state = next;
		},
		onSet(fn: () => void) {
			onSet = fn;
		},
	};
}
const payload: ComposerPayload = {
	text: "  complete original 雪\n",
	attachments: [{ path: "", name: "exact.txt", mimeType: "text/plain", fileData: "YWJj", size: 3 }],
};

describe("actual composer checkpoint → single full-draft sink", () => {
	it("compares every binding field independently of codec key order", () => {
		const source = fixture().state!.binding;
		const codec = {
			revision: source.revision,
			sessionId: source.sessionId,
			composerId: source.composerId,
			conversationId: source.conversationId,
			ownerId: source.ownerId,
		};
		expect(JSON.stringify(source)).not.toBe(JSON.stringify(codec));
		expect(sameComposerBinding(source, codec)).toBe(true);
		for (const key of ["ownerId", "composerId", "conversationId", "sessionId", "revision"] as const)
			expect(sameComposerBinding(source, { ...codec, [key]: key === "revision" ? 8 : "other" })).toBe(false);
	});
	it("restores missing attachments beside L1 text without duplicating the words", () => {
		const f = fixture();
		expect(f.api.compose(payload)).toBe(true);
		const saved = f.api.inspect().entries[0].record!;
		f.state = { binding: { ...f.state!.binding, revision: 2 }, draft: { text: saved.effective.text, attachments: [] } };
		expect(f.api.restore(saved)).toBe(true);
		expect(f.state?.draft).toEqual(saved.effective);
		expect(f.api.restore(saved)).toBe(true);
		expect(f.rows.size).toBe(2);
	});
	it("import and attaching a port do not touch storage or place a draft", () => {
		const f = fixture();
		expect(f.api.ready()).toBe(true);
		expect(f.rows.size).toBe(0);
		expect(f.port.apply).not.toHaveBeenCalled();
		f.detach();
		expect(f.api.ready()).toBe(false);
		expect(f.api.compose(payload)).toBe(false);
		expect(f.rows.size).toBe(0);
	});
	it("returns an actual boolean only after complete write/readback and one full placement", () => {
		const f = fixture();
		const source = structuredClone(f.state?.draft);
		expect(f.api.compose(payload)).toBe(true);
		expect(f.port.apply).toHaveBeenCalledTimes(1);
		const result = f.api.inspect();
		expect(result.ok).toBe(true);
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0].record).toMatchObject({ source, incoming: payload, effective: f.state?.draft });
		expect(f.state?.binding.revision).toBe(1);
	});
	it("retains exact large bytes and all three views even where merge deduplicates a path", () => {
		const f = fixture();
		const bytes = Buffer.from("原始🙂".repeat(400_000), "utf8").toString("base64");
		const input = {
			text: " \n full ",
			attachments: [
				{ path: "/old", name: "different incoming" },
				{ path: "", name: "bytes", fileData: bytes, mimeType: "text/plain", size: 42, key: "original" },
			],
		};
		expect(f.api.compose(input)).toBe(true);
		const record = f.api.inspect().entries[0].record!;
		expect(record.incoming).toEqual(input);
		expect(record.source.attachments[0].name).toBe("old");
		expect(record.effective.attachments.at(-1)?.fileData).toBe(bytes);
		expect(f.state?.draft.attachments.at(-1)?.fileData).toBe(bytes);
	});
	it("preserves reference metadata without fetching, executing or changing authority", () => {
		const f = fixture();
		const input = {
			attachments: [
				{ path: "https://example.test", name: "authorized page", mode: "page" as const },
				{ path: "", name: "conversation", mode: "conversation" as const, conversationId: "c9" },
			],
		};
		expect(f.api.compose(input)).toBe(true);
		expect(f.api.inspect().entries[0].record?.incoming).toEqual(input);
	});
	it("does not accept a whitespace-only/empty injection or mutate its source", () => {
		const f = fixture();
		const before = structuredClone(f.state);
		expect(f.api.compose({ text: " \n " })).toBe(false);
		expect(f.rows.size).toBe(0);
		expect(f.state).toEqual(before);
	});
	it.each([
		null,
		{ text: 8 },
		{ text: "x", extra: true },
		{ attachments: [{ path: "", name: "truncated", imageData: "AAA" }] },
		{ attachments: [{ path: "/x", name: "x", capabilitySecret: "SYNTHETIC" }] },
	])("rejects malformed/unknown fields without lossy normalization: %j", (input) => {
		const f = fixture();
		expect(f.api.compose(input as ComposerPayload)).toBe(false);
		expect(f.rows.size).toBe(0);
		expect(f.port.apply).not.toHaveBeenCalled();
	});
	it("never invokes an input getter", () => {
		const f = fixture();
		const getter = vi.fn(() => "not a plain value");
		const input = Object.defineProperty({}, "text", { get: getter, enumerable: true });
		expect(f.api.compose(input)).toBe(false);
		expect(getter).not.toHaveBeenCalled();
	});
	it("refuses unavailable ownership without a write", () => {
		const f = fixture();
		f.state = null;
		expect(f.api.compose(payload)).toBe(false);
		expect(f.rows.size).toBe(0);
	});
	it("refuses quota before any sink and preserves editable source", () => {
		const f = fixture();
		const before = structuredClone(f.state);
		vi.mocked(f.storage.setItem).mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		expect(f.api.compose(payload)).toBe(false);
		expect(f.port.apply).not.toHaveBeenCalled();
		expect(f.state).toEqual(before);
		expect(f.port.problem).toHaveBeenCalled();
	});
	it("committed-then-throw is false, preserves the complete checkpoint, and never calls a sink", () => {
		const f = fixture();
		const before = structuredClone(f.state);
		f.onSet(() => {
			throw new Error("interrupted after set");
		});
		expect(f.api.compose(payload)).toBe(false);
		expect(f.port.apply).not.toHaveBeenCalled();
		expect(f.state).toEqual(before);
		expect(f.api.inspect().entries[0].record?.incoming).toEqual(payload);
	});
	it.each(["revision", "sessionId", "composerId", "ownerId", "conversationId"] as const)(
		"fences changed %s during the synchronous storage callback",
		(field) => {
			const f = fixture();
			f.onSet(() => {
				const state = f.state!;
				f.state = { ...state, binding: { ...state.binding, [field]: field === "revision" ? 2 : "replacement" } };
			});
			expect(f.api.compose(payload)).toBe(false);
			expect(f.port.apply).not.toHaveBeenCalled();
			expect(f.api.inspect().entries[0].record?.incoming).toEqual(payload);
		},
	);
	it("fences a replaced port even if all binding strings match", () => {
		const f = fixture();
		const other = { ...f.port, apply: vi.fn(() => true) };
		f.onSet(() => f.api.attach(other));
		expect(f.api.compose(payload)).toBe(false);
		expect(f.port.apply).not.toHaveBeenCalled();
		expect(other.apply).not.toHaveBeenCalled();
	});
	it("a reentrant compose never duplicates the admitted effect", () => {
		const f = fixture();
		let inner: unknown;
		f.onSet(() => {
			inner = f.api.compose({ text: "nested" });
		});
		expect(f.api.compose(payload)).toBe(true);
		expect(inner).toBe(false);
		expect(f.port.apply).toHaveBeenCalledTimes(1);
		expect(f.rows.size).toBe(1);
	});
	it.each([false, "throw", "true-without-placement", "partial-placement"])(
		"retains checkpoint and rejects %s sink",
		(failure) => {
			const f = fixture();
			vi.mocked(f.port.apply).mockImplementation(() => {
				if (failure === "throw") throw new Error("sink failed");
				if (failure === "partial-placement") f.state = { ...f.state!, binding: { ...f.state!.binding, revision: 1 } };
				return failure !== false;
			});
			expect(f.api.compose(payload)).toBe(false);
			expect(f.api.inspect().entries[0].record?.incoming).toEqual(payload);
		},
	);
	it("input mutations after return cannot rewrite source/effective/checkpoint", () => {
		const f = fixture();
		const input = structuredClone(payload);
		expect(f.api.compose(input)).toBe(true);
		input.text = "later";
		input.attachments![0].fileData = "changed";
		expect(f.api.inspect().entries[0].record?.incoming).toEqual(payload);
		expect(f.state?.draft.attachments.at(-1)?.fileData).toBe(payload.attachments![0].fileData);
	});
	it("an explicit same-session restore is a new full checkpoint, never automatic deletion", () => {
		const f = fixture();
		expect(f.api.compose(payload)).toBe(true);
		const saved = f.api.inspect().entries[0].record!;
		f.state = {
			binding: { ...f.state!.binding, ownerId: "new-owner", composerId: "new-composer", revision: 0 },
			draft: { text: "", attachments: [] },
		};
		expect(f.api.restore(saved)).toBe(true);
		expect(f.state?.draft).toEqual(saved.effective);
		expect(f.rows.size).toBe(2);
		expect(f.api.inspect().entries.every((e) => e.status === "active")).toBe(true);
	});
	it("a wrong-session restore keeps the original without placing or writing anything", () => {
		const f = fixture();
		expect(f.api.compose(payload)).toBe(true);
		const saved = f.api.inspect().entries[0].record!;
		f.state = { ...f.state!, binding: { ...f.state!.binding, sessionId: "another-session" } };
		expect(f.api.restore(saved)).toBe(false);
		expect(f.rows.size).toBe(1);
		expect(f.port.apply).toHaveBeenCalledTimes(1);
	});
});
