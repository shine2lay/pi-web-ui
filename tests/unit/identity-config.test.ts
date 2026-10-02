/**
 * identity-config: unit tests.
 *
 * - server/identity-config.ts is pi-identity's config.ts byte for byte (when that checkout is on this
 *   machine: PI_IDENTITY_SRC, else ~/projects/pi-identity), so Settings refuses what pi-identity refuses;
 * - a role's row: its prompt, its skills (its own and the shared ones it opts into), its tool limits,
 *   `unique`, and what's left out of a broken identity.json (also logged once, when it shows up);
 * - the shared settings file: the notebook cap comes from it, a bad field is reported;
 * - Settings' saves: identity.json refused with its reasons unless pi-identity reads every part of it
 *   (the file stays as it was), the prompt (the file identity.json names) with its own cap;
 * - drafts: listed, read, saved against their hash, accepted (an app save: the prompt into the role's
 *   prompt file, the old one archived, the settings merged into identity.json, the draft kept in .old/),
 *   refused (bad settings, an older read), discarded;
 * - the page's draft store, and the row's render.
 *
 * No model and no port: the production functions, a temp pi folder and a fake sender.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	identityInfos,
	identityRegistry,
	readIdentityFile,
	saveIdentityFile,
	textHash,
} from "../../server/identities.js";
import { PROMPT_MAX } from "../../server/identity-config.js";
import {
	acceptDraft,
	checkConfigText,
	discardDraft,
	draftIds,
	readDraft,
	saveDraft,
} from "../../server/identity-roles.js";
import type { UiIdentityInfo } from "../../server/protocol.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { IdentitiesSettings } from "../../web/src/components/IdentitiesSettings.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import {
	closeIdentityDraft,
	getIdentityDraft,
	openIdentityDraft,
	receiveIdentities,
	receiveIdentityDraft,
	receiveIdentityDraftDone,
	resetIdentityState,
	sendIdentityDraftAction,
} from "../../web/src/identity-state.js";

let root: string;
let agent: string;
let idDir: string;
let drafts: string;
const ENV_KEYS = ["PI_IDENTITY_DIR", "PI_MEMORY_DIR", "PI_CODING_AGENT_DIR", "PI_ROLE_DRAFTS_DIR"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const skillText = (name: string, description: string) =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n`;

function writeRole(id: string, config: Record<string, unknown>, files: Record<string, string> = {}) {
	const d = join(idDir, id);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "identity.json"), `${JSON.stringify({ id, ...config }, null, "\t")}\n`);
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(d, name, ".."), { recursive: true });
		writeFileSync(join(d, name), text);
	}
}

function writeDraft(id: string, files: { prompt?: string; config?: string; notes?: string }) {
	const d = join(drafts, id);
	mkdirSync(d, { recursive: true });
	if (files.prompt !== undefined) writeFileSync(join(d, "prompt.md"), files.prompt);
	if (files.config !== undefined) writeFileSync(join(d, "config.json"), files.config);
	if (files.notes !== undefined) writeFileSync(join(d, "notes.md"), files.notes);
}

const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");
const PROMPT = "You are alpha. You work in small steps.\n";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "identity-config-"));
	agent = join(root, "agent");
	idDir = join(root, "memory", "identities");
	drafts = join(root, "memory", "role-drafts");
	mkdirSync(agent, { recursive: true });
	mkdirSync(idDir, { recursive: true });
	process.env.PI_IDENTITY_DIR = idDir;
	process.env.PI_MEMORY_DIR = join(root, "memory");
	process.env.PI_CODING_AGENT_DIR = agent;
	delete process.env.PI_ROLE_DRAFTS_DIR;
	mkdirSync(join(agent, "role-skills", "team-skill"), { recursive: true });
	writeFileSync(join(agent, "role-skills", "team-skill", "SKILL.md"), skillText("team-skill", "How the team works."));
	writeRole(
		"alpha",
		{
			title: "Alpha",
			homeChat: "/s/alpha-home.jsonl",
			skills: { own: true, shared: ["team-skill"] },
			tools: { deny: ["bash", "subagents"] },
			unique: true,
		},
		{
			"about.md": "About alpha\n",
			"prompt.md": PROMPT,
			"skills/own-skill/SKILL.md": skillText("own-skill", "A how-to alpha wrote."),
		},
	);
	writeRole("beta", { title: "Beta" });
	identityRegistry(true);
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	rmSync(root, { recursive: true, force: true });
	setAppSend(null);
	resetIdentityState();
	vi.restoreAllMocks();
});

const infos = () => {
	const reg = identityRegistry(true);
	return identityInfos(reg.identities, reg.settings, { dir: reg.draftsDir, ids: reg.drafts });
};
const info = (id: string) => infos().find((i) => i.id === id);

describe("the rules are pi-identity's own", () => {
	const realHome = (() => {
		try {
			return userInfo().homedir;
		} catch {
			return "";
		}
	})();
	const source = [process.env.PI_IDENTITY_SRC, realHome ? join(realHome, "projects", "pi-identity") : ""]
		.filter((d): d is string => !!d)
		.map((d) => join(d, "config.ts"))
		.find((f) => existsSync(f));

	it.skipIf(!source)("server/identity-config.ts is pi-identity's config.ts, byte for byte", () => {
		const here = readFileSync(join(import.meta.dirname, "..", "..", "server", "identity-config.ts"));
		expect(here.equals(readFileSync(source!)), `copy ${source} over server/identity-config.ts`).toBe(true);
	});
});

describe("a role's row in Settings", () => {
	it("its prompt, its skills (its own and the shared ones it opts into), its tool limits and unique", () => {
		const alpha = info("alpha");
		expect(alpha).toMatchObject({
			id: "alpha",
			title: "Alpha",
			promptFile: "prompt.md",
			promptSize: Buffer.byteLength(PROMPT),
			toolLimits: "deny bash, subagents",
			unique: true,
			configProblems: [],
		});
		expect(alpha?.skills?.map((s) => [s.name, s.shared, s.description])).toEqual([
			["own-skill", false, "A how-to alpha wrote."],
			["team-skill", true, "How the team works."],
		]);
		expect(alpha?.promptOff).toBeUndefined();
		expect(alpha?.draft).toBeUndefined();
	});

	it("a role with no settings: no prompt, no skills, no limits, nothing wrong", () => {
		const beta = info("beta");
		expect(beta).toMatchObject({
			promptFile: "prompt.md",
			promptSize: 0,
			skills: [],
			toolLimits: "none",
			configProblems: [],
		});
		expect(beta?.unique).toBeUndefined();
	});

	it("skills.own false leaves its own folder out; prompt null switches the prompt off", () => {
		writeRole(
			"gamma",
			{ title: "Gamma", prompt: null, skills: { own: false } },
			{ "prompt.md": "unused\n", "skills/x/SKILL.md": skillText("x", "An own skill.") },
		);
		expect(info("gamma")).toMatchObject({ promptOff: true, skills: [], configProblems: [] });
	});

	it("a broken part is refused with its reason and left out; the role still loads, and each reason is logged once", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		writeRole("gamma", {
			title: "Gamma",
			colour: "red",
			tools: { deny: "bash", block: ["web"] },
			skills: { shared: ["missing-one"] },
			unique: "yes",
			prompt: "notes.md",
		});
		const gamma = info("gamma");
		expect(gamma?.title).toBe("Gamma");
		expect(gamma?.toolLimits).toBe("none");
		expect(gamma?.unique).toBeUndefined();
		const problems = gamma?.configProblems?.join("\n") ?? "";
		expect(problems).toContain('unknown field "colour"');
		expect(problems).toContain('"tools.deny" must be a list of tool names');
		expect(problems).toContain('unknown field "tools.block" (known: allow, deny)');
		expect(problems).toContain('"unique" must be true or false');
		expect(problems).toContain('shared skill "missing-one" isn\'t in');
		expect(problems).toContain("its prompt file notes.md isn't in the role's folder");
		const logged = log.mock.calls.map((c) => String(c[0]));
		expect(logged).toContain(
			`[identities] gamma's settings: unknown field "colour" (known: id, title, folder, homeChat, pastHomeChats, prompt, skills, tools, unique)`,
		);
		const before = log.mock.calls.length;
		identityRegistry(true);
		expect(log.mock.calls.length).toBe(before);
		// The other roles are unaffected.
		expect(info("alpha")?.configProblems).toEqual([]);
	});
});

describe("the shared settings file", () => {
	it("a missing file means the defaults", () => {
		const reg = identityRegistry(true);
		expect(reg.settings).toMatchObject({ notebookCap: 8000, tidyAt: 6000, roleSkillsDir: join(agent, "role-skills") });
		expect(reg.settings.toolGroups.shell).toContain("bash");
		expect(reg.problems).toEqual([]);
	});

	it("the notebook cap comes from it (list, read, save); a bad field is reported and keeps its default", () => {
		writeFileSync(join(agent, "pi-identity.json"), JSON.stringify({ notebookCap: 9000, tidyAt: "soon", colour: 1 }));
		const reg = identityRegistry(true);
		expect(reg.settings.notebookCap).toBe(9000);
		expect(reg.settings.tidyAt).toBe(6000);
		expect(reg.problems.join("\n")).toMatch(/pi-identity\.json.*tidyAt/);
		expect(reg.problems.join("\n")).toContain("colour");
		expect(info("alpha")?.notebookCap).toBe(9000);
		expect(readIdentityFile(reg.identities, "alpha", "notebook", reg.settings)).toMatchObject({ cap: 9000 });
		const base = textHash("");
		expect(
			saveIdentityFile(
				reg.identities,
				"alpha",
				"notebook",
				"x".repeat(9001),
				base,
				process.env,
				new Date(),
				reg.settings,
			),
		).toEqual({
			ok: false,
			code: "over_cap",
		});
		expect(
			saveIdentityFile(
				reg.identities,
				"alpha",
				"notebook",
				"x".repeat(8500),
				base,
				process.env,
				new Date(),
				reg.settings,
			),
		).toMatchObject({
			ok: true,
		});
	});

	it("its tool groups and its shared skills folder are used by every role", () => {
		mkdirSync(join(root, "elsewhere", "ext-skill"), { recursive: true });
		writeFileSync(join(root, "elsewhere", "ext-skill", "SKILL.md"), skillText("ext-skill", "Kept elsewhere."));
		writeFileSync(
			join(agent, "pi-identity.json"),
			JSON.stringify({ toolGroups: { risky: ["bash", "browser_*"] }, roleSkillsDir: join(root, "elsewhere") }),
		);
		writeRole("gamma", { tools: { deny: ["risky"] }, skills: { shared: ["ext-skill"] } });
		const gamma = info("gamma");
		expect(gamma?.configProblems).toEqual([]);
		expect(gamma?.skills?.map((s) => s.name)).toEqual(["ext-skill"]);
		// alpha's shared skill isn't in the new folder: left out, and said so.
		expect(info("alpha")?.configProblems?.join("\n")).toContain('shared skill "team-skill"');
	});
});

describe("Settings saves a role's settings and prompt", () => {
	const configPath = () => join(idDir, "alpha", "identity.json");

	it("refuses an identity.json pi-identity wouldn't read, says why, and leaves the file alone", () => {
		const reg = identityRegistry(true);
		const before = read(configPath());
		const base = textHash(before);
		const save = (text: string) =>
			saveIdentityFile(reg.identities, "alpha", "config", text, base, process.env, new Date(), reg.settings);

		const bad = save(
			JSON.stringify({ id: "alpha", title: "Alpha", tools: { deny: ["bash"], allow: "all" }, colour: 1 }),
		);
		expect(bad).toMatchObject({ ok: false, code: "invalid" });
		const problems = (bad as { problems: string[] }).problems.join("\n");
		expect(problems).toContain('"tools.allow" must be a list of tool names');
		expect(problems).toContain('unknown field "colour"');
		expect(save("{ not json")).toMatchObject({ ok: false, code: "invalid" });
		expect((save("{ not json") as { problems: string[] }).problems[0]).toContain("isn't valid JSON");
		expect((save("[1, 2]") as { problems: string[] }).problems[0]).toContain("must hold one JSON object");
		expect((save(JSON.stringify({ id: "renamed" })) as { problems: string[] }).problems[0]).toContain(
			'"id" must stay "alpha"',
		);
		expect((save(JSON.stringify({ id: "alpha", prompt: "gone.md" })) as { problems: string[] }).problems[0]).toContain(
			"its prompt file gone.md isn't in the role's folder",
		);
		expect(textHash(read(configPath()))).toBe(base);

		const good = `${JSON.stringify({ id: "alpha", title: "Alpha", tools: { allow: ["read", "edit"] } }, null, "\t")}\n`;
		expect(save(good)).toMatchObject({ ok: true, hash: textHash(good) });
		expect(read(configPath())).toBe(good);
		expect(info("alpha")?.toolLimits).toBe(
			"allow read, edit (and always notebook, tldr, queue_done, queue_stuck, queue_wait)",
		);
	});

	it("checks the same way without saving (the editor's check)", () => {
		const reg = identityRegistry(true);
		const dir = join(idDir, "alpha");
		expect(checkConfigText(JSON.stringify({ id: "alpha", unique: false }), "alpha", dir, reg.settings)).toMatchObject({
			ok: true,
		});
		expect(
			checkConfigText(JSON.stringify({ skills: { shared: ["Not A Name"] } }), "alpha", dir, reg.settings),
		).toMatchObject({
			ok: false,
		});
	});

	it("the prompt is the file identity.json names, with its own cap", () => {
		writeRole("gamma", { prompt: "role.md" }, { "role.md": "Gamma's prompt\n" });
		const reg = identityRegistry(true);
		expect(readIdentityFile(reg.identities, "gamma", "prompt", reg.settings)).toMatchObject({
			ok: true,
			text: "Gamma's prompt\n",
			cap: PROMPT_MAX,
		});
		expect(info("gamma")).toMatchObject({ promptFile: "role.md", promptSize: 15 });
		const base = textHash("Gamma's prompt\n");
		const save = (text: string) =>
			saveIdentityFile(reg.identities, "gamma", "prompt", text, base, process.env, new Date(), reg.settings);
		expect(save("x".repeat(PROMPT_MAX + 1))).toEqual({ ok: false, code: "too_big" });
		expect(save("Better prompt\n")).toMatchObject({ ok: true });
		expect(read(idDir, "gamma", "role.md")).toBe("Better prompt\n");
		expect(existsSync(join(idDir, "gamma", "prompt.md"))).toBe(false);
		// A role with no prompt yet gets its first one in prompt.md.
		expect(
			saveIdentityFile(reg.identities, "beta", "prompt", "Beta\n", textHash(""), process.env, new Date(), reg.settings),
		).toMatchObject({
			ok: true,
		});
		expect(read(idDir, "beta", "prompt.md")).toBe("Beta\n");
	});
});

describe("drafts waiting for the owner", () => {
	const draftPrompt = "You are alpha, improved.\n";
	const draftConfig = `${JSON.stringify({ tools: { deny: ["browser"] }, skills: { shared: ["team-skill"] } }, null, "\t")}\n`;
	beforeEach(() => {
		writeDraft("alpha", { prompt: draftPrompt, config: draftConfig, notes: "- deny browser: it never needs one\n" });
	});

	it("listed on the role's row (its prompt's size and the fields it sets); a draft for no role is a problem", () => {
		mkdirSync(join(drafts, ".old", "alpha-old"), { recursive: true });
		writeDraft("nobody", { prompt: "x\n" });
		expect(draftIds(drafts)).toEqual(["alpha", "nobody"]);
		expect(info("alpha")?.draft).toEqual({ promptSize: Buffer.byteLength(draftPrompt), fields: ["tools", "skills"] });
		expect(info("beta")?.draft).toBeUndefined();
		expect(identityRegistry(true).problems).toContain("role-drafts/nobody: a draft for a role that doesn't exist");
	});

	it("read with one hash over its files; a save from an older read is refused, a fresh one kept", () => {
		const d = readDraft(drafts, "alpha");
		expect(d).toMatchObject({
			prompt: draftPrompt,
			config: draftConfig,
			notes: "- deny browser: it never needs one\n",
		});
		expect(readDraft(drafts, "beta")).toBeNull();
		expect(readDraft(drafts, "../identities")).toBeNull();
		expect(saveDraft(drafts, "alpha", "edited\n", draftConfig, textHash("old"))).toEqual({
			ok: false,
			code: "changed",
		});
		const saved = saveDraft(drafts, "alpha", "edited\n", draftConfig, d!.hash);
		expect(saved).toMatchObject({ ok: true });
		expect(read(drafts, "alpha", "prompt.md")).toBe("edited\n");
		expect(readDraft(drafts, "alpha")?.hash).toBe((saved as { hash: string }).hash);
		// A draft stays a draft: nothing in the role's folder changed.
		expect(read(idDir, "alpha", "prompt.md")).toBe(PROMPT);
	});

	it("accepting writes the prompt and the settings into the role's folder, keeps the old prompt, and retires the draft", () => {
		const reg = identityRegistry(true);
		const def = reg.identities.find((i) => i.id === "alpha")!;
		const d = readDraft(drafts, "alpha")!;
		const now = new Date(2026, 9, 2, 10, 30, 0);
		const r = acceptDraft(
			{ id: "alpha", dir: def.dir, raw: def.raw },
			drafts,
			d.prompt,
			d.config,
			d.hash,
			reg.settings,
			now,
		);
		expect(r).toEqual({ ok: true, promptFile: "prompt.md", fields: ["tools", "skills"] });
		expect(read(idDir, "alpha", "prompt.md")).toBe(draftPrompt);
		expect(read(idDir, "alpha", "archive", "prompt-2026-10-02-103000.md")).toBe(PROMPT);
		const config = JSON.parse(read(idDir, "alpha", "identity.json"));
		// Its own fields stay; the draft's replace the ones it sets.
		expect(config).toMatchObject({ id: "alpha", title: "Alpha", homeChat: "/s/alpha-home.jsonl", unique: true });
		expect(config.tools).toEqual({ deny: ["browser"] });
		expect(readDraft(drafts, "alpha")).toBeNull();
		expect(readdirSync(join(drafts, ".old"))).toEqual(["alpha-2026-10-02-103000-accepted"]);
		expect(info("alpha")).toMatchObject({ toolLimits: "deny browser", configProblems: [] });
		expect(info("alpha")?.draft).toBeUndefined();
	});

	it("accepts the owner's edits as shown, not the draft on disk", () => {
		const reg = identityRegistry(true);
		const def = reg.identities.find((i) => i.id === "beta")!;
		writeDraft("beta", { prompt: "draft\n", config: "" });
		const d = readDraft(drafts, "beta")!;
		const r = acceptDraft(
			{ id: "beta", dir: def.dir, raw: def.raw },
			drafts,
			"The owner's words",
			JSON.stringify({ unique: true }),
			d.hash,
			reg.settings,
		);
		expect(r).toEqual({ ok: true, promptFile: "prompt.md", fields: ["unique"] });
		expect(read(idDir, "beta", "prompt.md")).toBe("The owner's words\n");
		expect(JSON.parse(read(idDir, "beta", "identity.json"))).toEqual({ id: "beta", title: "Beta", unique: true });
		// No old prompt, so nothing archived.
		expect(existsSync(join(idDir, "beta", "archive"))).toBe(false);
	});

	it("refuses settings it couldn't read, fields a draft can't set, and an older read; nothing changes", () => {
		const reg = identityRegistry(true);
		const def = reg.identities.find((i) => i.id === "alpha")!;
		const d = readDraft(drafts, "alpha")!;
		const before = { config: read(idDir, "alpha", "identity.json"), prompt: read(idDir, "alpha", "prompt.md") };
		const accept = (config: string, hash = d.hash) =>
			acceptDraft({ id: "alpha", dir: def.dir, raw: def.raw }, drafts, d.prompt, config, hash, reg.settings);

		const bad = accept(JSON.stringify({ tools: { deny: "bash" }, title: "Renamed", homeChat: "/x" }));
		expect(bad).toMatchObject({ ok: false, code: "invalid" });
		const problems = (bad as { problems: string[] }).problems.join("\n");
		expect(problems).toContain('a draft can\'t set "title"');
		expect(problems).toContain('a draft can\'t set "homeChat"');
		expect(problems).toContain('"tools.deny" must be a list of tool names');
		expect(accept("not json")).toMatchObject({ ok: false, code: "invalid" });
		expect(accept(JSON.stringify({ skills: { shared: ["nowhere"] } }))).toMatchObject({ ok: false, code: "invalid" });
		expect(accept(d.config, textHash("older"))).toEqual({ ok: false, code: "changed" });
		expect(read(idDir, "alpha", "identity.json")).toBe(before.config);
		expect(read(idDir, "alpha", "prompt.md")).toBe(before.prompt);
		expect(readDraft(drafts, "alpha")).not.toBeNull();
		expect(existsSync(join(drafts, ".old"))).toBe(false);
	});

	it("discarding keeps the draft in .old/; a second discard finds nothing", () => {
		const now = new Date(2026, 9, 2, 11, 0, 5);
		expect(discardDraft(drafts, "alpha", now)).toEqual({ ok: true });
		expect(readDraft(drafts, "alpha")).toBeNull();
		expect(readdirSync(join(drafts, ".old"))).toEqual(["alpha-2026-10-02-110005-discarded"]);
		expect(read(drafts, ".old", "alpha-2026-10-02-110005-discarded", "prompt.md")).toBe(draftPrompt);
		expect(discardDraft(drafts, "alpha", now)).toEqual({ ok: false, code: "unknown" });
		expect(read(idDir, "alpha", "prompt.md")).toBe(PROMPT);
	});
});

describe("the page", () => {
	const alpha: UiIdentityInfo = {
		id: "alpha",
		title: "Alpha",
		aboutSize: 10,
		notebookSize: 100,
		notebookCap: 8000,
		promptFile: "prompt.md",
		promptSize: 1234,
		skills: [
			{ name: "own-skill", description: "A how-to", shared: false, path: "/r/alpha/skills/own-skill/SKILL.md" },
			{ name: "temper-improve", description: "Rounds", shared: true, path: "/a/role-skills/temper-improve/SKILL.md" },
		],
		toolLimits: "deny subagents, browser",
		unique: true,
		configProblems: ['unknown field "colour" (known: id, title)'],
		draft: { promptSize: 2100, fields: ["tools", "skills"] },
	};
	const beta: UiIdentityInfo = {
		id: "beta",
		title: "Beta",
		aboutSize: 0,
		notebookSize: 0,
		notebookCap: 8000,
		promptFile: "prompt.md",
		promptSize: 0,
		skills: [],
		toolLimits: "none",
		configProblems: [],
	};

	it("the draft store: open, save the owner's edits against the hash, accept; a refusal keeps the edits", () => {
		const sent: unknown[] = [];
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
		openIdentityDraft("alpha");
		expect(getIdentityDraft()).toEqual({ id: "alpha", status: "loading" });
		expect(sent.at(-1)).toEqual({ type: "identity_draft_get", id: "alpha" });
		receiveIdentityDraft({ type: "identity_draft", id: "beta", prompt: "x", config: "", notes: "", hash: "hb" });
		expect(getIdentityDraft()?.status).toBe("loading");
		receiveIdentityDraft({
			type: "identity_draft",
			id: "alpha",
			prompt: "p\n",
			config: "{}",
			notes: "why",
			hash: "h1",
		});
		expect(getIdentityDraft()).toMatchObject({
			status: "ready",
			prompt: "p\n",
			config: "{}",
			notes: "why",
			hash: "h1",
		});

		expect(sendIdentityDraftAction("save", "p2\n", "{}")).toBe(true);
		expect(sent.at(-1)).toEqual({
			type: "identity_draft_save",
			id: "alpha",
			prompt: "p2\n",
			config: "{}",
			baseHash: "h1",
		});
		expect(sendIdentityDraftAction("accept", "p2\n", "{}")).toBe(false); // one at a time
		receiveIdentityDraftDone({ type: "identity_draft_done", id: "alpha", action: "save", ok: true, hash: "h2" });
		expect(getIdentityDraft()).toMatchObject({
			prompt: "p2\n",
			hash: "h2",
			busy: undefined,
			done: { action: "save", ok: true },
		});

		expect(sendIdentityDraftAction("accept", "p2\n", '{"tools": 1}')).toBe(true);
		expect(sent.at(-1)).toEqual({
			type: "identity_draft_accept",
			id: "alpha",
			prompt: "p2\n",
			config: '{"tools": 1}',
			baseHash: "h2",
		});
		receiveIdentityDraftDone({
			type: "identity_draft_done",
			id: "alpha",
			action: "accept",
			ok: false,
			code: "invalid",
			problems: ['"tools" must be an object'],
		});
		expect(getIdentityDraft()).toMatchObject({
			status: "ready",
			prompt: "p2\n",
			hash: "h2",
			done: { action: "accept", ok: false, code: "invalid", problems: ['"tools" must be an object'] },
		});
		expect(sendIdentityDraftAction("discard", "", "")).toBe(true);
		expect(sent.at(-1)).toEqual({ type: "identity_draft_discard", id: "alpha" });
		receiveIdentityDraftDone({ type: "identity_draft_done", id: "alpha", action: "discard", ok: true });
		expect(getIdentityDraft()?.done).toEqual({ action: "discard", ok: true });
		closeIdentityDraft();
		expect(getIdentityDraft()).toBeNull();
	});

	it("each row shows the role's prompt, skills, tool limits and problems, and a waiting draft", () => {
		setAppSend(() => true);
		receiveIdentities({ type: "identities", identities: [alpha, beta], problems: [] });
		const html = renderToStaticMarkup(
			createElement(LanguageProvider, null, createElement(IdentitiesSettings, { onOpenChat: () => {} })),
		);
		expect(html).toContain('data-identity="alpha" data-draft="1"');
		expect(html).toContain('class="identity-drafts-count" data-count="1"');
		expect(html).toContain("Draft waiting");
		expect(html).toContain("prompt.md, 1,234 bytes");
		expect(html).toContain("own-skill");
		expect(html).toContain("temper-improve (shared)");
		expect(html).toContain("deny subagents, browser");
		expect(html).toContain("One chat at a time");
		expect(html).toContain("unknown field &quot;colour&quot;");
		expect(html).toContain('data-file="prompt"');
		expect(html).toContain('data-file="config"');
		// beta: nothing set.
		const betaRow = html.slice(html.indexOf('data-identity="beta"'));
		expect(betaRow).toContain("none yet");
		expect(betaRow).toContain("none");
		expect(betaRow).not.toContain("Draft waiting");
	});
});
