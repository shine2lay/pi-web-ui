import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyLeadThinking,
	configureLeadThinking,
	initializeLeadThinking,
	leadThinking,
	leadThinkingControl,
	rememberLeadThinkingInitialization,
	rememberLeadThinkingOwner,
} from "../../server/lead-thinking.js";

describe("lead-thinking", () => {
	let dir: string;
	let file: string;
	let entries: unknown[];
	let levels: string[];
	let session: AgentSession;
	let changed: ReturnType<typeof vi.fn<(session: AgentSession) => void>>;
	let homes: { id: string; homeChat: string | null }[];
	let native: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lead-thinking-"));
		file = join(dir, "lead-thinking.json");
		entries = [{ type: "model_change", id: "initial" }];
		levels = ["off", "low", "medium", "high"];
		changed = vi.fn<(session: AgentSession) => void>();
		native = vi.fn(() => {
			throw new Error("native setter forbidden");
		});
		const state = { thinkingLevel: "medium" };
		session = {
			sessionId: "sid",
			agent: { state },
			get thinkingLevel() {
				return state.thinkingLevel;
			},
			model: { provider: "fixture", id: "model" },
			getAvailableThinkingLevels: () => levels,
			setThinkingLevel: native,
			sessionManager: { getSessionFile: () => join(dir, "home.jsonl"), getBranch: () => entries },
		} as unknown as AgentSession;
		homes = [{ id: "coo", homeChat: join(dir, "home.jsonl") }];
		configureLeadThinking({ file, homes: () => homes, session: () => session, changed });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const setDefault = () =>
		leadThinkingControl({ type: "lead_thinking_control", requestId: "default", action: "default", level: "high" });
	it("starts disabled and does not create configuration", () => {
		expect(leadThinking("sid").level).toBeUndefined();
		initializeLeadThinking(session);
		expect(session.thinkingLevel).toBe("medium");
		expect(existsSync(file)).toBe(false);
	});
	it("applies persisted default using only public runtime state", () => {
		expect(setDefault().ok).toBe(true);
		const stored = readFileSync(file, "utf8");
		const branch = JSON.stringify(entries);
		const model = session.model;
		initializeLeadThinking(session);
		expect(session.thinkingLevel).toBe("high");
		expect(native).not.toHaveBeenCalled();
		expect(changed).toHaveBeenCalledWith(session);
		expect(session.model).toBe(model);
		expect(JSON.stringify(entries)).toBe(branch);
		expect(readFileSync(file, "utf8")).toBe(stored);
	});
	it("preserves ambiguous historical choices without synthetic owner provenance", () => {
		entries.push({
			type: "thinking_level_change",
			id: "old",
			get thinkingLevel() {
				throw new Error("content read");
			},
		});
		setDefault();
		expect(leadThinking("sid")).toEqual({
			level: "medium",
			source: "historical",
			reason: "Unlabelled thinking history is protected",
		});
		initializeLeadThinking(session);
		expect(session.thinkingLevel).toBe("medium");
		expect(JSON.parse(readFileSync(file, "utf8")).owners).toEqual({});
	});
	it("does not infer intent from a blank new home", () => {
		entries = [];
		setDefault();
		expect(leadThinking("sid").source).toBe("unconfirmed-baseline");
		initializeLeadThinking(session);
		expect(session.thinkingLevel).toBe("medium");
	});
	it("protects an explicit off choice across default changes and reconfiguration", () => {
		rememberLeadThinkingOwner(session, "off");
		setDefault();
		configureLeadThinking({ file, homes: () => homes, session: () => session, changed });
		expect(leadThinking("sid")).toEqual({ level: "off", source: "owner" });
		initializeLeadThinking(session);
		expect(session.thinkingLevel).toBe("off");
	});
	it("persists fresh initialization metadata and protects later unknown thinking events", () => {
		entries.push({ type: "thinking_level_change", id: "initial-thinking" });
		rememberLeadThinkingInitialization(session);
		setDefault();
		configureLeadThinking({ file, homes: () => homes, session: () => session, changed });
		expect(leadThinking("sid")).toEqual({ level: "high", source: "default" });
		entries.push({ type: "thinking_level_change", id: "later" });
		expect(leadThinking("sid").source).toBe("historical");
		rememberLeadThinkingOwner(session, "off");
		entries.push({ type: "thinking_level_change", id: "after-owner" });
		expect(leadThinking("sid").source).toBe("historical");
	});
	it("records creation baseline without touching worker runtime", () => {
		entries.push({ type: "custom", customType: "queue", data: { op: "assigned" } });
		rememberLeadThinkingInitialization(session);
		expect(session.thinkingLevel).toBe("medium");
		expect(changed).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
	});
	it("advances only a consumed routing decision marker after a model transition", () => {
		setDefault();
		const decision = leadThinking("sid");
		Object.defineProperty(session, "model", { value: { provider: "fixture", id: "routed" }, configurable: true });
		entries.push({ type: "model_change", id: "routed-model", provider: "fixture", modelId: "routed" });
		entries.push({ type: "thinking_level_change", id: "route-generated" });
		applyLeadThinking("sid", decision.level!);
		expect(leadThinking("sid").source).toBe("default");
		expect(JSON.parse(readFileSync(file, "utf8")).owners).toEqual({});
		entries.push({ type: "thinking_level_change", id: "unknown" });
		expect(leadThinking("sid").source).toBe("historical");
	});
	it("protects unattributed thinking changes while a decision is pending on the same model", () => {
		setDefault();
		leadThinking("sid");
		entries.push({ type: "thinking_level_change", id: "unattributed" });
		session.agent.state.thinkingLevel = "low";
		expect(applyLeadThinking("sid", "high")).toMatchObject({ source: "historical", level: "low" });
		expect(session.thinkingLevel).toBe("low");
		expect(changed).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(file, "utf8")).initializations).toEqual({});
	});
	it.each(["missing-model", "wrong-model", "extra-thinking", "extra-entry", "changed-prefix"])(
		"protects new thinking history after a model switch with %s metadata",
		(shape) => {
			setDefault();
			leadThinking("sid");
			Object.defineProperty(session, "model", { value: { provider: "fixture", id: "routed" } });
			if (shape !== "missing-model")
				entries.push({
					type: "model_change",
					id: "route-model",
					provider: "fixture",
					modelId: shape === "wrong-model" ? "other" : "routed",
				});
			entries.push({ type: "thinking_level_change", id: "route-thinking" });
			if (shape === "extra-thinking") entries.push({ type: "thinking_level_change", id: "unknown" });
			if (shape === "extra-entry") entries.push({ type: "custom", id: "unknown" });
			if (shape === "changed-prefix") entries[0] = { type: "model_change", id: "different-branch" };
			session.agent.state.thinkingLevel = "low";
			expect(applyLeadThinking("sid", "high")).toMatchObject({ source: "historical", level: "low" });
			expect(session.thinkingLevel).toBe("low");
			expect(changed).not.toHaveBeenCalled();
			expect(JSON.parse(readFileSync(file, "utf8")).initializations).toEqual({});
		},
	);
	it("rejects workers even when accidentally registered as homes", () => {
		entries.push({ type: "custom", customType: "queue", data: { op: "assigned" } });
		setDefault();
		expect(leadThinking("sid").source).toBe("ineligible");
		expect(applyLeadThinking("sid", "high").level).toBeUndefined();
		expect(session.thinkingLevel).toBe("medium");
	});
	it("rejects wrong ids, nonhomes, and mismatched loaded files", () => {
		expect(applyLeadThinking("other", "high").level).toBeUndefined();
		homes[0].homeChat = join(dir, "other.jsonl");
		expect(applyLeadThinking("sid", "high").level).toBeUndefined();
		homes = [];
		expect(leadThinking("sid").source).toBe("ineligible");
	});
	it("reports unsupported levels without clamping, config writes, or runtime changes", () => {
		setDefault();
		leadThinking("sid");
		levels = ["off"];
		const before = readFileSync(file, "utf8");
		expect(applyLeadThinking("sid", "high").source).toBe("unsupported");
		expect(leadThinking("sid").source).toBe("unsupported");
		expect(session.thinkingLevel).toBe("medium");
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(changed).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
	});
	it("requires exact role and sid for owner control and persists only the selected home", () => {
		const request = {
			type: "lead_thinking_control" as const,
			requestId: "set",
			action: "set" as const,
			role: "coo",
			sessionId: "sid",
			level: "high",
		};
		expect(leadThinkingControl({ ...request, sessionId: "wrong" }).ok).toBe(false);
		expect(leadThinkingControl({ ...request, role: undefined }).ok).toBe(false);
		expect(existsSync(file)).toBe(false);
		expect(leadThinkingControl(request).ok).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8")).owners).toEqual({
			sid: { level: "high", source: "owner", entryId: null },
		});
		expect(session.thinkingLevel).toBe("high");
		expect(
			leadThinkingControl({ type: "lead_thinking_control", requestId: "get", action: "get", role: "coo" }),
		).toMatchObject({ ok: true, sessionId: "sid", effective: "high", model: "fixture/model" });
	});
	it("ignores standard picker metadata for ordinary chats and workers", () => {
		homes = [];
		expect(() => rememberLeadThinkingOwner(session, "low")).not.toThrow();
		homes = [{ id: "coo", homeChat: join(dir, "home.jsonl") }];
		entries.push({ type: "custom", customType: "queue", data: { op: "assigned" } });
		expect(() => rememberLeadThinkingOwner(session, "low")).not.toThrow();
		expect(existsSync(file)).toBe(false);
	});
	it("rejects an issued decision invalidated by an explicit owner control", () => {
		setDefault();
		leadThinking("sid");
		expect(
			leadThinkingControl({
				type: "lead_thinking_control",
				requestId: "owner",
				action: "set",
				role: "coo",
				sessionId: "sid",
				level: "off",
			}).ok,
		).toBe(true);
		expect(applyLeadThinking("sid", "high").source).toBe("stale");
		expect(session.thinkingLevel).toBe("off");
	});
	it("resolves fresh after concurrent persisted owner changes instead of applying a stale default", () => {
		setDefault();
		leadThinking("sid");
		const store = JSON.parse(readFileSync(file, "utf8"));
		store.owners.sid = { level: "off", source: "owner", entryId: null };
		writeFileSync(file, JSON.stringify(store));
		expect(applyLeadThinking("sid", "high")).toEqual({ level: "off", source: "owner" });
		expect(session.thinkingLevel).toBe("off");
		expect(JSON.parse(readFileSync(file, "utf8")).initializations).toEqual({});
	});
	it("requires a matching single-use decision and rejects models absent at apply time", () => {
		setDefault();
		leadThinking("sid");
		expect(applyLeadThinking("sid", "low").source).toBe("stale");
		leadThinking("sid");
		Object.defineProperty(session, "model", { value: undefined });
		expect(applyLeadThinking("sid", "high").source).toBe("unsupported");
		expect(leadThinking("sid").source).toBe("unsupported");
		expect(session.thinkingLevel).toBe("medium");
	});
	it("preserves birth markers captured before host configuration", async () => {
		vi.resetModules();
		const fresh = await import("../../server/lead-thinking.js");
		entries.push({ type: "thinking_level_change", id: "birth" });
		expect(() => fresh.initializeLeadThinking(session)).not.toThrow();
		fresh.rememberLeadThinkingInitialization(session);
		entries.push({ type: "thinking_level_change", id: "after-birth" });
		fresh.configureLeadThinking({ file, homes: () => homes, session: () => session, changed });
		expect(JSON.parse(readFileSync(file, "utf8")).initializations.sid).toBe("birth");
		expect(fresh.leadThinking("sid").source).toBe("historical");
		expect(changed).not.toHaveBeenCalled();
	});
	it("rejects malformed configuration loudly and never repairs or overwrites it", () => {
		for (const raw of [
			"{",
			'{"version":1,"defaultLevel":"low","owners":{}}',
			'{"version":1,"defaultLevel":null,"owners":{},"extra":true}',
		]) {
			writeFileSync(file, raw);
			expect(() => leadThinking("sid")).toThrow();
			expect(setDefault().ok).toBe(false);
			expect(readFileSync(file, "utf8")).toBe(raw);
		}
	});
	it("accepts only High or disabled default and queue application never persists", () => {
		expect(
			leadThinkingControl({ type: "lead_thinking_control", requestId: "bad", action: "default", level: "low" }).ok,
		).toBe(false);
		expect(applyLeadThinking("sid", "low").source).toBe("stale");
		expect(existsSync(file)).toBe(false);
		setDefault();
		expect(
			leadThinkingControl({ type: "lead_thinking_control", requestId: "off", action: "default", level: null })
				.defaultLevel,
		).toBeNull();
		expect(native).not.toHaveBeenCalled();
	});
});
