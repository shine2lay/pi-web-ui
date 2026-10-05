/**
 * identity-config: a role's settings in Settings -> Identities, its prompt, its skills, and the drafts
 * waiting for the owner.
 *
 * pi-identity (~/projects/pi-identity) reads a role's settings from files, so a role changes by editing a
 * file, never code:
 *
 *   <role>/identity.json        its id, title, folder and home chat, plus its prompt file, skills, tool
 *                               limits and `unique` (pi-identity's README has the fields)
 *   <role>/prompt.md            who the role is and how it works (another .md if identity.json says so)
 *   <role>/skills/              its own skills, which its chats write as they learn
 *   ~/.pi/agent/pi-identity.json  what every role shares: notebook cap, tidy point, tool groups, ...
 *
 * The rules are pi-identity's own: server/identity-config.ts is a byte-identical copy of its config.ts
 * (tests/unit/identity-config.test.ts fails when they differ), so Settings refuses and reports exactly
 * what pi-identity refuses and leaves out. Settings never saves a settings file with a problem in it; a
 * file edited by hand may still have one, and then the role's row says what's left out.
 *
 * Drafts: <memory>/role-drafts/<id>/ (next to the identities folder) holds a suggested about page
 * (about.md, about-drafts), a suggested prompt.md, the suggested settings (config.json: only the fields a
 * role's settings add, like tools and skills) and the reasons (notes.md); any of them may be missing.
 * Nothing in a draft takes effect until the owner accepts it here: accepting writes the about page into
 * the role's about.md and the prompt into its prompt file (an old one with other words is kept in the
 * role's archive/ first) and the settings into its identity.json, then moves the draft to
 * role-drafts/.old/. Discarding moves it there too. These are the app's own saves, not an agent's:
 * pi-worktree keeps every chat from changing a role's identity.json, about page and prompt, and keeps a
 * role's drafts to that role's own chats (it writes them; the owner reads them here).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PROMPT,
	FEATURES,
	limitsText,
	parseRoleConfig,
	PROMPT_MAX,
	roleFileProblems,
	type RoleConfig,
	type Settings,
} from "./identity-config.js";
import type { IdentitySaveError, UiRoleSkill } from "./protocol.js";

type Env = Record<string, string | undefined>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** 文件内容的指纹：存盘时拿它确认文件在页面打开之后没被别人改过。 */
export function textHash(text: string): string {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 整个文件写进去，不会写一半：同目录的临时文件，再 rename（同 pi-identity 的 writeWhole）。 */
export function writeWhole(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, path);
}

/** A file's text; a missing file is empty. */
export function readTextOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw err;
	}
}

function sizeOf(path: string): number {
	try {
		const st = statSync(path);
		return st.isFile() ? st.size : 0;
	} catch {
		return 0;
	}
}

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** about.md's safety cap in bytes: it has no set limit; this only stops one paste from swamping the role section. */
export const ABOUT_MAX = 64_000;

