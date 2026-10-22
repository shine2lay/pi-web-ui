/**
 * recent-chat-pick: which chat a new connection to a project reopens.
 *
 * The SDK's `SessionManager.continueRecent(cwd)` takes the newest `.jsonl` in the project's sessions folder
 * by `statSync`, which follows links: a link there to a file elsewhere can win, and the shell then writes
 * into that file (Security rm-885a66f3; the Roles page test's outside canary changed in 1 of 4 runs).
 *
 * This picks the same way, newest modification time first among files whose first entry is a session
 * header, but only regular files sitting directly in the folder (`lstat`, so never a link, FIFO, device or
 * folder), and opens the pick exactly as `continueRecent` would. With none, a new chat, as before.
 */

import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { defaultSessionDirPath } from "./session-index.js";

/** As the SDK's header discovery: at most this much of a file is read looking for its header. */
const HEADER_SCAN_MAX = 1024 * 1024;
const HEADER_CHUNK = 4096;
/** Never wait on a FIFO or follow a link swapped in after the listing; never take a tty as the terminal. */
const HEADER_FLAGS =
	constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0) | (constants.O_NOCTTY ?? 0);

/** The SDK's rule (parseSessionHeaderCandidate): the first line that parses to a truthy JSON value is the header;
 *  a session header has type "session" and a string id. Undefined: keep looking (blank, unparsable or falsy);
 *  false: not a chat file. */
function headerVerdict(line: string): boolean | undefined {
	if (!line.trim()) return undefined;
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!entry) return undefined;
	const e = entry as { type?: unknown; id?: unknown };
	return e.type === "session" && typeof e.id === "string";
}

/** Does the file start with a session header (within the first MiB)? Any read problem: no. */
export function hasSessionHeader(path: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, HEADER_FLAGS);
	} catch {
		return false;
	}
	try {
		const decoder = new StringDecoder("utf8");
		const buf = Buffer.allocUnsafe(HEADER_CHUNK);
		let line = "";
		let scanned = 0;
		while (scanned < HEADER_SCAN_MAX) {
			const n = readSync(fd, buf, 0, Math.min(buf.length, HEADER_SCAN_MAX - scanned), null);
			if (n === 0) return headerVerdict(line + decoder.end()) === true;
			scanned += n;
			const chunk = decoder.write(buf.subarray(0, n));
			let start = 0;
			let nl = chunk.indexOf("\n", start);
			while (nl !== -1) {
				const verdict = headerVerdict(line + chunk.slice(start, nl));
				if (verdict !== undefined) return verdict;
				line = "";
				start = nl + 1;
				nl = chunk.indexOf("\n", start);
			}
			line += chunk.slice(start);
		}
		return false;
	} catch {
		return false;
	} finally {
		closeSync(fd);
	}
}

/** The newest chat file directly in `dir`: regular files only, newest modification time first, the first whose
 *  header reads. Undefined when there is none or the folder can't be read. */
export function newestSessionFile(dir: string): string | undefined {
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	const files: { path: string; mtime: number }[] = [];
	for (const name of names) {
		const path = join(dir, name);
		try {
			const st = lstatSync(path);
			if (st.isFile()) files.push({ path, mtime: st.mtimeMs });
		} catch {
			// Gone since the listing.
		}
	}
	files.sort((a, b) => b.mtime - a.mtime);
	return files.find((f) => hasSessionHeader(f.path))?.path;
}

/** `SessionManager.continueRecent(cwd)` without following links: the project's newest regular chat file, or a
 *  new chat when it has none. */
export function continueRecentRegular(cwd: string): SessionManager {
	const dir = defaultSessionDirPath(cwd);
	// As the SDK's getDefaultSessionDir: the folder exists from the first visit on.
	mkdirSync(dir, { recursive: true });
	return openPickedRegular(cwd, newestSessionFile(dir));
}

/** queue-back-owed (Ops #393): continueRecentRegular for a pick already made (recentRegularFile) and checked:
 *  opens exactly that file, or a new chat when there was none, so no newer file slips in between the check and
 *  the open. */
export function openPickedRegular(cwd: string, file: string | undefined): SessionManager {
	const dir = defaultSessionDirPath(cwd);
	mkdirSync(dir, { recursive: true });
	return file ? SessionManager.open(file, dir, cwd) : SessionManager.create(cwd, dir);
}

/** The file a new connection reopens (for #235's repair of that same file), without opening it. */
export function recentRegularFile(cwd: string): string | undefined {
	return newestSessionFile(defaultSessionDirPath(cwd));
}
