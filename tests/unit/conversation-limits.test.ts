import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_OPEN_CONVERSATIONS } from "../../server/conversation-limits.js";

describe("company-team-capacity", () => {
	it("allows sixteen open regular chats without changing task concurrency", () => {
		expect(MAX_OPEN_CONVERSATIONS).toBe(16);
	});

	it.each([
		["pi", "../../server/agent-service.ts", "./conversation-limits.js"],
		["DSH", "../../server/dsh/dsh-agent-service.ts", "../conversation-limits.js"],
	])("%s uses the shared cap at its existing admission gates", (_engine, path, module) => {
		const source = readFileSync(new URL(path, import.meta.url), "utf8");
		expect(source.includes(`import { MAX_OPEN_CONVERSATIONS } from "${module}";`)).toBe(true);
		expect(/\bconst\s+MAX_OPEN_CONVERSATIONS\b/.test(source)).toBe(false);
		expect(source.includes("openInProject >= MAX_OPEN_CONVERSATIONS")).toBe(true);
	});
});
