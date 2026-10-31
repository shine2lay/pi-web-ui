#!/usr/bin/env node
/**
 * chat-open-stats (Ops #690): how long real chat opens took, from the "chatopen" rows of the
 * connection log (server/chat-open-timing.ts). Read-only.
 *
 * Reads <dir>/conn-events.jsonl and its rolled days (conn-events-YYYY-MM-DD.jsonl). Counts only opens a
 * person made in a visible tab that the page reported on (outcome done); test browsers, hidden tabs,
 * failed or replaced opens and opens without a page report are counted apart, never in the times.
 *
 * Per device x loadedBefore (and per chat within it): n, median and p95 (nearest rank) of
 *   paint   click -> newest messages painted (toPaintMs; the owner's "open")
 *   done    click -> the server said done (toDoneMs)
 *   first   click -> first frame of the chat (toFirstFrameMs)
 *   server  request arrived -> server done (serverMs)
 *   load    request arrived -> the chat's snapshot started being built (loadMs)
 *
 * Usage: node scripts/chat-open-stats.mjs [--dir ~/.pi-web-ui] [--since <ISO|ms>] [--until <ISO|ms>] [--json]
 * Window filters by the request's arrival (`at`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const METRICS = {
	paint: "toPaintMs",
	done: "toDoneMs",
	first: "toFirstFrameMs",
	server: "serverMs",
	load: "loadMs",
};

function parseTime(v, name) {
	if (v === undefined) return undefined;
	const n = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
	if (!Number.isFinite(n)) throw new Error(`${name}: not a time: ${v}`);
	return n;
}

export function parseArgs(argv) {
	const out = { dir: join(homedir(), ".pi-web-ui"), since: undefined, until: undefined, json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--json") out.json = true;
		else if (a === "--dir") out.dir = argv[++i];
		else if (a === "--since") out.since = parseTime(argv[++i], "--since");
		else if (a === "--until") out.until = parseTime(argv[++i], "--until");
		else throw new Error(`unknown argument: ${a}`);
	}
	return out;
}

/** Every chatopen row in the folder's log files, oldest file first. */
export function readRows(dir) {
	const files = readdirSync(dir)
		.filter((f) => f === "conn-events.jsonl" || /^conn-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
		.sort((a, b) => (a === "conn-events.jsonl" ? 1 : b === "conn-events.jsonl" ? -1 : a.localeCompare(b)));
	const rows = [];
	for (const f of files) {
		for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
			if (!line.includes('"chatopen"')) continue;
			try {
				const r = JSON.parse(line);
				if (r && r.kind === "chatopen") rows.push(r);
			} catch {
				/* a torn line */
			}
		}
	}
	return rows;
}

/** Nearest-rank percentile of numbers (p in 0..100). */
export function percentile(values, p) {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
}

/** Why a row is left out of the times, or null when it counts. */
export function exclusion(r) {
	if (r.browser === false) return "not a browser";
	if (r.outcome === "noreport" || r.outcome === undefined) return "no page report";
	if (r.automated === true) return "test browser";
	if (r.visible === false || r.outcome === "hidden") return "hidden tab";
	if (r.outcome !== "done") return r.outcome;
	return null;
}

function stats(rows) {
	const out = { n: rows.length };
	for (const [name, field] of Object.entries(METRICS)) {
		const v = rows.map((r) => r[field]).filter((x) => typeof x === "number" && Number.isFinite(x));
		out[name] = { n: v.length, median: percentile(v, 50), p95: percentile(v, 95) };
	}
	return out;
}

const loadedWord = (v) => (v === true ? "loaded" : v === false ? "notLoaded" : "unknown");

export function summarize(rows, { since, until } = {}) {
	const inWindow = rows.filter(
		(r) => typeof r.at === "number" && (since === undefined || r.at >= since) && (until === undefined || r.at < until),
	);
	const excluded = {};
	const counted = [];
	for (const r of inWindow) {
		const why = exclusion(r);
		if (why) excluded[why] = (excluded[why] ?? 0) + 1;
		else counted.push(r);
	}
	const groups = new Map();
	for (const r of counted) {
		const key = `${r.device ?? "unknown"} ${loadedWord(r.loadedBefore)}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(r);
	}
	const result = [];
	for (const [key, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
		const [device, loaded] = key.split(" ");
		const chats = new Map();
		for (const r of rs) {
			const c = r.chat ?? "unknown";
			if (!chats.has(c)) chats.set(c, []);
			chats.get(c).push(r);
		}
		result.push({
			device,
			loadedBefore: loaded,
			...stats(rs),
			chats: [...chats]
				.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
				.map(([chat, cr]) => ({ chat, ...stats(cr) })),
		});
	}
	return { rows: inWindow.length, counted: counted.length, excluded, since, until, groups: result };
}

const fmt = (v) => (v === null || v === undefined ? "-" : `${(v / 1000).toFixed(2)}s`);

export function formatText(s) {
	const lines = [`chat opens: ${s.rows} rows, ${s.counted} counted`];
	const ex = Object.entries(s.excluded);
	if (ex.length) lines.push(`left out: ${ex.map(([k, n]) => `${k} ${n}`).join(", ")}`);
	const row = (label, st) =>
		`${label.padEnd(30)} n=${String(st.n).padStart(4)}  ` +
		Object.keys(METRICS)
			.map((m) => `${m} ${fmt(st[m].median)}/${fmt(st[m].p95)}`)
			.join("  ");
	lines.push("(median/p95)");
	for (const g of s.groups) {
		lines.push(row(`${g.device} ${g.loadedBefore}`, g));
		for (const c of g.chats) lines.push(row(`  chat ${c.chat}`, c));
	}
	return lines.join("\n");
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		const args = parseArgs(process.argv.slice(2));
		const s = summarize(readRows(args.dir), args);
		process.stdout.write(`${args.json ? JSON.stringify(s, null, 2) : formatText(s)}\n`);
	} catch (err) {
		process.stderr.write(`chat-open-stats: ${err.message}\n`);
		process.exit(2);
	}
}
