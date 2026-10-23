#!/usr/bin/env node
// Ops #241 (docs/role-message-fresh-start.md): asks the next pi-web-ui start for a one-shot fresh start of the
// role-message approval record (the guard store in <data dir>/role-message-guard), bound to the exact files of its
// current generation. It only reads those files and writes fresh-start.json (mode 0600); --dry-run writes nothing.
// It prints counts and ids only, never a message's words.
//
//   node scripts/role-guard-fresh-start.mjs [--dry-run] [--data-dir <dir>] [--reason <text>]
//
// The data dir is --data-dir, else PI_WEB_DATA_DIR (what the server reads), else ~/.pi-web-ui (the live one).
// Exit 0: the request was written (with --dry-run: it would be). 1: nothing written, and why. 2: usage or failure.
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HOUR = 60 * 60 * 1000;
const QUIET_MS = 2 * HOUR; // GUARD_FRESH_START_QUIET_MS in server/role-message-guard-host.ts
const LIFETIME_MS = 24 * HOUR; // GUARD_FRESH_START_LIFETIME_MS
const MAX_BYTES = 4096; // GUARD_FRESH_START_MAX_BYTES (Ops #248)
const OPEN_REQUEST_STATES = ["context_needed", "awaiting_approver", "awaiting_owner", "rate_limited", "held"];
const FILES = ["journal.json", "accepted.json"];

const say = (line) => console.log(line);
const iso = (t) => new Date(t).toISOString();
function usage() {
	say("usage: node scripts/role-guard-fresh-start.mjs [--dry-run] [--data-dir <dir>] [--reason <text>]");
	say("Asks the next pi-web-ui start for a one-shot fresh start of the message-approval record.");
	say("See docs/role-message-fresh-start.md.");
}
function stop(code, line) {
	if (line) say(line);
	process.exit(code);
}

let dryRun = false;
let dataDir = process.env.PI_WEB_DATA_DIR || join(homedir(), ".pi-web-ui");
let reason = "operator fresh start (Ops #241)";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--dry-run") dryRun = true;
	else if (a === "--data-dir" && args[i + 1]) dataDir = args[++i];
	else if (a === "--reason" && args[i + 1]) reason = args[++i];
	else if (a === "-h" || a === "--help") {
		usage();
		process.exit(0);
	} else {
		console.error(`not understood: ${a}`);
		usage();
		process.exit(2);
	}
}

