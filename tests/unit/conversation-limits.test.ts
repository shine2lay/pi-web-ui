import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_OPEN_CONVERSATIONS } from "../../server/conversation-limits.js";

describe("company-team-capacity", () => {
	it("allows forty open regular chats without changing task concurrency (chat-slots, owner 2026-10-19)", () => {
		expect(MAX_OPEN_CONVERSATIONS).toBe(40);
	});

	it.each([
		["pi", "../../server/agent-service.ts", "./conversation-limits.js"],
		["DSH", "../../server/dsh/dsh-agent-service.ts", "../conversation-limits.js"],
	])("%s uses the shared cap at its existing admission gates", (_engine, path, module) => {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		expect(source.includes(`import { MAX_OPEN_CONVERSATIONS } from "${module}";`)).toBe(true);
		expect(/\bconst\s+MAX_OPEN_CONVERSATIONS\b/.test(source)).toBe(false);
		expect(source.includes("openInProject >= MAX_OPEN_CONVERSATIONS")).toBe(true);
		// chat-slots: one message wherever a chat is refused, and blank chats don't take a slot.
		expect(source.includes("OPEN_CHATS_FULL_MESSAGE")).toBe(true);
		expect(source.includes("countsTowardCap")).toBe(true);
		expect(source.includes("already has the max open")).toBe(false);
	});
});
