import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PLUGIN_START_PREFIX,
	PLUGIN_START_LOCK_PREFIX,
	openPluginStartCheckpoint,
	createPluginStartAdapter,
	catalogPluginStarts,
	exportPluginStarts,
	readPluginStartExport,
	pluginStartOriginalOptions,
	createPluginStartReaderHtml,
	type PluginStartOwner,
	type PluginStartOpenOptions,
	type PluginStartResult,
	type PluginStartSource,
} from "../../web/src/plugin-start-checkpoint";
import { createPluginHostApi, type PluginHostStartChatOptions } from "../../web/src/plugin-host";

const ORIGINAL = " \t原始\r\n é 🌈\u0000\ud800 <script> untouched \n";
const fixed = (): PluginHostStartChatOptions => ({
	prompt: ORIGINAL,
	newChat: false,
	cwd: "  /目录\n ",
	model: " provider/model \t",
});
class MemoryStorage implements Storage {
	values = new Map<string, string>();
	events: string[] = [];
	setFailure: Error | null = null;
	onRead?: (key: string, value: string | null) => string | null;
	onWrite?: (key: string, value: string) => void;
	get length() {
		return this.values.size;
	}
	key(i: number) {
		return [...this.values.keys()][i] ?? null;
	}
	getItem(key: string) {
		this.events.push("read");
		const value = this.values.get(key) ?? null;
		return this.onRead ? this.onRead(key, value) : value;
	}
	setItem(key: string, value: string) {
		this.events.push("write");
		if (this.setFailure) throw this.setFailure;
		this.values.set(key, value);
		this.onWrite?.(key, value);
	}
	removeItem(key: string) {
		this.events.push("DELETE");
		this.values.delete(key);
	}
	clear() {
		this.events.push("CLEAR");
		this.values.clear();
	}
}
class Locks {
	held = new Set<string>();
	request: LockManager["request"] = (async (
		name: string,
		options: LockOptions | LockGrantedCallback,
		callback?: LockGrantedCallback,
	) => {
		const cb = typeof options === "function" ? options : callback!;
		if (this.held.has(name)) return cb(null);
		this.held.add(name);
		try {
			return await cb({ name, mode: "exclusive" } as Lock);
		} finally {
			this.held.delete(name);
		}
	}) as LockManager["request"];
}
const owners: PluginStartOwner[] = [];
const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
	for (const owner of owners.splice(0)) owner.close();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
async function fixture(extra: Partial<PluginStartOpenOptions> = {}) {
	const storage = new MemoryStorage();
	const locks = new Locks();
	const binding: PluginStartSource = {
		ownerId: "owner-一",
		sessionId: "stable-session",
		conversationId: "conversation-original",
		pluginId: "synthetic-plugin",
	};
	let sequence = 0;
	const options: PluginStartOpenOptions = {
		ownerId: binding.ownerId,
		getSource: () => binding,
		storage,
		locks,
		newId: () => `generated-${sequence++}`,
		now: () => 42,
		...extra,
	};
	const opened = await openPluginStartCheckpoint(options);
	expect(opened.ok).toBe(true);
	if (!opened.ok) throw new Error(opened.code);
	owners.push(opened.owner);
	return { owner: opened.owner, storage, locks, binding, options };
}
function accepted(result: PluginStartResult) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.code);
	return result;
}
const ids = (n = "1") => ({ intentId: `intent-${n}`, promptId: `prompt-${n}` });
const rawKey = (kind: string, owner = "owner-一", id = "intent-1") =>
	PLUGIN_START_PREFIX + JSON.stringify([kind, owner, id]);

