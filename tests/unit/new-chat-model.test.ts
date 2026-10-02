/**
 * new-chat-default: with a global default model set, every new chat starts on it (New chat, a role's
 * chat, a queued task's chat, a fresh chat moved to another folder), at that model's own thinking level.
 * Without one, upstream's way stays: the open chat's model carries over, then the folder's memory.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { carryOverToNewChat, freshChatModel } from "../../server/new-chat-model.js";

const OPUS = "anthropic/claude-opus-5-5";
const open = { model: { provider: "openai-codex", id: "gpt-5.6-luna" }, thinking: "low" };

describe("carryOverToNewChat", () => {
	it("takes nothing from the open chat when a global default is set", () => {
		expect(carryOverToNewChat(OPUS, open)).toEqual({ model: null, thinking: null });
	});

	it("takes the open chat's model and thinking level when there's no global default", () => {
		expect(carryOverToNewChat(undefined, open)).toEqual({ model: open.model, thinking: "low" });
		expect(carryOverToNewChat("", open)).toEqual({ model: open.model, thinking: "low" });
	});

	it("takes nothing when no chat was open", () => {
		expect(carryOverToNewChat(undefined, undefined)).toEqual({ model: null, thinking: null });
		expect(carryOverToNewChat(undefined, { model: null, thinking: null })).toEqual({ model: null, thinking: null });
	});
});

describe("freshChatModel", () => {
	it("is the global default when set, over the folder's memory", () => {
		expect(freshChatModel(OPUS, "anthropic/claude-fable-5-1")).toBe(OPUS);
		expect(freshChatModel(OPUS, undefined)).toBe(OPUS);
	});

	it("is the folder's memory without a global default", () => {
		expect(freshChatModel(undefined, "anthropic/claude-fable-5-1")).toBe("anthropic/claude-fable-5-1");
		expect(freshChatModel("", "anthropic/claude-fable-5-1")).toBe("anthropic/claude-fable-5-1");
	});

	it("is nothing when neither is set (pi's own default applies)", () => {
		expect(freshChatModel(undefined, undefined)).toBeUndefined();
		expect(freshChatModel("", "")).toBeUndefined();
	});
});

describe("the server uses these rules everywhere a chat starts", () => {
	const src = readFileSync(join(__dirname, "..", "..", "server", "agent-service.ts"), "utf8");

	it("new chats don't carry the open chat's model over when a global default is set", () => {
		expect(src).toMatch(/carryOverToNewChat\(this\.stateStore\.getDefaultModel\(\)/);
		expect(src).not.toMatch(/const prevModel = active\?\.session\.agent\.state\.model \?\? null;/);
	});

	it("a blank chat's first model and the fresh-chat fallback put the global default first", () => {
		const uses = src.match(/freshChatModel\(\s*this\.stateStore\.getDefaultModel\(\)/g) ?? [];
		expect(uses.length).toBe(2);
		expect(src).not.toMatch(/getProjectModel\([^)]*\) \?\? this\.stateStore\.getDefaultModel\(\)/);
	});
});
