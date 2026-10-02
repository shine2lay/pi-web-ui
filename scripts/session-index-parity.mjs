#!/usr/bin/env node
/* session-index: compare the server's chat index with pi's own `SessionManager.listAll` on the real chat
 * folders. Prints counts and field names only — never a title, a first message or any chat content.
 *
 *   node scripts/session-index-parity.mjs [--saved <dataDir>/session-index.json]
 *
 * 1. A fresh index (memory only, nothing saved) against listAll: same rows, same order, same fields.
 * 2. With --saved: the same, from a throwaway copy of the server's saved index (the saved file itself is
 *    never written), plus how many chat files that copy needed to read. A copy the index rejects (so the
 *    server would start cold) counts as a difference.
 * Both indexes use the server's own settings (they follow the chats' identity entries, as the server's does).
 * Exit 0 when every comparison shows 0 differences. Run it from the build that's installed (dist/). */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { IDENTITY_ENTRY_TYPE, identityIdOfEntry } from "../dist/server/identities.js";
import { SessionIndex } from "../dist/server/session-index.js";

const args = process.argv.slice(2);
const savedAt = args.indexOf("--saved");
const saved = savedAt >= 0 ? args[savedAt + 1] : null;
// The server's piSessionsRoot(): pi's own session-folder setting, else pi's default folders.
const root = process.env.PI_CODING_AGENT_SESSION_DIR || undefined;

const FIELDS = [
	"path",
	"id",
	"cwd",
	"name",
	"parentSessionPath",
	"created",
	"modified",
	"messageCount",
	"firstMessage",
];
const norm = (v) => (v instanceof Date ? v.getTime() : (v ?? null));

function compare(label, want, got) {
	const diffs = new Map();
	let orderDiffs = 0;
	const byPath = new Map(got.map((r) => [r.path, r]));
	for (let i = 0; i < want.length; i++) {
		if (got[i]?.path !== want[i].path) orderDiffs++;
		const g = byPath.get(want[i].path);
		if (!g) continue;
		for (const f of FIELDS) if (norm(want[i][f]) !== norm(g[f])) diffs.set(f, (diffs.get(f) ?? 0) + 1);
	}
	const wantPaths = new Set(want.map((r) => r.path));
	const missing = want.filter((r) => !byPath.has(r.path)).length;
	const extra = got.filter((r) => !wantPaths.has(r.path)).length;
	const fieldDiffs = [...diffs.values()].reduce((a, b) => a + b, 0);
	const total = missing + extra + orderDiffs + fieldDiffs;
	console.log(
		`${label}: ${want.length} rows from listAll, ${got.length} from the index; ` +
			`missing ${missing}, extra ${extra}, out of order ${orderDiffs}, field differences ${fieldDiffs}` +
			(diffs.size ? ` (${[...diffs].map(([f, n]) => `${f}: ${n}`).join(", ")})` : ""),
	);
	return total;
}

// The server's own settings (agent-service.ts `sessionIndex.configure`): the index also follows each chat's
// identity entries, and a saved file made with other settings is rejected (rebuilt).
const SERVER_OPTS = { identity: { customType: IDENTITY_ENTRY_TYPE, idOf: (entry) => identityIdOfEntry(entry) } };

let t = performance.now();
const fresh = new SessionIndex({ workers: 2, ...SERVER_OPTS });
const freshRows = await fresh.listAll(root);
const freshMs = Math.round(performance.now() - t);

let savedRows = null;
let savedIndex = null;
let savedMs = 0;
let tmp = null;
if (saved) {
	tmp = mkdtempSync(join(tmpdir(), "session-index-parity-"));
	const copy = join(tmp, "session-index.json");
	copyFileSync(saved, copy);
	t = performance.now();
	savedIndex = new SessionIndex({ workers: 2, file: copy, ...SERVER_OPTS });
	savedRows = await savedIndex.listAll(root);
	savedMs = Math.round(performance.now() - t);
}

t = performance.now();
const want = await SessionManager.listAll(root);
const piMs = Math.round(performance.now() - t);

let total = compare("fresh index", want, freshRows);
console.log(
	`  timing: pi's listAll ${piMs} ms; fresh index ${freshMs} ms (${fresh.stats.fullReads} files read in full)`,
);
if (savedRows) {
	total += compare("saved index (a copy)", want, savedRows);
	const s = savedIndex.stats;
	console.log(
		`  timing: ${savedMs} ms; ${s.loadedFromDisk} files from the saved index, ${s.unchanged} unchanged, ` +
			`${s.fullReads} read in full, ${s.partialReads} read from where they stopped` +
			(s.rejectedSaves ? "; the saved file was unusable (rebuilt)" : ""),
	);
	// The server would reject it the same way and start cold: that counts as a difference.
	if (s.rejectedSaves) total += 1;
	rmSync(tmp, { recursive: true, force: true });
}
console.log(total === 0 ? "0 differences" : `${total} differences`);
process.exit(total === 0 ? 0 : 1);
