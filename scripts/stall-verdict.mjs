#!/usr/bin/env node
// stall-wake (Ops #284, docs/stall-watch.md "H-STALL-WAKE-1"): the 24 h measure of the stall check's wakes, read
// only, from the stall ledger and the work registry (no model, no writes).
//
//   node scripts/stall-verdict.mjs [--since <ISO time or ms>] [--hours 24] [--ledger <file>] [--events <file>]
//                                  [--store <role-messages.json>] [--gap-hours 2] [--json]
//
// Counts, for the stretches whose first step was recorded in the window (including held/capped):
// - flagged: distinct stretches found (not just those whose message went);
// - acted: stretches with a lead action on their item after step 1: a task linked under it (task.link with that
//   parent), a status or lead change (project.change / initiative.change), a wait (project.wait /
//   initiative.wait) or a done-when item met (project.met / initiative.met);
// - steps sent, by state; cap hits ("capped" lines);
// - duplicates: a (stretch, step) sent more than once, or a role message store record for one that the ledger
//   doesn't match;
// - cap breaches: more than 6 messages to one recipient in a local day, or more than 20 in any hour;
// - owner steps without both earlier steps at least gap hours apart.
// HIT: no duplicate, no cap breach, no early owner step, and acted >= half of flagged after the full window.
// Exit 0 HIT, 1 MISS, 2 PENDING/NOTHING, 3 bad input. An early read never calls the 24 h action bar a miss.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? def : args[i + 1];
};
const HOUR = 3_600_000;
const ledgerFile = opt("ledger", join(homedir(), ".pi-web-ui", "stall-watch.jsonl"));
const eventsFile = opt(
	"events",
	join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "work", "events.jsonl"),
);
const storeFile = opt("store", join(homedir(), ".pi-web-ui", "role-messages.json"));
const hours = Number(opt("hours", "24"));
const gapHours = Number(opt("gap-hours", "2"));
const asJson = args.includes("--json");
const DAY_CAP = 6;
const HOUR_CAP = 20;

const jsonl = (file) =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.flatMap((l) => {
					try {
						return [JSON.parse(l)];
					} catch {
						return [];
					}
				})
		: [];

if (!existsSync(ledgerFile)) {
	console.error(`No stall ledger at ${ledgerFile}: the check hasn't sent or recorded anything yet.`);
	process.exit(3);
}
for (const file of [eventsFile, storeFile]) {
	if (!existsSync(file)) {
		console.error(`Missing evidence file ${file}; restore it or pass --events/--store with the right location.`);
		process.exit(3);
	}
}
const ledger = jsonl(ledgerFile);
const sent = ledger.filter((l) => l.state === "sent");
const sinceRaw = opt("since", undefined);
const since =
	sinceRaw === undefined
		? Math.min(...ledger.map((l) => l.at), Number.POSITIVE_INFINITY)
		: /^\d+$/.test(sinceRaw)
			? Number(sinceRaw)
			: Date.parse(sinceRaw);
if (
	!Number.isFinite(hours) ||
	hours <= 0 ||
	!Number.isFinite(gapHours) ||
	gapHours < 0 ||
	(!Number.isFinite(since) && (sinceRaw !== undefined || sent.length > 0))
) {
	console.error(`Bad --since ${sinceRaw}`);
	process.exit(3);
}
const until = since + hours * HOUR;
const inWindow = (l) => l.at >= since && l.at < until;

const parse = (stretch) => {
	const [kind, ...rest] = stretch.split(":");
	const tail = rest.slice(-2);
	return { kind, id: rest.slice(0, -2).join(":"), rule: tail[0], since: Number(tail[1]) };
};

// The first recorded step 1 defines the cohort; a cap or owner's pause must not hide a flagged stretch.
const firstAt = new Map();
for (const l of ledger)
	if (l.step === 1 && inWindow(l) && (!firstAt.has(l.stretch) || l.at < firstAt.get(l.stretch)))
		firstAt.set(l.stretch, l.at);

const events = jsonl(eventsFile);
const actionOf = (kind, id, after) =>
	events.find((e) => {
		if (typeof e.ts !== "number" || e.ts < after || e.ts >= until) return false;
		if (e.op === "task.link") return e.parent?.[kind] === id;
		if (e.id !== id) return false;
		if (e.op === `${kind}.change`) return typeof e.status === "string" || typeof e.lead === "string";
		return [`${kind}.wait`, `${kind}.met`].includes(e.op);
	});

const stretches = [...firstAt].map(([stretch, at]) => {
	const p = parse(stretch);
	const a = actionOf(p.kind, p.id, at);
	return { stretch, firstAt: at, acted: a ? { op: a.op, at: a.ts, by: a.by } : null };
});
const acted = stretches.filter((s) => s.acted).length;