/** guardDigest in server/role-message-guard-store.ts: sha256 of JSON with sorted keys (index keys first). */
function isIndexKey(k) {
	return /^(0|[1-9][0-9]{0,9})$/.test(k) && Number(k) < 4294967295;
}
function sortedCopy(v) {
	if (v === null || typeof v !== "object") return v;
	if (Array.isArray(v)) return v.map(sortedCopy);
	const keys = Object.keys(v).filter((k) => v[k] !== undefined);
	const index = keys.filter(isIndexKey).sort((a, b) => Number(a) - Number(b));
	const named = keys.filter((k) => !isIndexKey(k)).sort((a, b) => a.localeCompare(b));
	return Object.fromEntries([...index, ...named].map((k) => [k, sortedCopy(v[k])]));
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const digest = (v) => sha256(JSON.stringify(sortedCopy(v)));
function fsyncPath(path) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function counts(items, key) {
	const by = {};
	for (const x of items) by[key(x)] = (by[key(x)] ?? 0) + 1;
	const parts = Object.entries(by).map(([k, n]) => `${k} ${n}`);
	return parts.length ? parts.join(", ") : "none";
}
const list = (xs) => (xs.length ? ` (${xs.join(", ")})` : "");
const arr = (x) => (Array.isArray(x) ? x : []);

try {
	const now = Date.now();
	const guard = join(resolve(dataDir), "role-message-guard");
	say(`guard dir: ${guard}`);
	if (!existsSync(guard)) stop(1, "nothing to start over from: the guard dir doesn't exist. Nothing written.");

	// The generation the server opens (currentGeneration in role-message-guard-host.ts). Ops #248 (Security N3): once a
	// generation exists, a current.json that is missing, unreadable, not understood or names a folder that isn't there
	// keeps the server off without touching anything, so a request would never be read.
	let gen = null;
	let currentWhy = "is not understood";
	try {
		const c = JSON.parse(readFileSync(join(guard, "current.json"), "utf8"));
		if (typeof c?.gen === "number" && Number.isSafeInteger(c.gen) && c.gen >= 1) gen = c.gen;
	} catch (err) {
		if (err?.code === "ENOENT") currentWhy = "is missing";
		else if (err?.code) currentWhy = `can't be read (${err.code})`;
	}
	if (readdirSync(guard).some((n) => /^(archive-)?gen-\d+$/.test(n))) {
		let there = false;
		try {
			there = gen !== null && lstatSync(join(guard, `gen-${gen}`)).isDirectory();
		} catch {
			there = false;
		}
		if (gen !== null && !there) currentWhy = `points at gen-${gen}, which doesn't exist`;
		if (!there)
			stop(
				1,
				`current.json ${currentWhy}, so the next start keeps the ladder off without touching the record and would never read a request. Nothing written.`,
			);
	} else if (gen !== null && gen >= 2) {
		// Ops #257 (Architecture B4): with no generation folder left, only generation 1 is a first start.
		stop(
			1,
			`current.json points at gen-${gen}, which doesn't exist, so the next start keeps the ladder off without touching the record and would never read a request. Nothing written.`,
		);
	} else gen ??= 1;
	say(`current generation: ${gen}`);

	try {
		const pid = Number.parseInt(readFileSync(join(guard, "lock"), "utf8"), 10);
		let alive = false;
		try {
			process.kill(pid, 0);
			alive = true;
		} catch (err) {
			alive = err?.code === "EPERM";
		}
		say(
			alive
				? `server: pid ${pid} holds the guard; it reads a request at its next start`
				: "server: no running server holds the guard",
		);
	} catch {
		say("server: no lock file");
	}

	const files = {};
	for (const name of FILES) {
		const path = join(guard, `gen-${gen}`, name);
		try {
			const st = statSync(path);
			const bytes = readFileSync(path);
			files[name] = { bytes, sha256: sha256(bytes), mtimeMs: st.mtimeMs };
			say(`gen-${gen}/${name}: ${bytes.length} bytes, sha256 ${files[name].sha256}, last changed ${iso(st.mtimeMs)}`);
		} catch (err) {
			stop(
				1,
				`gen-${gen}/${name}: missing or unreadable (${err?.code ?? "error"}). Nothing to start over from; nothing written.`,
			);
		}
	}

	// The old record's open items (read-only; counts and ids only).
	let bundle = null;
	let accepted = null;
	try {
		bundle = JSON.parse(files["journal.json"].bytes.toString("utf8"));
	} catch {
		say("journal.json: can't be read as JSON, so its open items are unknown");
	}
	try {
		accepted = JSON.parse(files["accepted.json"].bytes.toString("utf8"));
	} catch {
		say("accepted.json: can't be read as JSON");
	}
	const s = bundle && typeof bundle === "object" ? bundle.state : null;
	if (s && typeof s === "object") {
		say(`journal stage: ${bundle.stage}`);
		const outbox = arr(s.outbox);
		say(`outbox entries by state: ${counts(outbox, (o) => o?.state)}`);
		const unsettled = outbox
			.filter((o) => o?.state !== "handled" && o?.state !== "failed")
			.map((o) => o?.receipt?.messageId ?? o?.message?.id ?? "?");
		say(`outbox entries not handled: ${unsettled.length}${list(unsettled)}`);
		const requests = arr(s.requests);
		const open = requests.filter((r) => OPEN_REQUEST_STATES.includes(r?.state) && now < r?.expiresAt);
		say(`requests by state: ${counts(requests, (r) => r?.state)}`);
		say(`open requests now: ${open.length}${list(open.map((r) => r?.binding?.requestId ?? "?"))}`);
		const grants = arr(s.grants);
		const live = grants.filter((g) => g?.state === "approved" && now < g?.expiresAt);
		say(`grants by state: ${counts(grants, (g) => g?.state)}`);
		say(`live grants now: ${live.length}${list(live.map((g) => g?.id ?? "?"))}`);
		say(`transactions not committed: ${arr(s.transactions).filter((t) => t?.state !== "committed").length}`);
		say(
			`accepted messages: ${arr(bundle.legacy?.messages).length} in the journal's copy, ${arr(accepted?.messages).length} in accepted.json`,
		);
	}

	// Ops #248 (Architecture S1): the next start never starts over from a journal holding a prepared send or one that
	// can't be parsed (guardJournalRefusal in role-message-guard-store.ts; this checks its format, checksum and stage).
	let refusal = "";
	if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) refusal = "the journal can't be parsed";
	else {
		const { checksum, ...body } = bundle;
		if (
			body.format !== "role-message-guard-journal/v1" ||
			!["prepared", "committed"].includes(body.stage) ||
			!s ||
			typeof s !== "object" ||
			checksum !== digest(body)
		)
			refusal = "the journal can't be parsed (corrupt guard journal or unsupported schema)";
		else if (body.stage === "prepared")
			refusal = `the journal holds a prepared send (operation ${body.identity?.operationId ?? "unknown"})`;
	}
	if (refusal)
		stop(
			1,
			`${refusal}, so the next start would refuse a fresh start and leave the journal as it is. Nothing written.`,
		);

	// What the next start does with it (recover() in role-message-guard-store.ts): it opens the record as usual when
	// accepted.json matches the journal's copy, or the copy before its last transaction. Only an unreadable record is
	// started over, and only with a request.
	let why = "";
	if (!accepted) why = "accepted.json can't be read";
	else {
		const canonical = digest(accepted);
		if (canonical !== digest(bundle.legacy) && canonical !== bundle.beforeLegacyDigest)
			why = "accepted.json matches neither the journal's copy nor the one before its last transaction";
	}
	if (!why)
		stop(1, "the record is readable: the next start opens it as usual and would ignore a request. Nothing written.");
	say(`the record is unreadable: ${why}`);

	for (const name of FILES) {
		const quietAt = files[name].mtimeMs + QUIET_MS;
		if (now < quietAt)
			stop(
				1,
				`${name} changed less than 2 h ago, so the next start would refuse. Run this again after ${iso(quietAt)}. Nothing written.`,
			);
	}

	const path = join(guard, "fresh-start.json");
	if (existsSync(path)) {
		let earlier = "not readable";
		try {
			const r = JSON.parse(readFileSync(path, "utf8"));
			earlier = `generation ${r?.gen}, made ${typeof r?.at === "number" ? iso(r.at) : "?"}`;
		} catch {
			/* keep "not readable" */
		}
		say(`an earlier request is there (${earlier}); ${dryRun ? "it would be replaced" : "it is replaced"}`);
	}
	const request = {
		v: 1,
		gen,
		journalSha256: files["journal.json"].sha256,
		acceptedSha256: files["accepted.json"].sha256,
		at: now,
		expiresAt: now + LIFETIME_MS,
		reason,
	};
	const text = `${JSON.stringify(request, null, 2)}\n`;
	if (Buffer.byteLength(text, "utf8") > MAX_BYTES)
		stop(
			1,
			`the request would be ${Buffer.byteLength(text, "utf8")} bytes, over the 4 KiB the server reads; use a shorter --reason. Nothing written.`,
		);
	if (dryRun)
		say(
			`dry run: nothing written. Without --dry-run it writes ${path} (mode 0600), good until ${iso(request.expiresAt)}.`,
		);
	else {
		const tmp = `${path}.tmp-${process.pid}`;
		rmSync(tmp, { force: true });
		writeFileSync(tmp, text, { mode: 0o600 });
		fsyncPath(tmp);
		renameSync(tmp, path);
		fsyncPath(guard);
		say(`wrote ${path} (mode 0600), good until ${iso(request.expiresAt)}`);
	}
	say(
		`next start: keeps a byte-identical copy of gen-${gen} in archive-gen-${gen} (gen-${gen} stays too), begins generation ${gen + 1} with no open approvals (the last hour's sends still count toward the active hourly cap shown in the startup policy marker) and marks the request done (fresh-start.done-<ms>.json). Its log says "approval ladder: fresh start from generation ${gen} (old record kept in archive-gen-${gen})", then "approval ladder: on (...)".`,
	);
	say(
		'next step: install or restart with pi-web-deploy (pi-web-deploy <commit>, or pi-web-deploy restart); if the log says "approval ladder: fresh start refused (<why>)", the request stays here so the reason can be seen.',
	);
	process.exit(0);
} catch (err) {
	stop(2, `failed: ${err?.message ?? err}`);
}
