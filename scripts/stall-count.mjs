#!/usr/bin/env node
/**
 * stall-watch's independent count (Ops #283, docs/stall-watch.md): straight from the work registry's events,
 * without the server's code, the active projects and initiatives with no open task under them, since when, and
 * whether a wait keeps them quiet; and those with open tasks but no registry event for 24 h. The stall check's
 * `pi-web-ui stall list` must agree with it. Read only.
 *
 *   node scripts/stall-count.mjs [--events ~/.pi/agent/work/events.jsonl] [--at <ms or ISO>] [--json]
 *   node scripts/stall-count.mjs --from <ISO> --to <ISO> [--every 10]   # one line per step: who is flagged
 *
 * Open: ready, working, asking, stuck, waiting, blocked (or no status yet). Empty: flagged from 2 h after the
 * latest of its creation, its last status or lead change, its last open task leaving, a resume; a wait that
 * ran out is the grace already (due at its end). Silent here counts registry events only (the live check also
 * counts TL;DR lines and lead updates, and quiets owner-paused and owner-waiting tasks): candidates only.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => {
	const i = args.indexOf(n);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const time = (v) => (/^\d+$/.test(v) ? Number(v) : Date.parse(v));
const H = 3_600_000;
const OPEN = new Set(["ready", "working", "asking", "stuck", "waiting", "blocked"]);
const events = readFileSync(arg("--events", join(homedir(), ".pi/agent/work/events.jsonl")), "utf8")
	.split("\n")
	.slice(0, -1)
	.flatMap((l) => {
		try {
			const e = JSON.parse(l);
			return e && e.v === 1 && typeof e.op === "string" && typeof e.ts === "number" ? [e] : [];
		} catch {
			return [];
		}
	});

function count(at) {
	const items = new Map(); // "kind:id" -> {kind,id,lead,status,initiative,base,lastEvent,wait}
	const links = new Map(); // queue|task|added -> {parent, open}
	const bump = (it, f, t) => it && (it[f] = Math.max(it[f] ?? -Infinity, t));
	const of = (p) =>
		p?.project
			? items.get(`project:${p.project}`)
			: p?.initiative
				? items.get(`initiative:${p.initiative}`)
				: undefined;
	const touch = (it, t) => {
		if (!it) return;
		bump(it, "lastEvent", t);
		if (it.kind === "project" && it.initiative) bump(items.get(`initiative:${it.initiative}`), "lastEvent", t);
	};
	for (const e of events) {
		if (e.ts > at) continue;
		const [kind, act] = e.op.split(".");
		if (kind === "project" || kind === "initiative") {
			const key = `${kind}:${e.id}`;
			if (act === "create") {
				items.set(key, {
					kind,
					id: e.id,
					lead: e.lead,
					status: "active",
					initiative: kind === "project" ? (e.initiative ?? null) : undefined,
					base: e.ts,
				});
			}
			const it = items.get(key);
			if (!it) continue;
			touch(it, e.ts);
			if (act === "change" && e.changes) {
				const c = e.changes;
				const wasIni = it.initiative;
				const wasActive = it.status === "active";
				if (c.lead !== undefined) it.lead = c.lead;
				if (c.status !== undefined) it.status = c.status;
				if (c.initiative !== undefined) it.initiative = c.initiative;
				if (c.status !== undefined || c.lead !== undefined) bump(it, "base", e.ts);
				if (it.status !== "active") delete it.wait;
				if (kind === "project" && wasIni && wasActive && (it.status !== "active" || it.initiative !== wasIni))
					bump(items.get(`initiative:${wasIni}`), "base", e.ts);
			}
			if (act === "wait" && it.status === "active") it.wait = { until: e.until, at: e.ts, why: e.why };
			if (act === "resume") {
				delete it.wait;
				bump(it, "base", e.ts);
			}
			continue;
		}
		const k = `${e.queue}|${e.task}|${e.added}`;
		if (e.op === "task.link") {
			const was = links.get(k);
			const open = was ? was.open : true;
			if (was && JSON.stringify(was.parent) !== JSON.stringify(e.parent)) {
				touch(of(was.parent), e.ts);
				if (was.open) bump(of(was.parent), "base", e.ts);
			}
			links.set(k, { parent: e.parent, open, name: `${e.queueName || e.queue} #${e.task}` });
			touch(of(e.parent), e.ts);
		} else if (e.op === "task.state") {
			const l = links.get(k);
			if (!l) continue;
			const open = e.status === undefined || OPEN.has(e.status);
			touch(of(l.parent), e.ts);
			if (l.open && !open) bump(of(l.parent), "base", e.ts);
			l.open = open;
		}
	}
	const openOf = new Map();
	for (const l of links.values()) {
		if (!l.open) continue;
		const it = of(l.parent);
		if (it) openOf.set(it, (openOf.get(it) ?? 0) + 1);
	}
	const out = { at, flagged: [], pending: [], quiet: [], covered: [], silentCandidates: [] };
	for (const it of items.values()) {
		if (it.status !== "active") continue;
		const name = `${it.kind} ${it.id}`;
		if (it.kind === "initiative") {
			const act = [...items.values()].filter(
				(p) => p.kind === "project" && p.initiative === it.id && p.status === "active",
			);
			if (act.length) {
				out.covered.push(name);
				continue;
			}
		}
		let waitEnd = -Infinity;
		if (it.wait) {
			const end = Math.min(it.wait.until, it.wait.at + 14 * 24 * H);
			if (at < end) {
				out.quiet.push(`${name} (waits: ${it.wait.why})`);
				continue;
			}
			waitEnd = end;
		}
		const n = openOf.get(it) ?? 0;
		if (n) {
			const last = Math.max(it.lastEvent ?? -Infinity, it.wait?.at ?? -Infinity);
			if (Math.max(last + 24 * H, waitEnd) <= at) out.silentCandidates.push(`${name} (${n} open)`);
			continue;
		}
		const since = Math.max(it.base, waitEnd);
		const due = Math.max(it.base + 2 * H, waitEnd);
		(due <= at ? out.flagged : out.pending).push({ item: name, lead: it.lead, since });
	}
	return out;
}

if (args.includes("--from")) {
	const to = time(arg("--to", new Date().toISOString()));
	const every = Number(arg("--every", "10")) * 60_000;
	for (let t = time(arg("--from", "")); t <= to; t += every) {
		const c = count(t);
		console.log(JSON.stringify({ at: t, flagged: c.flagged.map((f) => `${f.item}@${f.since}`).sort() }));
	}
} else {
	const c = count(time(arg("--at", String(Date.now()))));
	if (args.includes("--json")) console.log(JSON.stringify(c, null, 2));
	else {
		const t = (ms) =>
			new Date(ms).toLocaleString("en-US", {
				hour12: false,
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
		console.log(
			`At ${t(c.at)}: ${c.flagged.length} empty and flagged, ${c.pending.length} empty not long enough, ${c.quiet.length} waiting, ${c.covered.length} covered initiatives, ${c.silentCandidates.length} silent candidates`,
		);
		for (const f of c.flagged) console.log(`  flagged ${f.item} (lead ${f.lead}), no open task since ${t(f.since)}`);
		for (const f of c.pending) console.log(`  pending ${f.item} (lead ${f.lead}), no open task since ${t(f.since)}`);
		for (const q of c.quiet) console.log(`  quiet ${q}`);
		for (const s of c.silentCandidates) console.log(`  silent? ${s}`);
	}
}
