/**
 * session-transcripts (Ops #688): finds and reads the chats' transcript files for the read-only stats
 * scripts (scripts/turn-status-stats.mts). A transcript that vanishes between listing and reading (a
 * deploy check's throwaway chat, deleted right after) is skipped, not an error.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const HEAD_TIME = /"timestamp":"([^"]+)"/;

/** True when a file or folder vanished between listing and reading it. */
export const vanished = (err: unknown) => (err as NodeJS.ErrnoException)?.code === "ENOENT";

/** Every .jsonl transcript under `dir` changed since `since` (ms), sorted. */
export function transcriptsIn(dir: string, since: number): string[] {
	const out: string[] = [];
	let listed;
	try {
		listed = readdirSync(dir, { withFileTypes: true });
	} catch (err) {
		if (vanished(err)) return out;
		throw err;
	}
	for (const d of listed) {
		const p = join(dir, d.name);
		if (d.isDirectory()) out.push(...transcriptsIn(p, since));
		else if (d.isFile() && d.name.endsWith(".jsonl")) {
			try {
				if (statSync(p).mtimeMs >= since) out.push(p);
			} catch (err) {
				if (!vanished(err)) throw err;
			}
		}
	}
	return out.sort();
}

/** A transcript's entries from `from` (ms) on, plus its identity line; [] when it vanished before it was read. */
export async function entriesOf(file: string, from: number): Promise<unknown[]> {
	try {
		return await readEntries(file, from);
	} catch (err) {
		if (vanished(err)) return [];
		throw err;
	}
}

async function readEntries(file: string, from: number): Promise<unknown[]> {
	const entries: unknown[] = [];
	const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		if (!line) continue;
		const head = HEAD_TIME.exec(line.slice(0, 200));
		const old = head && Date.parse(head[1]!) < from;
		// the chat's identity is near its start: keep it even when the lines around it are skipped
		if (old && !line.slice(0, 200).includes('"customType":"identity"')) continue;
		try {
			entries.push(JSON.parse(line));
		} catch {
			// a torn last line of a chat being written: not a turn yet
		}
	}
	return entries;
}