function stampOf(d: Date): string {
	const p = (x: number) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// A role's settings
// ---------------------------------------------------------------------------

/** A role's settings as pi-identity reads them, and what it refuses in them (with the files they name). */
export interface RoleView {
	config: RoleConfig;
	problems: string[];
}

/** The settings in a role's identity.json (already parsed), plus problems with the files they name. */
export function roleViewOf(dir: string, raw: Record<string, unknown>, settings: Settings): RoleView {
	const { config, problems } = parseRoleConfig(raw, settings);
	return { config, problems: [...problems, ...roleFileProblems(dir, config, settings)] };
}

/** The file a role's prompt lives in (the one identity.json names, else prompt.md), for the editor. */
export function promptPathOf(dir: string, config: RoleConfig): string {
	return join(dir, config.prompt ?? DEFAULT_PROMPT);
}

/** The skills in one folder, read with pi's own loader (as a role's chats load them). */
function skillsIn(dir: string, shared: boolean): UiRoleSkill[] {
	try {
		return loadSkillsFromDir({ dir, source: "pi-identity" }).skills.map((s) => ({
			name: s.name,
			description: s.description ?? "",
			shared,
			path: s.filePath,
		}));
	} catch {
		return [];
	}
}

/** Adds the skills whose names aren't in `out` yet (the first of a name wins, as in pi). */
function addNew(out: UiRoleSkill[], found: UiRoleSkill[]): UiRoleSkill[] {
	for (const s of found) if (!out.some((o) => o.name === s.name)) out.push(s);
	return out;
}

/** The shared role skills a role takes, in the order its settings name them. The shared folder isn't
 *  private, so these may go in the identity list every window gets. */
export function sharedSkillList(config: RoleConfig, settings: Settings): UiRoleSkill[] {
	const out: UiRoleSkill[] = [];
	for (const name of config.skills.shared) {
		const d = join(settings.roleSkillsDir, name);
		if (existsSync(join(d, "SKILL.md"))) addNew(out, skillsIn(d, true));
	}
	return out;
}

/** A role's own skills (its skills/ folder) when its settings take them, else none. They live in its
 *  private folder (#33), so they go only to the window that asks (identity_skills_get), never in the
 *  identity list every window gets. */
export function ownSkillList(dir: string, config: RoleConfig): UiRoleSkill[] {
	const own = join(dir, "skills");
	return config.skills.own && existsSync(own) ? addNew([], skillsIn(own, false)) : [];
}

/** The skills a role's chats load: its own first, then the shared ones not named like one of them (the
 *  same folders and order as pi-identity's roleSkillDirs). */
export function roleSkillList(dir: string, config: RoleConfig, settings: Settings): UiRoleSkill[] {
	return addNew(ownSkillList(dir, config), sharedSkillList(config, settings));
}

/** The role parts of a Settings row, which every window gets: its own skills only as a count. */
export function roleInfoParts(dir: string, view: RoleView, settings: Settings) {
	const promptPath = promptPathOf(dir, view.config);
	return {
		promptFile: basename(promptPath),
		promptSize: sizeOf(promptPath),
		...(view.config.prompt === null ? { promptOff: true } : {}),
		skills: sharedSkillList(view.config, settings),
		...(view.config.skills.own ? { ownSkills: ownSkillList(dir, view.config).length } : {}),
		toolLimits: limitsText(view.config.tools, settings),
		...(view.config.unique ? { unique: true } : {}),
		configProblems: view.problems,
	};
}

/** Settings' answer to a settings save it refuses: the reasons, each one line. */
export type ConfigCheck = { ok: true; value: Record<string, unknown> } | { ok: false; problems: string[] };

function parseObject(text: string, what: string): ConfigCheck {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return { ok: false, problems: [`${what} isn't valid JSON: ${(err as Error).message.split("\n")[0]}`] };
	}
	if (!isObject(raw)) return { ok: false, problems: [`${what} must hold one JSON object`] };
	return { ok: true, value: raw };
}

/**
 * A whole identity.json from the editor: refused unless pi-identity would read every part of it. Its id
 * stays the folder's name (a role isn't renamed here), and every file it names must exist.
 */
