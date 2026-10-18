/**
 * roles-instructions (Ops #208): which instructions a role's home chat loaded, and whether any changed since.
 *
 * pi-identity writes <role dir>/loaded.json (its docs/loaded-record.md): per chat file, when it loaded and a
 * sha256 of each instruction file it was given (AGENTS.md, the role's prompt, about page and notebook). This
 * reads the home chat's entry, hashes those files as they are now and compares. Only names, hashes and
 * times are used; no instruction text is kept or sent (AGENTS.md rule 11). It reads only, never writes.
 *
 * A path is hashed only when it is the every-chat rules file or a .md file directly in the role's folder, as
 * a regular file of bounded size (no links, no special files): a crafted loaded.json can't make it read
 * anything else. Anything unreadable leaves the role "none" (Not recorded); the rest of the page is intact.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { samePath } from "./identities.js";
import type { UiRoleInstructions } from "./protocol.js";
import { readUpTo } from "./state-file-read.js";

/** loaded.json holds at most 50 chats of four files each (a few KB each): far below this. */
export const LOADED_FILE_MAX = 512 * 1024;
/** An instruction file larger than this isn't hashed (pi-identity caps the notebook far lower). */
export const INSTRUCTION_FILE_MAX = 4 * 1024 * 1024;
/** At most this many files per chat entry are compared. */
const FILES_MAX = 8;

const NONE: UiRoleInstructions = { state: "none" };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isoTime = (v: unknown): number | null => {
	if (typeof v !== "string" || v.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v))
		return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
};

interface LoadedFile {
	name: string;
	path: string;
	sha256: string | null;
}

/** The home chat's entry: when it loaded, and its files (null: none, or not a valid entry). */
export function loadedEntryOf(raw: unknown, homeChat: string): { at: number; files: LoadedFile[] } | null {
	if (!object(raw) || raw.v !== 1 || !object(raw.sessions)) return null;
	const key = Object.keys(raw.sessions).find((k) => samePath(k, homeChat));
	const entry = key ? raw.sessions[key] : undefined;
	if (!object(entry) || !Array.isArray(entry.files) || entry.files.length > FILES_MAX) return null;
	const at = isoTime(entry.at);
	if (at === null) return null;
	const files: LoadedFile[] = [];
	for (const f of entry.files) {
		if (!object(f) || typeof f.name !== "string" || !NAME.test(f.name)) return null;
		if (typeof f.path !== "string" || !f.path.startsWith("/") || f.path.length > 4096) return null;
		if (f.sha256 !== null && (typeof f.sha256 !== "string" || !HEX64.test(f.sha256))) return null;
		files.push({ name: f.name, path: f.path, sha256: f.sha256 });
	}
	return files.length ? { at, files } : null;
}

/** A bounded regular file's bytes, or null when missing; throws when it can't be read safely. */
async function readBounded(file: string, max: number): Promise<Buffer | null> {
	let st: Awaited<ReturnType<typeof lstat>>;
	try {
		st = await lstat(file);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	if (!st.isFile() || st.size > max || (await realpath(file)) !== resolve(file)) throw new Error("not a plain file");
	const h = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const now = await h.stat();
		if (!now.isFile() || now.size > max) throw new Error("not a plain file");
		const buf = await readUpTo(h, max, 64 * 1024);
		if (!buf) throw new Error("too large");
		return buf;
	} finally {
		await h.close();
	}
}

/**
 * The role's loaded-instructions state for the Roles page: "current" (every file the home chat loaded is
 * unchanged), "outdated" with the names of those that changed (or went missing), or "none".
 */
export async function readRoleInstructions(
	roleDir: string,
	homeChat: string | null,
	agentsFile: string | null,
): Promise<UiRoleInstructions> {
	if (!homeChat) return NONE;
	try {
		const raw = await readBounded(join(roleDir, "loaded.json"), LOADED_FILE_MAX);
		if (!raw) return NONE;
		const entry = loadedEntryOf(JSON.parse(raw.toString("utf8")), homeChat);
		if (!entry) return NONE;
		const dir = resolve(roleDir);
		const changed: string[] = [];
		for (const f of entry.files) {
			const path = resolve(f.path);
			const allowed =
				(!!agentsFile && path === resolve(agentsFile)) || (dirname(path) === dir && basename(path).endsWith(".md"));
			if (!allowed) return NONE;
			const now = await readBounded(path, INSTRUCTION_FILE_MAX);
			const hash = now ? createHash("sha256").update(now).digest("hex") : null;
			if (hash !== f.sha256 && !changed.includes(f.name)) changed.push(f.name);
		}
		return changed.length
			? { state: "outdated", loadedAt: entry.at, changed }
			: { state: "current", loadedAt: entry.at };
	} catch {
		return NONE;
	}
}
