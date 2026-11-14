/**
 * The change record's one writer (spec-explorer-writes.md G7, R-EXPLORER-WRITE-4): appends an owner line to
 * `memory-changelog.jsonl`, which `readChangelogRecords` (state-files.ts) reads. One `O_APPEND` write per line, the
 * file created `0600`, never a directory, never an earlier line touched. Synchronous, so lines land in event order
 * and a stopping process can still write them from its `exit` listener.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import type { OwnerExplorerChangelogLine } from "./explorer-types.js";

/** true when the whole line was written; false (never a throw) when it was not: the change stands either way. */
export function appendChangelogLine(path: string, line: OwnerExplorerChangelogLine): boolean {
	const bytes = Buffer.from(`${JSON.stringify(line)}\n`, "utf8");
	let fd: number | null = null;
	try {
		fd = openSync(path, "a", 0o600);
		return writeSync(fd, bytes) === bytes.length;
	} catch {
		return false;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// The line is written or not by now; a failed close changes neither.
			}
		}
	}
}
