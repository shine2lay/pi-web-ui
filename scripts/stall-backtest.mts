#!/usr/bin/env -S node --import tsx
/**
 * stall-watch's backtest (Ops #283, docs/stall-watch.md): replays the work registry's events every 10 minutes
 * over a past stretch with the stall check's own rules, and prints when each project or initiative would have
 * been flagged, for which rule, since when, and whom it would have woken, in turn. Read only.
 *
 *   TZ=America/Los_Angeles node --import tsx scripts/stall-backtest.mts \
 *     [--events ~/.pi/agent/work/events.jsonl] [--records ~/.pi-web-ui/decisions/records.jsonl] \
 *     [--from 2026-10-19T00:00-07:00] [--to 2026-10-20T09:00-07:00] [--every 10] [--json]
 *
 * It replays what the registry recorded (projects, initiatives, task links and states, waits) and the lead
 * updates kept in the decision records. The queues' live facts of the past (owner pauses, questions waiting on
 * the owner, TL;DR lines) aren't recorded anywhere, so they don't count here; the live check has them.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workPageFrom } from "../server/work-page.ts";
import { STALL_DEFAULTS, leadUpdatesOf, stallReview, stallTime, stallTimesFrom } from "../server/stall-watch.ts";

const args = process.argv.slice(2);
const arg = (name: string, d: string) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const eventsFile = arg("--events", join(homedir(), ".pi/agent/work/events.jsonl"));
const recordsFile = arg("--records", join(homedir(), ".pi-web-ui/decisions/records.jsonl"));
const from = Date.parse(arg("--from", "2026-10-19T00:00:00-07:00"));
const to = Date.parse(arg("--to", "2026-10-20T09:00:00-07:00"));
const everyMs = Number(arg("--every", "10")) * 60_000;
const asJson = args.includes("--json");
if (!Number.isFinite(from) || !Number.isFinite(to) || !(everyMs > 0)) {
	console.error("bad --from, --to or --every");
	process.exit(2);
}

// The registry's complete lines, each with its time, in the file's order.
const lines = readFileSync(eventsFile, "utf8")
	.split("\n")
	.filter((l) => l.trim())
	.map((l) => {
		try {
			const ts = (JSON.parse(l) as { ts?: unknown }).ts;
			return { l, ts: typeof ts === "number" ? ts : Number.POSITIVE_INFINITY };
		} catch {
			return { l, ts: Number.POSITIVE_INFINITY };
		}
	});
// The lead updates (the progress feed's kept records), read without the rest of the 20 MB.
const updates: { initiative: string; at: number }[] = [];
try {
	for (const l of readFileSync(recordsFile, "utf8").split("\n")) {
		if (!l.includes('"update"')) continue;
		try {
			const r = JSON.parse(l) as { source?: string; initiative?: string; at?: number; update?: unknown };
			if (r.source === "update" && r.initiative && r.update && typeof r.at === "number")
				updates.push({ initiative: r.initiative, at: r.at });
		} catch {
			/* a half-written line */
		}
	}
} catch {
	/* no records: no lead updates */
}

interface Row {
	kind: string;
	id: string;
	lead: string;
	rule: string;
	since: number;
	flaggedAt: number;
	chain: string[];
	clearedAt?: number;
	clearedWhy?: string;
}
const rows: Row[] = [];
const open = new Map<string, Row>();
let lastItems: ReturnType<typeof stallReview>["items"] = [];
for (let t = from; t <= to; t += everyMs) {
	const text = lines
		.filter((x) => x.ts <= t)
		.map((x) => `${x.l}\n`)
		.join("");
	const page = workPageFrom(text, [], t);
	const extra = { times: stallTimesFrom(text), leadUpdates: leadUpdatesOf(updates, t) };
	const review = stallReview(page, extra, t, STALL_DEFAULTS);
	const now = new Set<string>();
	for (const f of review.findings) {
		now.add(f.stretch);
		if (open.has(f.stretch)) continue;
		const lead = (f.kind === "project" ? page.projects : page.initiatives).find((r) => r.id === f.id)?.lead ?? "";
		const row: Row = { kind: f.kind, id: f.id, lead, rule: f.rule, since: f.since, flaggedAt: t, chain: f.chain };
		rows.push(row);
		open.set(f.stretch, row);
	}
	for (const [k, row] of open) {
		if (now.has(k)) continue;
		row.clearedAt = t;
		const item = review.items.find((i) => i.kind === row.kind && i.id === row.id);
		const rec = (row.kind === "project" ? page.projects : page.initiatives).find((r) => r.id === row.id);
		row.clearedWhy = item ? `${item.state}: ${item.why}` : rec ? `status ${rec.status}` : "gone";
		open.delete(k);
	}
	lastItems = review.items;
}

const hm = (ms: number) => `${Math.floor(ms / 3_600_000)} h ${String(Math.round((ms % 3_600_000) / 60_000)).padStart(2, "0")} min`;
if (asJson) {
	console.log(JSON.stringify({ from, to, everyMs, rows, lastItems }, null, 2));
} else {
	console.log(`Backtest ${stallTime(from)} to ${stallTime(to)}, every ${everyMs / 60_000} min (${process.env.TZ ?? "local time"})`);
	console.log("");
	console.log("| item | lead | rule | since | first flagged | after | chain | cleared |");
	console.log("|---|---|---|---|---|---|---|---|");
	for (const r of rows) {
		const after = hm(r.flaggedAt - Math.max(r.since, from));
		const cleared = r.clearedAt ? `${stallTime(r.clearedAt)} (${r.clearedWhy})` : "still flagged";
		console.log(
			`| ${r.kind} ${r.id} | ${r.lead} | ${r.rule} | ${stallTime(r.since)} | ${stallTime(r.flaggedAt)} | ${after} | ${r.chain.join(" → ")} | ${cleared} |`,
		);
	}
	console.log("");
	console.log(`At ${stallTime(to)}, every active item:`);
	console.log("");
	console.log("| item | lead | state | why |");
	console.log("|---|---|---|---|");
	for (const i of lastItems) console.log(`| ${i.kind} ${i.id} | ${i.lead} | ${i.state} | ${i.why} |`);
}
