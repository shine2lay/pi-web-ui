// roles-overview: the Roles page's client helpers still in use: the age words (roles-view-model.ts), the owner's
// form (owner-fields.ts, checked against pi-identity's own parser) and links into a chat (chat-focus.ts,
// open-chat-link.ts). No server, no port, no model.
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, parseRoleConfig } from "../../server/identity-config.js";
import { parseFocus } from "../../web/src/chat-focus.js";
import { initChatLink, takeChatFocusLink, takeChatLink, takeViewLink } from "../../web/src/open-chat-link.js";
import {
	ownerFieldsProblems,
	readOwnerFields,
	writeOwnerFields,
	type OwnerFields,
	type OwnerGoalDraft,
} from "../../web/src/owner-fields.js";
import { ageOf, agoOf } from "../../web/src/roles-view-model.js";

const NOW = Date.parse("2026-10-05T14:12:00Z"); // Mon 07:12 Pacific
const MIN = 60_000;

// ---------------------------------------------------------------------------------------------------------
describe("age words", () => {
	it("writes ages the way the design does", () => {
		expect(ageOf(NOW - 30_000, NOW)).toBe("now");
		expect(ageOf(NOW - 25 * MIN, NOW)).toBe("25m");
		expect(ageOf(NOW - 9 * 60 * MIN, NOW)).toBe("9h");
		expect(ageOf(NOW - 50 * 60 * MIN, NOW)).toBe("2d");
		expect(agoOf(NOW - 14 * MIN, NOW)).toBe("14m ago");
		expect(agoOf(NOW, NOW)).toBe("just now");
	});
});