export function checkConfigText(text: string, id: string, dir: string, settings: Settings): ConfigCheck {
	const parsed = parseObject(text, "identity.json");
	if (!parsed.ok) return parsed;
	const problems: string[] = [];
	if (parsed.value.id !== undefined && parsed.value.id !== id) {
		problems.push(`"id" must stay "${id}", the role folder's name (a role isn't renamed here)`);
	}
	problems.push(...roleViewOf(dir, parsed.value, settings).problems);
	return problems.length ? { ok: false, problems } : parsed;
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** Where drafts wait: PI_ROLE_DRAFTS_DIR, else role-drafts/ next to the identities folder. */
export function draftsDir(identitiesDir: string, env: Env = process.env): string {
	return env.PI_ROLE_DRAFTS_DIR || join(dirname(identitiesDir), "role-drafts");
}

/**
 * A draft's files. about-drafts: about.md is the suggested about page. config holds only the fields it
 * suggests (FEATURES: prompt, skills, tools, unique).
 */
export const DRAFT_FILES = {
	about: "about.md",
	prompt: "prompt.md",
	config: "config.json",
	notes: "notes.md",
} as const;
/** The fields a draft may suggest: a role's settings, not its id, title, folder or home chat. */
export const DRAFT_FIELDS: readonly string[] = Object.keys(FEATURES);

const DRAFT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** The roles with a draft waiting (folders in the drafts folder; .old/ and other dot folders aren't drafts). */
export function draftIds(root: string): string[] {
	let names: string[];
	try {
		names = readdirSync(root).sort();
	} catch {
		return [];
	}
	return names.filter((name) => {
		if (!DRAFT_ID_RE.test(name)) return false;
		try {
			return statSync(join(root, name)).isDirectory();
		} catch {
			return false;
		}
	});
}

/**
 * What a waiting draft suggests, for the role's row: its about page's and prompt's sizes (about-drafts:
 * aboutSize) and the settings fields it sets.
 */
export function draftSummary(
	root: string,
	id: string,
): { aboutSize: number; promptSize: number; fields: string[] } | null {
	const d = readDraft(root, id);
	if (!d) return null;
	let fields: string[] = [];
	try {
		const v: unknown = JSON.parse(d.config);
		if (isObject(v)) fields = Object.keys(v);
	} catch {
		fields = [];
	}
	return { aboutSize: bytes(d.about), promptSize: bytes(d.prompt), fields };
}

export interface DraftFiles {
	/** about-drafts: the suggested about page ("" = none). */
	about: string;
	prompt: string;
	config: string;
	notes: string;
	/** One hash over all four: a save or accept made from an older read is refused ("changed"). */
	hash: string;
}

const draftHash = (about: string, prompt: string, config: string, notes: string) =>
	textHash(`${about}\0${prompt}\0${config}\0${notes}`);

/** A role's draft, or null when none waits. */
export function readDraft(root: string, id: string): DraftFiles | null {
	if (!DRAFT_ID_RE.test(id) || !draftIds(root).includes(id)) return null;
	const dir = join(root, id);
	const about = readTextOrEmpty(join(dir, DRAFT_FILES.about));
	const prompt = readTextOrEmpty(join(dir, DRAFT_FILES.prompt));
	const config = readTextOrEmpty(join(dir, DRAFT_FILES.config));
	const notes = readTextOrEmpty(join(dir, DRAFT_FILES.notes));
	return { about, prompt, config, notes, hash: draftHash(about, prompt, config, notes) };
}

/**
 * The texts the owner saves or accepts. about-drafts: about = null when the page that sent them didn't
 * show an about page (a page from before about-drafts): a draft that has one is then refused as changed,
 * so nobody accepts an about page they never saw.
 */
export interface DraftTexts {
	about: string | null;
	prompt: string;
	config: string;
}

/** The draft's texts as the owner sent them, or a refusal: the draft changed, or a text is too big. */
function checkTexts(
	cur: DraftFiles,
	texts: DraftTexts,
	baseHash: string,
): { ok: false; code: IdentitySaveError } | { ok: true; about: string } {
	if (cur.hash !== baseHash) return { ok: false, code: "changed" };
	if (texts.about === null && cur.about !== "") return { ok: false, code: "changed" };
	const about = texts.about ?? "";
	if (bytes(texts.prompt) > PROMPT_MAX || bytes(about) > ABOUT_MAX) return { ok: false, code: "too_big" };
	return { ok: true, about };
}

/** Write one of a draft's files: a file it has, or a new one with words in it (no empty files appear). */
function writeDraftFile(dir: string, name: string, text: string): void {
	const path = join(dir, name);
	if (text !== "" || existsSync(path)) writeWhole(path, text);
}

/** A whole page with a final newline, or "" when it has no words (nothing to write). */
const pageText = (text: string) => (text.trim() ? (text.endsWith("\n") ? text : `${text}\n`) : "");

/** Write a role's page (about.md or its prompt file); an old one with other words goes to its archive/ first. */
function writePage(dir: string, target: string, text: string, now: Date): void {
	const old = readTextOrEmpty(target);
	if (old.trim() && old !== text) {
		writeWhole(join(dir, "archive", `${basename(target, ".md")}-${stampOf(now)}.md`), old);
	}
	writeWhole(target, text);
}

/**
 * A draft's suggested settings, checked as they'd be once accepted: only the fields a role's settings add,
 * merged over the role's identity.json as it is now, and nothing pi-identity would refuse. Its prompt file
 * isn't checked for being there: accepting writes it.
 */
export function checkDraftConfig(
	text: string,
	dir: string,
	raw: Record<string, unknown>,
	settings: Settings,
): ConfigCheck {
	const parsed = text.trim() ? parseObject(text, "The draft's settings") : { ok: true as const, value: {} };
	if (!parsed.ok) return parsed;
	const problems: string[] = [];
	for (const key of Object.keys(parsed.value)) {
		if (!DRAFT_FIELDS.includes(key)) {
			problems.push(`a draft can't set "${key}" (it suggests ${DRAFT_FIELDS.join(", ")} only)`);
		}
	}
	const merged = { ...raw, ...parsed.value };
	const { config, problems: refused } = parseRoleConfig(merged, settings);
	problems.push(...refused, ...roleFileProblems(dir, { ...config, prompt: null }, settings));
	return problems.length ? { ok: false, problems } : parsed;
}

export type DraftResult =
	| { ok: true; hash?: string; aboutFile?: string; promptFile?: string; fields?: string[] }
	| { ok: false; code: IdentitySaveError; problems?: string[] };

/** Save the owner's edits to a draft (it stays a draft). Refused when it changed since it was read. */
export function saveDraft(root: string, id: string, texts: DraftTexts, baseHash: string): DraftResult {
	const cur = readDraft(root, id);
	if (!cur) return { ok: false, code: "unknown" };
	const checked = checkTexts(cur, texts, baseHash);
	if (!checked.ok) return checked;
	const dir = join(root, id);
	try {
		writeDraftFile(dir, DRAFT_FILES.about, checked.about);
		writeDraftFile(dir, DRAFT_FILES.prompt, texts.prompt);
		writeDraftFile(dir, DRAFT_FILES.config, texts.config);
	} catch {
		return { ok: false, code: "io" };
	}
	return { ok: true, hash: draftHash(checked.about, texts.prompt, texts.config, cur.notes) };
}

/** Move a finished draft out of the way: role-drafts/.old/<id>-<time>-<how>/, kept, not deleted. */
function retireDraft(root: string, id: string, how: "accepted" | "discarded", now: Date): void {
	const old = join(root, ".old");
	mkdirSync(old, { recursive: true });
	let to = join(old, `${id}-${stampOf(now)}-${how}`);
	for (let i = 2; existsSync(to); i++) to = join(old, `${id}-${stampOf(now)}-${how}-${i}`);
	renameSync(join(root, id), to);
}

/** The role a draft is accepted into: its folder and its identity.json as it is now. */
export interface DraftTarget {
	id: string;
	dir: string;
	raw: Record<string, unknown>;
}

/**
 * Accept a draft as shown (the owner's unsaved edits included). about-drafts: its about page goes into the
 * role's about.md first; then, as before, its prompt into the role's prompt file and its settings into the
 * role's identity.json (an old about page or prompt with other words is kept in the role's archive/ first;
 * each file is written whole, never half). Then the draft moves to .old/. Refused, with nothing written,
 * when the draft changed since it was read, a text is too big, or the settings have a problem. An empty
 * about page or prompt leaves the role's own as it is.
 */
export function acceptDraft(
	role: DraftTarget,
	root: string,
	texts: DraftTexts,
	baseHash: string,
	settings: Settings,
	now: Date = new Date(),
): DraftResult {
	const cur = readDraft(root, role.id);
	if (!cur) return { ok: false, code: "unknown" };
	const checkedTexts = checkTexts(cur, texts, baseHash);
	if (!checkedTexts.ok) return checkedTexts;
	const checked = checkDraftConfig(texts.config, role.dir, role.raw, settings);
	if (!checked.ok) return { ok: false, code: "invalid", problems: checked.problems };
	const fields = Object.keys(checked.value);
	const merged = { ...role.raw, ...checked.value };
	const target = promptPathOf(role.dir, parseRoleConfig(merged, settings).config);
	const about = pageText(checkedTexts.about);
	const text = pageText(texts.prompt);
	try {
		if (about) writePage(role.dir, join(role.dir, "about.md"), about, now);
		if (text) writePage(role.dir, target, text, now);
		if (fields.length) writeWhole(join(role.dir, "identity.json"), `${JSON.stringify(merged, null, "\t")}\n`);
		retireDraft(root, role.id, "accepted", now);
	} catch {
		return { ok: false, code: "io" };
	}
	return {
		ok: true,
		...(about ? { aboutFile: "about.md" } : {}),
		...(text ? { promptFile: basename(target) } : {}),
		fields,
	};
}

/** Discard a draft: it moves to .old/ (kept, in case). */
export function discardDraft(root: string, id: string, now: Date = new Date()): DraftResult {
	if (!readDraft(root, id)) return { ok: false, code: "unknown" };
	try {
		retireDraft(root, id, "discarded", now);
	} catch {
		return { ok: false, code: "io" };
	}
	return { ok: true };
}