const variants: { name: string; input: PluginHostStartChatOptions }[] = [];
for (const newChat of ["absent", undefined, true, false] as const) {
	for (const cwd of ["absent", undefined, "", " \t", " /路径\n "] as const) {
		for (const model of ["absent", undefined, "", " \r\n", " provider/model "] as const) {
			const input: PluginHostStartChatOptions = { prompt: ORIGINAL };
			if (newChat !== "absent") input.newChat = newChat;
			if (cwd !== "absent") input.cwd = cwd;
			if (model !== "absent") input.model = model;
			variants.push({ name: `${String(newChat)}/${String(cwd)}/${String(model)}`, input });
		}
	}
}

describe("complete typed synchronous capture", () => {
	it.each(variants)("preserves exact option value/presence $name", async ({ input }) => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(input, ids()));
		expect(r.intent.original.prompt).toBe(ORIGINAL);
		expect(pluginStartOriginalOptions(r.intent)).toStrictEqual(input);
		expect(r.intent.effective).toEqual({
			prompt: ORIGINAL.trim(),
			newChat: input.newChat !== false,
			cwd: (input.cwd ?? "").trim(),
			model: (input.model ?? "").trim(),
		});
		expect(r.intent.source).toEqual({
			ownerId: owner.ownerId,
			sessionId: "stable-session",
			conversationId: "conversation-original",
			pluginId: "synthetic-plugin",
			generation: owner.generation,
		});
		expect(r.intent.intentId).toBe("intent-1");
		expect(r.intent.promptId).toBe("prompt-1");
		expect(storage.getItem(r.identity.key)).toBe(r.identity.serialized);
		expect(readPluginStartExport(exportPluginStarts(storage)).entries[0].intent).toEqual(r.intent);
		expect(r.dispatch).toBe(false);
	});
	it("no discretionary size/count/age cap or eviction; exact big original stays", async () => {
		const { owner, storage } = await fixture();
		const input = { ...fixed(), prompt: ORIGINAL.repeat(20_003) };
		const r = accepted(owner.checkpoint(input, ids()));
		const many = await fixture();
		for (let i = 0; i < 258; i++) accepted(many.owner.checkpoint({ prompt: `next-${i}` }, ids(String(i + 2))));
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
		expect(pluginStartOriginalOptions(r.intent)).toStrictEqual(input);
		expect(catalogPluginStarts(many.storage).entries).toHaveLength(258);
		expect(storage.events).not.toContain("DELETE");
		expect(storage.events).not.toContain("CLEAR");
	});
	it.each([
		null,
		undefined,
		{},
		{ prompt: " \r\n\t" },
		{ prompt: 1 },
		{ prompt: "x", cwd: null },
		{ prompt: "x", model: 7 },
		{ prompt: "x", newChat: "false" },
		{ prompt: "x", extra: "not a generic journal" },
		{ prompt: "x", [Symbol("extra")]: 1 },
	])("refuses unsupported or empty input %# without changing caller", async (input) => {
		const { owner, storage } = await fixture();
		expect(owner.checkpoint(input as PluginHostStartChatOptions)).toMatchObject({
			ok: false,
			code: "invalid-input",
			sourceRetained: true,
			dispatch: false,
		});
		expect(storage.values.size).toBe(0);
	});
	it("does not run accessors or serialize arbitrary object payloads", async () => {
		const { owner, storage } = await fixture();
		const getter = vi.fn(() => "secret");
		const input = Object.defineProperty({}, "prompt", { get: getter });
		expect(owner.checkpoint(input as PluginHostStartChatOptions).ok).toBe(false);
		expect(getter).not.toHaveBeenCalled();
		expect(storage.values.size).toBe(0);
	});
	it("captures immutable originals before later input mutation", async () => {
		const { owner } = await fixture();
		const input = fixed();
		const r = accepted(owner.checkpoint(input, ids()));
		input.prompt = "changed";
		input.cwd = "changed";
		input.newChat = true;
		input.model = "changed";
		expect(pluginStartOriginalOptions(r.intent)).toStrictEqual(fixed());
		expect(Object.isFrozen(r.intent.original.cwd)).toBe(true);
		expect(() => {
			r.intent.original.prompt = "bad";
		}).toThrow();
	});
	it("copies open configuration before its await and does not move the leased owner", async () => {
		const { owner, options } = await fixture();
		options.ownerId = "unleased-owner";
		const r = accepted(owner.checkpoint(fixed(), ids()));
		expect(r.intent.source.ownerId).toBe(owner.ownerId);
	});
	it.each(["intent", "prompt"])("duplicate %s ID refuses even identical text, retaining originals", async (which) => {
		const { owner, storage } = await fixture();
		const first = accepted(owner.checkpoint(fixed(), ids()));
		const next =
			which === "intent"
				? { intentId: first.intent.intentId, promptId: "new-prompt" }
				: { intentId: "new-intent", promptId: first.intent.promptId };
		expect(owner.checkpoint({ prompt: "other" }, next)).toMatchObject({ ok: false, code: "duplicate-id" });
		expect(storage.values.size).toBe(1);
		expect(storage.values.get(first.identity.key)).toBe(first.identity.serialized);
	});
});

