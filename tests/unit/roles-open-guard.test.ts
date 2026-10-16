// roles-needs-you: a chat the Roles page opens is never named by its file, and a failed open shows
// fixed words (Security addendum for Ops #200, item 6).
import { afterEach, describe, expect, it } from "vitest";
import { isRolesOpen, markRolesOpen, resetRolesOpen, ROLES_OPEN_FAILED } from "../../web/src/roles-open-guard";
import { switchTargetTitle } from "../../web/src/switch-pending";

const FILE = "/home/u/.pi/agent/sessions/--w--/2026-10-15T12-00-01-000Z_01a0f000.jsonl";

afterEach(() => resetRolesOpen());

describe("roles open guard", () => {
	it("knows only the chats the Roles page asked to open", () => {
		expect(isRolesOpen({ kind: "session", path: FILE })).toBe(false);
		markRolesOpen(FILE);
		expect(isRolesOpen({ kind: "session", path: FILE })).toBe(true);
		expect(isRolesOpen({ kind: "session", path: FILE.replace(/\//g, "\\") })).toBe(true);
		expect(isRolesOpen({ kind: "session", path: `${FILE}.other` })).toBe(false);
		expect(isRolesOpen({ kind: "conversation", id: FILE })).toBe(false);
		expect(isRolesOpen(null)).toBe(false);
		expect(isRolesOpen(undefined)).toBe(false);
	});

	it("keeps the last 32 and forgets the oldest", () => {
		for (let i = 0; i < 33; i++) markRolesOpen(`/s/${i}.jsonl`);
		expect(isRolesOpen({ kind: "session", path: "/s/0.jsonl" })).toBe(false);
		expect(isRolesOpen({ kind: "session", path: "/s/1.jsonl" })).toBe(true);
		expect(isRolesOpen({ kind: "session", path: "/s/32.jsonl" })).toBe(true);
		// Opening one again moves it to the newest place instead of adding a copy.
		markRolesOpen("/s/1.jsonl");
		markRolesOpen("/s/33.jsonl");
		expect(isRolesOpen({ kind: "session", path: "/s/1.jsonl" })).toBe(true);
		expect(isRolesOpen({ kind: "session", path: "/s/2.jsonl" })).toBe(false);
	});

	it("the failure words quote no path", () => {
		expect(ROLES_OPEN_FAILED).not.toMatch(/[/\\]|jsonl/);
	});
});

describe("switch overlay title", () => {
	const target = { kind: "session" as const, path: FILE };

	it("uses the given words instead of the file's name when the lists don't know the chat", () => {
		expect(switchTargetTitle(target, [], [])).toBe("2026-10-15T12-00-01-000Z_01a0f000.jsonl");
		expect(switchTargetTitle(target, [], [], "this chat")).toBe("this chat");
		expect(switchTargetTitle(target, [{ path: FILE, name: "", firstMessage: "" }], [], "this chat")).toBe("this chat");
	});

	it("still uses the chat's own name, first message or running title when there is one", () => {
		expect(switchTargetTitle(target, [{ path: FILE, name: "Queue #1" }], [], "this chat")).toBe("Queue #1");
		expect(switchTargetTitle(target, [{ path: FILE, firstMessage: "hello there" }], [], "this chat")).toBe(
			"hello there",
		);
		expect(switchTargetTitle(target, [], [{ id: "c1", title: "Running", sessionPath: FILE }], "this chat")).toBe(
			"Running",
		);
	});
});