// Duplicates: a (stretch, step) sent more than once.
const seen = new Map();
const duplicates = [];
for (const l of sent) {
	const k = `${l.stretch}#${l.step}`;
	if (seen.has(k) && seen.get(k) !== l.id)
		duplicates.push({ stretch: l.stretch, step: l.step, ids: [seen.get(k), l.id] });
	else seen.set(k, l.id);
}
// ... and store records for a step the ledger holds under another id.
let storeRecords = 0;
if (existsSync(storeFile)) {
	try {
		const store = JSON.parse(readFileSync(storeFile, "utf8"));
		for (const m of store.messages ?? []) {
			if (!m.stall?.items) continue;
			storeRecords++;
			for (const it of m.stall.items) {
				const k = `${it.kind}:${it.id}:${it.rule}:${it.since}#${it.step}`;
				const id = seen.get(k);
				if (id && id !== m.id)
					duplicates.push({ stretch: k.split("#")[0], step: it.step, ids: [id, m.id], from: "store" });
				if (!id && inWindow(m))
					duplicates.push({
						stretch: k.split("#")[0],
						step: it.step,
						ids: [m.id],
						from: "store (missing ledger line)",
					});
			}
		}
	} catch (err) {
		console.error(`Couldn't read the role message store ${storeFile}: ${err.message}`);
		process.exit(3);
	}
}

// Caps: distinct messages per recipient per local day, and in any hour.
const localDay = (ms) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
const msgs = new Map();
for (const l of sent) if (!msgs.has(l.id ?? `${l.stretch}#${l.step}`)) msgs.set(l.id ?? `${l.stretch}#${l.step}`, l);
const capBreaches = [];
const perDay = new Map();
for (const l of msgs.values()) {
	const k = `${l.to} ${localDay(l.at)}`;
	perDay.set(k, (perDay.get(k) ?? 0) + 1);
}
for (const [k, n] of perDay) if (n > DAY_CAP) capBreaches.push(`${k}: ${n} messages (cap ${DAY_CAP})`);
const times = [...msgs.values()].map((l) => l.at).sort((a, b) => a - b);
for (let i = 0; i < times.length; i++) {
	const n = times.filter((t) => t >= times[i] && t < times[i] + HOUR).length;
	if (n > HOUR_CAP) {
		capBreaches.push(`${n} messages in the hour from ${new Date(times[i]).toISOString()} (cap ${HOUR_CAP})`);
		break;
	}
}

// Owner steps: every earlier step recorded final, each at least gap hours after the one before.
const FINAL = new Set(["sent", "wakes-off", "no-chat"]);
const earlyOwner = [];
for (const o of sent.filter((l) => l.owner)) {
	let prev;
	for (let step = 1; step <= o.step; step++) {
		const l =
			step === o.step
				? o
				: ledger
						.filter((x) => x.stretch === o.stretch && x.step === step && FINAL.has(x.state))
						.sort((a, b) => a.at - b.at)[0];
		if (!l) {
			earlyOwner.push(`${o.stretch}: step ${step} missing before the owner's step`);
			break;
		}
		if (prev !== undefined && l.at - prev < gapHours * HOUR) {
			earlyOwner.push(
				`${o.stretch}: step ${step} only ${Math.round((l.at - prev) / 60_000)} min after step ${step - 1}`,
			);
			break;
		}
		prev = l.at;
	}
}

const byState = {};
for (const l of ledger.filter(inWindow)) byState[l.state] = (byState[l.state] ?? 0) + 1;
const result = {
	window: {
		since: Number.isFinite(since) ? new Date(since).toISOString() : null,
		hours,
		complete: Date.now() >= until,
	},
	flagged: stretches.length,
	acted,
	actedShare: stretches.length ? acted / stretches.length : null,
	messagesSent: [...msgs.values()].filter(inWindow).length,
	stepsByState: byState,
	capHits: byState.capped ?? 0,
	storeRecords,
	duplicates,
	capBreaches,
	earlyOwner,
	stretches,
};
const safe = !duplicates.length && !capBreaches.length && !earlyOwner.length;
result.verdict = !safe
	? "MISS"
	: stretches.length === 0
		? "NOTHING"
		: !result.window.complete
			? "PENDING"
			: acted * 2 >= stretches.length
				? "HIT"
				: "MISS";

if (asJson) console.log(JSON.stringify(result, null, 2));
else {
	console.log(`Stall wakes from ${result.window.since ?? "-"} for ${hours} h: ${result.verdict}`);
	console.log(
		`- stretches flagged ${result.flagged}, ended with a lead action ${acted}${stretches.length ? ` (${Math.round((acted / stretches.length) * 100)}%, needs 50%)` : ""}`,
	);
	console.log(`- messages sent ${result.messagesSent}; steps ${JSON.stringify(byState)}; cap hits ${result.capHits}`);
	console.log(
		`- duplicates ${duplicates.length}; cap breaches ${capBreaches.length}; early owner steps ${earlyOwner.length}`,
	);
	for (const d of duplicates)
		console.log(`  duplicate: ${d.stretch} step ${d.step}: ${d.ids.join(", ")}${d.from ? " (store)" : ""}`);
	for (const c of capBreaches) console.log(`  cap: ${c}`);
	for (const e of earlyOwner) console.log(`  owner step: ${e}`);
	for (const s of stretches)
		console.log(
			`  ${s.acted ? "acted" : "no action"}: ${s.stretch}${s.acted ? ` (${s.acted.op} by ${s.acted.by} ${new Date(s.acted.at).toISOString()})` : ""}`,
		);
}
process.exit(result.verdict === "HIT" ? 0 : result.verdict === "MISS" ? 1 : 2);