describe("native boundary failure model", () => {
	it("unavailable native locks never produce a ready memory-only API", async () => {
		vi.stubGlobal("navigator", {});
		const r = await openPluginStartCheckpoint({
			ownerId: "o",
			getSource: () => ({ ownerId: "o", sessionId: "s", conversationId: "c", pluginId: null }),
			storage: new MemoryStorage(),
		});
		expect(r).toMatchObject({ ok: false, code: "unavailable", dispatch: false });
	});
	it("throwing lock request refuses and releases startup", async () => {
		const locks = {
			request: (() => {
				throw new Error("SecurityError");
			}) as LockManager["request"],
		};
		expect(
			await openPluginStartCheckpoint({
				ownerId: "o",
				locks,
				getSource: () => {
					throw new Error("unused");
				},
			}),
		).toMatchObject({ ok: false });
	});
	it("throwing native localStorage getter refuses; no fallback", async () => {
		vi.stubGlobal("localStorage", undefined);
		const opened = await openPluginStartCheckpoint({
			ownerId: "o",
			locks: new Locks(),
			getSource: () => ({ ownerId: "o", sessionId: "s", conversationId: "c", pluginId: null }),
		});
		expect(opened).toMatchObject({ ok: false, code: "catalogue-incomplete" });
	});
	it.each(["quota", "security"])("%s failure is false and never clears older work or caller input", async (mode) => {
		const { owner, storage } = await fixture();
		const original = accepted(owner.checkpoint(fixed(), ids()));
		storage.setFailure = new Error(mode === "quota" ? "QuotaExceededError" : "SecurityError");
		const input = fixed();
		expect(owner.checkpoint(input, ids("next"))).toMatchObject({
			ok: false,
			code: "storage-failed",
			sourceRetained: true,
			dispatch: false,
		});
		expect(input).toStrictEqual(fixed());
		expect(storage.values.get(original.identity.key)).toBe(original.identity.serialized);
		expect(storage.events).not.toContain("DELETE");
	});
	it.each(["different", "null", "throw"])(
		"readback %s never grants true/clear/effect; raw original stays",
		async (mode) => {
			const { owner, storage } = await fixture();
			storage.onRead = (_key, value) => {
				if (value === null) return null;
				if (mode === "throw") throw new Error("SecurityError");
				return mode === "null" ? null : value + " ";
			};
			const result = owner.checkpoint(fixed(), ids());
			expect(result).toMatchObject({ ok: false, sourceRetained: true, checkpointMayExist: true, dispatch: false });
			expect(storage.values.size).toBe(1);
			storage.onRead = undefined;
			expect(catalogPluginStarts(storage).entries[0].intent?.original.prompt).toBe(ORIGINAL);
			expect(owner.begin({ key: rawKey("intent"), serialized: storage.values.get(rawKey("intent"))! })).toMatchObject({
				ok: false,
				code: "recovery-required",
			});
		},
	);
	it("incomplete enumeration refuses opening and preserves raw bytes", async () => {
		const storage = new MemoryStorage();
		storage.values.set(rawKey("intent"), "unknown-raw");
		vi.spyOn(storage, "key").mockReturnValue(null);
		const { options } = await fixture();
		expect(await openPluginStartCheckpoint({ ...options, locks: new Locks(), storage })).toMatchObject({
			ok: false,
			code: "catalogue-incomplete",
		});
		expect(storage.values.get(rawKey("intent"))).toBe("unknown-raw");
	});
	it("closed lifetime lease refuses even a previously fresh record", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		owner.close();
		expect(owner.checkpoint(fixed(), ids("2"))).toMatchObject({ ok: false, code: "closed" });
		expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "closed" });
		expect(await owner.retire({ kind: "discard", identity: r.identity })).toMatchObject({ ok: false, code: "closed" });
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
	});
	it("separate lifetime lock denies duplicate owner, permits independent owner", async () => {
		const { owner, options, locks, storage } = await fixture();
		accepted(owner.checkpoint(fixed(), ids()));
		expect(locks.held.has(PLUGIN_START_LOCK_PREFIX + owner.ownerId)).toBe(true);
		expect(await openPluginStartCheckpoint(options)).toMatchObject({ ok: false, code: "owner-conflict" });
		const other = await openPluginStartCheckpoint({
			...options,
			ownerId: "other",
			getSource: () => ({ ...options.getSource(), ownerId: "other" }),
		});
		expect(other.ok).toBe(true);
		if (other.ok) owners.push(other.owner);
		expect(storage.values.size).toBe(1);
	});
	it("reload can inspect but cannot automatically begin an older generation", async () => {
		const { owner, options, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		owner.close();
		await flush();
		const next = await openPluginStartCheckpoint(options);
		expect(next.ok).toBe(true);
		if (!next.ok) throw new Error(next.code);
		owners.push(next.owner);
		expect(next.owner.generation).not.toBe(owner.generation);
		expect(next.owner.begin(r.identity)).toMatchObject({ ok: false, code: "recovery-required" });
		expect(catalogPluginStarts(storage).entries[0].state).toBe("recovery-required");
	});
	it.each(["sessionId", "conversationId", "ownerId"] as const)(
		"source %s drift before begin never dispatches",
		async (field) => {
			const { owner, binding, storage } = await fixture();
			const r = accepted(owner.checkpoint(fixed(), ids()));
			binding[field] = "wrong-source";
			expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "source-mismatch" });
			expect(storage.values.size).toBe(1);
		},
	);
	it("source drift during full readback returns false but retains complete captured original", async () => {
		const { owner, binding, storage } = await fixture();
		storage.onWrite = () => {
			binding.sessionId = "different-session";
		};
		expect(owner.checkpoint(fixed(), ids())).toMatchObject({
			ok: false,
			code: "source-mismatch",
			checkpointMayExist: true,
		});
		expect(catalogPluginStarts(storage).entries[0].intent?.source.sessionId).toBe("stable-session");
	});
	it("reentrant checkpoint cannot sneak in during an injected storage write", async () => {
		const { owner, storage } = await fixture();
		storage.onWrite = () =>
			expect(owner.checkpoint(fixed(), ids("nested"))).toMatchObject({ ok: false, code: "reentrant" });
		accepted(owner.checkpoint(fixed(), ids()));
		expect(storage.values.size).toBe(1);
	});
});

