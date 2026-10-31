// ---------------------------------------------------------------------------
// write-whole.ts — write a file whole, never half: a temporary file in the same folder, then a rename
// over the old one (as pi-identity's writeWhole). Moved out of identity-roles.ts so any store can use
// it (Ops #684: the owner-question hold store needs it with mode 0600).
// ---------------------------------------------------------------------------

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface WriteWholeOptions {
	/** The file's permission bits, exactly (0o600 for a private store); left out = a new file's default. */
	mode?: number;
}

/** Writes `text` to `path` whole (creating its folder). A failed write leaves the old file and no temporary one. */
export function writeWhole(path: string, text: string, options: WriteWholeOptions = {}): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		if (options.mode === undefined) writeFileSync(tmp, text, "utf8");
		else {
			writeFileSync(tmp, text, { encoding: "utf8", mode: options.mode });
			chmodSync(tmp, options.mode); // exactly these bits, whatever the umask
		}
		renameSync(tmp, path);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// the folder itself is gone or unusable: nothing was left there
		}
		throw err;
	}
}