// ---------------------------------------------------------------------------------------------------------
describe("the owner's form for how a role works and its goals", () => {
	const FILE = `{\n  "id": "backend",\n  "title": "Backend",\n  "homeChat": "/s/backend.jsonl",\n  "zeta": {"keep": true},\n  "unique": true\n}\n`;
	const goal = (over: Partial<OwnerGoalDraft> = {}): OwnerGoalDraft => ({
		name: "Speed up builds",
		scope: "the CI cache",
		approvedAt: "2026-10-04",
		endsAt: "",
		...over,
	});

	it("changes only its two fields: other keys, unknown ones, their order, the indent and the last newline stay", () => {
		const out = writeOwnerFields(FILE, { workMode: "self-start", goals: [goal({ endsAt: "2026-12-31" })] });
		expect(out.endsWith("}\n")).toBe(true);
		expect(out).toContain('\n  "id": "backend"');
		expect(Object.keys(JSON.parse(out))).toEqual(["id", "title", "homeChat", "zeta", "unique", "workMode", "goals"]);
		expect(JSON.parse(out)).toMatchObject({
			zeta: { keep: true },
			workMode: "self-start",
			goals: [{ name: "Speed up builds", scope: "the CI cache", approvedAt: "2026-10-04", endsAt: "2026-12-31" }],
		});
		// set again: the fields keep their place; null takes a field out (the rules' default applies)
		const again = writeOwnerFields(out, { workMode: "request-only", goals: null });
		expect(Object.keys(JSON.parse(again))).toEqual(["id", "title", "homeChat", "zeta", "unique", "workMode"]);
		expect(writeOwnerFields(again, { workMode: null, goals: null })).toBe(
			`${JSON.stringify(JSON.parse(FILE), null, 2)}\n`,
		);
		expect(() => writeOwnerFields("[1]", { workMode: null, goals: null })).toThrow();
		expect(readOwnerFields("{ nope")).toEqual({ ok: false, reason: "not-json" });
		expect(readOwnerFields("[]")).toEqual({ ok: false, reason: "not-object" });
		expect(readOwnerFields(out)).toMatchObject({ ok: true, fields: { workMode: "self-start" }, problems: [] });
		expect(readOwnerFields('{"workMode": "always", "goals": {}}')).toMatchObject({
			ok: true,
			fields: { workMode: null, goals: [] },
			problems: ['"workMode" is "always"', '"goals" is not a list'],
		});
	});

	it("finds what pi-identity's own parser refuses, no more and no less", () => {
		const settings = defaultSettings({ HOME: "/nonexistent-home" });
		const cases: OwnerFields[] = [
			{ workMode: "self-start", goals: [goal()] },
			{ workMode: null, goals: [] },
			{ workMode: null, goals: [goal({ name: "" })] },
			{ workMode: null, goals: [goal({ name: "x".repeat(81) })] },
			{ workMode: null, goals: [goal({ name: "x".repeat(80) })] },
			{ workMode: null, goals: [goal({ scope: "two\nlines" })] },
			{ workMode: null, goals: [goal({ scope: "s".repeat(161) })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-02-30" })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-10-04T24:00" })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-10-04T22:20:05.123+02:00" })] },
			{ workMode: null, goals: [goal({ endsAt: "2026-10-03" })] },
			{ workMode: null, goals: [goal({ endsAt: "2026-10-04" })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-10-04T22:20", endsAt: "2026-10-04" })] },
			{ workMode: null, goals: [goal(), goal({ name: "speed UP builds" })] },
			{ workMode: null, goals: Array.from({ length: 13 }, (_, i) => goal({ name: `g${i}` })) },
			{ workMode: null, goals: Array.from({ length: 12 }, (_, i) => goal({ name: `g${i}` })) },
		];
		const base = '{\n\t"id": "backend",\n\t"title": "Backend",\n\t"unique": true\n}\n';
		expect(parseRoleConfig(JSON.parse(base), settings).problems).toEqual([]);
		for (const fields of cases) {
			const text = writeOwnerFields(base, fields);
			const server = parseRoleConfig(JSON.parse(text), settings).problems;
			const client = ownerFieldsProblems(fields);
			expect(client.length > 0, `${JSON.stringify(fields)}: client ${client} / server ${server}`).toBe(
				server.length > 0,
			);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------
describe("links into a chat", () => {
	it("takes only the four kinds of item, each in its own shape", () => {
		expect(parseFocus("tldr:9f2c41aa")).toEqual({ kind: "tldr", id: "9f2c41aa" });
		expect(parseFocus("task:42")).toEqual({ kind: "task", id: "42" });
		expect(parseFocus("question:q-1.2_3")).toEqual({ kind: "question", id: "q-1.2_3" });
		expect(parseFocus("report:2026-10-04")).toEqual({ kind: "report", id: "2026-10-04" });
		for (const bad of [
			"task:x",
			"report:yesterday",
			"tool:1",
			"tldr:",
			"tldr:a/b",
			"tldr:<b>",
			null,
			undefined,
			"x".repeat(200),
		]) {
			expect(parseFocus(bad)).toBeNull();
		}
	});

	describe("the address bar", () => {
		let replaced: string[] = [];
		const setUrl = (href: string) => {
			replaced = [];
			vi.stubGlobal("window", {
				location: { href },
				history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
			});
		};
		afterEach(() => {
			vi.unstubAllGlobals();
			takeChatLink();
			takeChatFocusLink();
			takeViewLink();
		});

		it("opens a chat at an item once, and takes the link off the address bar", () => {
			setUrl("https://pi.example/?chat=%2Fs%2Fa.jsonl&focus=task%3A5&x=1");
			initChatLink();
			expect(replaced).toEqual(["https://pi.example/?x=1"]);
			expect(takeChatLink()).toBe("/s/a.jsonl");
			expect(takeChatFocusLink()).toBe("task:5");
			expect([takeChatLink(), takeChatFocusLink(), takeViewLink()]).toEqual([null, null, null]);
		});

		it("opens the Roles page (at a role), and nothing for another view or a focus without a chat", () => {
			setUrl("https://pi.example/?view=roles#r-ops");
			initChatLink();
			expect(takeViewLink()).toEqual({ view: "roles", role: "ops" });
			expect(replaced).toEqual(["https://pi.example/"]);
			setUrl("https://pi.example/?view=Roles");
			initChatLink();
			expect(takeViewLink()).toEqual({ view: "roles" });
			setUrl("https://pi.example/?view=nope#r-ops");
			initChatLink();
			expect(takeViewLink()).toBeNull();
			setUrl("https://pi.example/?focus=task%3A5");
			initChatLink();
			expect(replaced).toEqual([]);
			expect(takeChatFocusLink()).toBeNull();
		});
	});
});