describe("guarded possible-effect and explicit retirement", () => {
	it("requires full begin-marker readback before one-shot permit; no promise inference", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		const begun = owner.begin(r.identity);
		expect(begun.ok).toBe(true);
		if (!begun.ok) throw new Error(begun.code);
		expect(storage.values.has(rawKey("begin"))).toBe(true);
		expect(begun.permit.valid()).toBe(true);
		expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "recovery-required" });
		const item = catalogPluginStarts(storage).entries.find((e) => e.kind === "intent")!;
		expect(item).toMatchObject({ state: "recovery-required", possibleEffects: true });
		owner.close();
		expect(begun.permit.valid()).toBe(false);
	});
	it("quota at begin grants no effect permit and leaves original recoverable", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		storage.setFailure = new Error("QuotaExceededError");
		expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "storage-failed" });
		storage.setFailure = null;
		expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "recovery-required" });
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
	});
	it("failed begin readback leaves possible effects uncertain and is not retried", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		storage.onRead = (key, value) => (key === rawKey("begin") && value !== null ? value + " " : value);
		expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "readback-failed" });
		storage.onRead = undefined;
		expect(owner.begin(r.identity)).toMatchObject({ ok: false, code: "recovery-required" });
		expect(catalogPluginStarts(storage).entries.find((e) => e.kind === "intent")).toMatchObject({
			state: "recovery-required",
			possibleEffects: true,
		});
	});
	it("begin snapshots identity before a caller can mutate it; changed storage invalidates permits", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		const identity = { ...r.identity };
		const begun = owner.begin(identity);
		expect(begun.ok).toBe(true);
		if (!begun.ok) throw new Error(begun.code);
		identity.serialized = "mutated caller receipt";
		expect(begun.permit.valid()).toBe(true);
		storage.values.set(r.identity.key, r.identity.serialized + " ");
		expect(begun.permit.valid()).toBe(false);
	});
	it("bound owner changes invalidate a live permit and retirement", async () => {
		const { owner, binding } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		const begun = owner.begin(r.identity);
		expect(begun.ok).toBe(true);
		if (!begun.ok) throw new Error(begun.code);
		binding.ownerId = "different-owner";
		expect(begun.permit.valid()).toBe(false);
		expect(await owner.retire({ kind: "discard", identity: r.identity })).toMatchObject({
			ok: false,
			code: "source-mismatch",
		});
	});
	it("only deliberate exact matched discard retires, and never deletes raw original", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		expect(
			await owner.retire({ kind: "discard", identity: { ...r.identity, serialized: r.identity.serialized + " " } }),
		).toMatchObject({ ok: false, code: "invalid-identity" });
		expect(await owner.retire({ kind: "discard", identity: r.identity })).toEqual({ ok: true });
		expect(catalogPluginStarts(storage).entries.find((e) => e.kind === "intent")?.state).toBe("retired");
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
		expect(storage.events).not.toContain("DELETE");
		expect(owner.begin(r.identity).ok).toBe(false);
	});
	it("same text but wrong IDs or owner is not cleanup authority", async () => {
		const { owner, options, storage } = await fixture();
		const a = accepted(owner.checkpoint(fixed(), ids()));
		const b = accepted(owner.checkpoint(fixed(), ids("2")));
		expect(
			await owner.retire({ kind: "discard", identity: { key: b.identity.key, serialized: a.identity.serialized } }),
		).toMatchObject({ ok: false });
		const other = await openPluginStartCheckpoint({
			...options,
			ownerId: "other",
			getSource: () => ({ ...options.getSource(), ownerId: "other" }),
		});
		if (!other.ok) throw new Error(other.code);
		owners.push(other.owner);
		expect(await other.owner.retire({ kind: "discard", identity: a.identity })).toMatchObject({ ok: false });
		expect(catalogPluginStarts(storage).entries.every((e) => e.state !== "retired")).toBe(true);
	});
	it.each(["absent", "false", "throw", "truthy"])("%s verifier is never genuine persistence evidence", async (mode) => {
		const verifyPersistence: PluginStartOpenOptions["verifyPersistence"] =
			mode === "absent"
				? undefined
				: () => {
						if (mode === "throw") throw new Error("bad proof");
						return mode === "truthy" ? ("yes" as unknown as boolean) : false;
					};
		const { owner, storage } = await fixture({ verifyPersistence });
		const r = accepted(owner.checkpoint(fixed(), ids()));
		expect(
			await owner.retire({ kind: "persisted", identity: r.identity, proof: { type: "socket-ack" } }),
		).toMatchObject({ ok: false, code: "persistence-unverified" });
		expect(storage.values.size).toBe(1);
	});
	it("genuine host evidence is checked against frozen complete intent, not serialized as payload", async () => {
		const proof = { privateAuthority: "not-for-browser-storage" };
		const verifyPersistence = vi.fn((intent, got) => {
			expect(got).toBe(proof);
			expect(pluginStartOriginalOptions(intent)).toStrictEqual(fixed());
			return true;
		});
		const { owner, storage } = await fixture({ verifyPersistence });
		const r = accepted(owner.checkpoint(fixed(), ids()));
		expect(await owner.retire({ kind: "persisted", identity: r.identity, proof })).toEqual({ ok: true });
		expect(verifyPersistence).toHaveBeenCalledOnce();
		expect([...storage.values.values()].join("")).not.toContain("privateAuthority");
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
	});
	it.each(["close", "replace"])("verifier await then %s revalidates ownership/exact identity", async (mode) => {
		let verified!: (value: boolean) => void;
		const { owner, storage } = await fixture({
			verifyPersistence: () =>
				new Promise<boolean>((resolve) => {
					verified = resolve;
				}),
		});
		const r = accepted(owner.checkpoint(fixed(), ids()));
		const retirement = owner.retire({ kind: "persisted", identity: r.identity, proof: "genuine-after-await" });
		if (mode === "close") owner.close();
		else storage.values.set(r.identity.key, r.identity.serialized + " ");
		verified(true);
		expect((await retirement).ok).toBe(false);
		expect(storage.values.has(rawKey("retired"))).toBe(false);
	});
	it("retirement captures caller identity and authority before arbitrary verifier await", async () => {
		let verified!: (value: boolean) => void;
		const { owner, storage } = await fixture({
			verifyPersistence: () =>
				new Promise<boolean>((resolve) => {
					verified = resolve;
				}),
		});
		const r = accepted(owner.checkpoint(fixed(), ids()));
		const identity = { ...r.identity };
		const request = { kind: "persisted" as const, identity, proof: "synthetic proof" };
		const retirement = owner.retire(request);
		identity.serialized = "changed";
		verified(true);
		expect(await retirement).toEqual({ ok: true });
		expect(JSON.parse(storage.values.get(rawKey("retired"))!).authority).toBe("persisted");
	});
	it("retirement quota refuses, preserving every previous raw record", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		storage.setFailure = new Error("QuotaExceededError");
		expect(await owner.retire({ kind: "discard", identity: r.identity })).toMatchObject({
			ok: false,
			code: "storage-failed",
		});
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
	});
});

