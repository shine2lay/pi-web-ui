/**
 * no-plan-board (fork patch, PATCHES.md): the Task Plan Board above the message box and the AI's
 * `plan_update` tool that filled it are removed, not hidden. These checks keep them out and prove old
 * data still loads:
 *  - no chat gets the tool: it's not in the tool catalog (so Settings has no switch for it), no server
 *    file registers it or tells the AI to use it, and turning tools on for a new chat never adds it;
 *  - the page has no board: no component, no styles, and nothing reads a plan off the chat state, so a
 *    state message that still carries one shows nothing (tests/no-plan-board-test.mjs checks the live
 *    page with such a message);
 *  - saved settings that still name `plan_update` load; the name is just skipped.
 * Old chats with `plan_update` calls in their history: tests/no-plan-board-test.mjs.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import {
	AGENT_TOOL_CATALOG,
	type ActiveToolSet,
	applyAgentToolsGating,
	CORE_BUILTIN_TOOL_NAMES,
	isKnownAgentTool,
	normalizeDisabledAgentTools,
} from "../../server/tool-manager.js";

const OLD_TOOL = "plan_update";
const REPO = join(__dirname, "..", "..");

/** Every .ts/.tsx/.css file under `dir` (relative to the repo), with its text. */
function sources(dir: string): Array<{ file: string; text: string }> {
	const out: Array<{ file: string; text: string }> = [];
	const walk = (abs: string) => {
		for (const name of readdirSync(abs)) {
			if (name === "node_modules" || name === "dist") continue;
			const p = join(abs, name);
			if (statSync(p).isDirectory()) walk(p);
			else if (/\.(ts|tsx|css)$/.test(name))
				out.push({ file: p.slice(REPO.length + 1), text: readFileSync(p, "utf8") });
		}
	};
	walk(join(REPO, dir));
	return out;
}
const mentioning = (files: Array<{ file: string; text: string }>, re: RegExp) =>
	files.filter((f) => re.test(f.text)).map((f) => f.file);

/** A stand-in chat session: its registered tools and the ones turned on. */
function fakeSession(registered: string[]): ActiveToolSet & { active: string[] } {
	const s = {
		active: [...registered],
		getActiveToolNames: () => [...s.active],
		setActiveToolsByName: (names: string[]) => {
			s.active = [...names];
		},
		getAllTools: () => registered.map((name) => ({ name })),
	};
	return s;
}

describe("no-plan-board: no chat gets the plan tool", () => {
	it("the tool catalog has no plan_update, so Settings has no switch for it", () => {
		expect(AGENT_TOOL_CATALOG.some((t) => t.name === OLD_TOOL)).toBe(false);
		expect(isKnownAgentTool(OLD_TOOL)).toBe(false);
	});

	it("no server file registers the tool, keeps plans or tells the AI to use plan_update", () => {
		expect(mentioning(sources("server"), /plan_update|plan_updated|PlanManager|PlanState|PlanStep/)).toEqual([]);
	});

	it("turning tools on for a new chat never adds plan_update, even with an old off-list naming it", () => {
		const registered = [...CORE_BUILTIN_TOOL_NAMES, ...AGENT_TOOL_CATALOG.map((t) => t.name)];
		for (const disabled of [[], [OLD_TOOL], [OLD_TOOL, "eval"]]) {
			const session = fakeSession(registered);
			applyAgentToolsGating(session, disabled);
			expect(session.active).not.toContain(OLD_TOOL);
			expect(session.active).toContain("bash");
		}
	});
});

describe("no-plan-board: the page has no board", () => {
	const web = sources(join("web", "src"));

	it("there is no board component, mount or style", () => {
		expect(existsSync(join(REPO, "web", "src", "components", "PlanBoard.tsx"))).toBe(false);
		expect(mentioning(web, /PlanBoard|plan-board|planBoard|planUpdate|plan_update/)).toEqual([]);
	});

	it("nothing on the page reads a plan off the chat state, so a state carrying one shows nothing", () => {
		expect(mentioning(web, /state\??\.plan\b|\bplan_updated\b/)).toEqual([]);
	});
});

describe("no-plan-board: saved settings naming plan_update still load", () => {
	let dir = "";
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("an off-list naming plan_update loads, with that name skipped and the rest kept", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-no-plan-board-"));
		const file = join(dir, "client-state.json");
		const saved = `${JSON.stringify(
			{
				__settings__: { projects: [], settings: { disabledAgentTools: [OLD_TOOL, "eval", "lsp"], thinkingWrap: true } },
			},
			null,
			2,
		)}\n`;
		writeFileSync(file, saved);

		const settings = new ClientStateStore(file).getSettings("any-client");
		expect(settings.disabledAgentTools).toEqual(["eval", "lsp"]);
		expect(settings.thinkingWrap).toBe(true);
		// Loading leaves the saved file as it was.
		expect(readFileSync(file, "utf8")).toBe(saved);
	});

	it("a saved preset's off-list naming plan_update is skipped the same way", () => {
		expect(normalizeDisabledAgentTools([OLD_TOOL])).toEqual([]);
		expect(normalizeDisabledAgentTools(["bash", OLD_TOOL, "claim_files"])).toEqual(["bash", "claim_files"]);
	});
});