describe("actual boolean adapter and real old-host behavioral control", () => {
	it("old host fails checkpoint-before-effect invariant; guarded adapter passes with real imported APIs", async () => {
		const { owner, storage } = await fixture();
		const legacyEffects: string[] = [];
		const legacy = createPluginHostApi({
			send: (msg) => {
				legacyEffects.push(msg.type);
				return true;
			},
			isReady: () => true,
			setView: () => {},
			getCwd: () => "",
			getWorkspaceRoots: () => [],
			listSessions: () => [],
			getConversationId: () => "c",
			isConversationBlank: () => true,
		});
		const oldBoolean = legacy.startChat({ prompt: ORIGINAL, newChat: false });
		expect(oldBoolean).toBe(true);
		expect(typeof oldBoolean).toBe("boolean");
		expect(legacyEffects).toEqual(["prompt"]);
		expect(storage.values.size).toBe(0); // Genuine behavioral red: real host had no full-intent checkpoint.
		const effects: string[] = [];
		const guarded = createPluginStartAdapter(owner, {
			validate: () => true,
			continueIntent: (intent, permit) => {
				expect(permit.valid()).toBe(true);
				expect(catalogPluginStarts(storage).entries.find((e) => e.kind === "intent")?.intent).toEqual(intent);
				expect(storage.values.size).toBe(2);
				effects.push("effect-after-full-checkpoint-and-begin");
			},
		});
		const result = guarded.startChat(fixed());
		expect(result).toBe(true);
		expect(typeof result).toBe("boolean");
		expect(effects).toEqual([]);
		expect(storage.values.size).toBe(1);
		const lastWrite = storage.events.lastIndexOf("write");
		expect(storage.events.slice(lastWrite + 1)).toContain("read");
		await flush();
		expect(effects).toEqual(["effect-after-full-checkpoint-and-begin"]);
	});
	it.each(["quota", "host-false", "host-throws"])(
		"%s returns actual false; no dispatch or input clear",
		async (mode) => {
			const { owner, storage } = await fixture();
			const continuation = vi.fn();
			let callerText = ORIGINAL;
			if (mode === "quota") storage.setFailure = new Error("QuotaExceededError");
			const adapter = createPluginStartAdapter(owner, {
				validate: () => {
					if (mode === "host-throws") throw new Error("not ready");
					return mode !== "host-false";
				},
				continueIntent: continuation,
			});
			const result = adapter.startChat(fixed());
			if (result) callerText = "";
			expect(result).toBe(false);
			expect(typeof result).toBe("boolean");
			expect(callerText).toBe(ORIGINAL);
			await flush();
			expect(continuation).not.toHaveBeenCalled();
		},
	);
	it("captures original before calling a synchronous host validator", async () => {
		const { owner } = await fixture();
		const input = fixed();
		const adapter = createPluginStartAdapter(owner, {
			validate: (snapshot) => {
				expect(Object.isFrozen(snapshot)).toBe(true);
				input.prompt = "changed by validator";
				return true;
			},
			continueIntent: () => {},
		});
		expect(adapter.startChat(input)).toBe(true);
		const r = accepted(adapter.lastResult()!);
		expect(pluginStartOriginalOptions(r.intent)).toStrictEqual(fixed());
		await flush();
	});
	it("later mutation cannot replace accepted options; delayed rejection retains uncertainty", async () => {
		const { owner, storage } = await fixture();
		let reject!: (reason: Error) => void;
		const continuation = vi.fn((intent) => {
			expect(pluginStartOriginalOptions(intent)).toStrictEqual(fixed());
			return new Promise<void>((_resolve, no) => {
				reject = no;
			});
		});
		const adapter = createPluginStartAdapter(owner, { validate: () => true, continueIntent: continuation });
		const input = fixed();
		expect(adapter.startChat(input)).toBe(true);
		input.prompt = "changed";
		input.cwd = "changed";
		await flush();
		expect(continuation).toHaveBeenCalledOnce();
		reject(new Error("async app admission rejected"));
		await flush();
		expect(adapter.issues()).toMatchObject([{ code: "continuation-failed", checkpointMayExist: true }]);
		expect(catalogPluginStarts(storage).entries.find((e) => e.kind === "intent")).toMatchObject({
			state: "recovery-required",
			possibleEffects: true,
		});
	});
	it("promise completion is not persisted proof or retirement; closing before microtask prevents effects", async () => {
		const { owner, storage } = await fixture();
		const continuation = vi.fn(async () => {});
		const adapter = createPluginStartAdapter(owner, { validate: () => true, continueIntent: continuation });
		expect(adapter.startChat(fixed())).toBe(true);
		await flush();
		expect(catalogPluginStarts(storage).entries.find((e) => e.kind === "intent")?.state).toBe("recovery-required");
		expect(adapter.startChat({ prompt: "second" })).toBe(true);
		owner.close();
		await flush();
		expect(continuation).toHaveBeenCalledOnce();
		expect(adapter.issues()).toMatchObject([{ code: "closed" }]);
	});
});

describe("complete read/export and self-contained rollback reader", () => {
	it.each([
		"not JSON",
		'{"format":"pi-web-plugin-start","version":99}',
		'{"format":"pi-web-plugin-start","version":1,"kind":"intent"}',
	])("corrupt/unknown originals remain visible and block owner mutation: %s", async (raw) => {
		const { owner, storage, options } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		storage.values.set(rawKey("intent", owner.ownerId, "bad"), raw);
		expect(owner.checkpoint(fixed(), ids("2"))).toMatchObject({ ok: false, code: "catalogue-incomplete" });
		const catalog = catalogPluginStarts(storage);
		expect(catalog.complete).toBe(false);
		expect(catalog.entries.some((e) => e.raw === raw && !!e.issue)).toBe(true);
		const artifact = readPluginStartExport(exportPluginStarts(storage));
		expect(artifact.entries.some((e) => e.raw === raw)).toBe(true);
		expect(storage.values.get(r.identity.key)).toBe(r.identity.serialized);
		owner.close();
		await flush();
		expect(await openPluginStartCheckpoint(options)).toMatchObject({ ok: false, code: "catalogue-incomplete" });
	});
	it("foreign-owner uncertainty does not reserve the whole origin; unrelated keys untouched", async () => {
		const { owner, storage } = await fixture();
		storage.values.set("pi-web-pending:v1:legacy", "unrelated");
		storage.values.set(rawKey("intent", "foreign", "bad"), "unknown foreign original");
		accepted(owner.checkpoint(fixed(), ids()));
		expect(storage.values.get("pi-web-pending:v1:legacy")).toBe("unrelated");
		expect(catalogPluginStarts(storage).entries).toHaveLength(2);
	});
	it.each([
		["orphan raw", "corrupt"],
		["{}", "unknown"],
	])("ownerless malformed namespace key blocks writes, exports exact %s as %s", async (raw, kind) => {
		const { owner, storage } = await fixture();
		const key = PLUGIN_START_PREFIX + "unrecognized-key";
		storage.values.set(key, raw);
		expect(owner.checkpoint(fixed(), ids())).toMatchObject({ ok: false, code: "catalogue-incomplete" });
		expect(readPluginStartExport(exportPluginStarts(storage)).entries).toMatchObject([
			{ key, raw, ownerId: null, kind },
		]);
	});
	it("orphan begin/retired markers are visible rather than evidence of completion", async () => {
		const { owner, storage } = await fixture();
		const r = accepted(owner.checkpoint(fixed(), ids()));
		expect(owner.begin(r.identity).ok).toBe(true);
		storage.values.delete(r.identity.key); // Simulated external damage, never a module operation.
		const c = catalogPluginStarts(storage);
		expect(c.complete).toBe(false);
		expect(c.entries[0].issue).toBe("Orphan or mismatched lifecycle target");
	});
	it("incomplete reads/export parse errors never pretend to be an empty successful recovery", async () => {
		const { storage } = await fixture();
		vi.spyOn(storage, "key").mockImplementation(() => {
			throw new Error("denied");
		});
		storage.values.set(rawKey("intent"), "raw");
		expect(catalogPluginStarts(storage).complete).toBe(false);
		expect(readPluginStartExport(exportPluginStarts(storage)).complete).toBe(false);
		expect(readPluginStartExport("not json")).toMatchObject({ complete: false, entries: [] });
	});
	it("standalone reader embeds source safely, no installed app imports or replay handlers", () => {
		const html = createPluginStartReaderHtml('export const sentinel = "</script><script>alert(1)</script>";');
		expect(html.match(/<script/g)).toHaveLength(1);
		expect(html).toContain("textContent");
		expect(html).toContain("catalogPluginStarts");
		expect(html).toContain("exportPluginStarts");
		expect(html).not.toContain("startChat(");
		expect(html).not.toContain(".retire(");
		expect(html).not.toContain("/assets/");
	});
});
