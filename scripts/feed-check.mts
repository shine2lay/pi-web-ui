#!/usr/bin/env -S node --import tsx
/**
 * The second-hand check on one progress update, alone (task #85; Data rm-3bbf8e94, rm-981cbe12; AGENTS.md
 * rule 16): one update plus its linked records -> each sentence, its flags and why.
 *
 *   node --import tsx scripts/feed-check.mts --id up-1a2b3c4d          # an update kept in the store
 *   node --import tsx scripts/feed-check.mts --update update.json       # {changed, next, needs_you, impact,
 *                                                                       #  options, until, sources: [...]}
 *   ... --reader                 also run the reader (the cheapest Claude model; costs a short model call)
 *   ... --avoid a,b              with --reader: pool accounts not to ask (e.g. ones near their limit)
 *   ... --claims check.json      replay a saved check's reader answer (its reader.claims) instead of the model
 *   ... --dir <decisions dir>    default $PI_WEB_UI_DATA/decisions or ~/.pi-web-ui/decisions (read only)
 *   ... --json                   print the whole check as JSON
 *
 * Read only: it never writes the store. It prints results only, never what is sent to the model.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { DecisionRecord, UpdateFields } from "../server/decision-records.ts";
import type { DecisionEntry } from "../server/decision-store.ts";
import { isolatedDecisionModel } from "../server/decision-model.ts";
import {
	type ReaderClaim,
	type UpdateCheck,
	buildMaterial,
	checkUpdate,
	codeCheck,
	materialLookup,
	withReaderClaims,
} from "../server/feed-check.ts";

function usage(msg?: string): never {
	if (msg) console.error(`feed-check: ${msg}`);
	console.error(
		"usage: feed-check.mts (--id <update id> | --update <file.json>) [--reader | --claims <check.json>] [--dir <decisions dir>] [--json]",
	);
	process.exit(2);
}

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
	const i = args.indexOf(name);
	if (i < 0) return undefined;
	const v = args[i + 1];
	if (!v || v.startsWith("--")) usage(`${name} needs a value`);
	return v;
};
const flag = (name: string): boolean => args.includes(name);

const dir = resolve(opt("--dir") ?? join(process.env.PI_WEB_UI_DATA ?? join(homedir(), ".pi-web-ui"), "decisions"));
const id = opt("--id");
const file = opt("--update");
const claimsFile = opt("--claims");
const reader = flag("--reader");
if (!id === !file) usage("give exactly one of --id and --update");
if (reader && claimsFile) usage("--reader and --claims don't go together");

function readRecords(): DecisionRecord[] {
	let raw = "";
	try {
		raw = readFileSync(join(dir, "records.jsonl"), "utf8");
	} catch {
		usage(`no records.jsonl in ${dir}`);
	}
	const out: DecisionRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const r = JSON.parse(line) as DecisionRecord;
			if (r && typeof r.source === "string" && typeof r.ref === "string") out.push(r);
		} catch {
			/* a line cut off by a crash */
		}
	}
	return out;
}

function readDecisions(): DecisionEntry[] {
	try {
		const doc = JSON.parse(readFileSync(join(dir, "decisions.json"), "utf8")) as { decisions?: DecisionEntry[] };
		return Array.isArray(doc.decisions) ? doc.decisions : [];
	} catch {
		return [];
	}
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

const records = readRecords();
let update: UpdateFields;
let sources: string[];
if (id) {
	const rec = records.find((r) => r.id === id || r.ref === id);
	if (!rec || rec.source !== "update" || !rec.update) usage(`${id} is not an update in ${dir}`);
	update = rec.update;
	sources = rec.sources ?? [];
} else {
	const doc = JSON.parse(readFileSync(resolve(file as string), "utf8")) as Record<string, unknown>;
	update = {
		changed: text(doc.changed),
		next: text(doc.next),
		needsYou: text(doc.needs_you ?? doc.needsYou),
		...(text(doc.impact) ? { impact: text(doc.impact) } : {}),
		...(text(doc.options) ? { options: text(doc.options) } : {}),
		...(text(doc.until) ? { until: text(doc.until) } : {}),
	};
	sources = Array.isArray(doc.sources) ? doc.sources.map(String) : [];
}
if (!sources.length) usage("the update links no sources");

const look = materialLookup(records, readDecisions());
const missing = sources.filter((s) => (s.startsWith("dr-") ? !look.record(s) : !look.decision(s) && !look.change(s)));
const material = buildMaterial(sources, look);

let check: UpdateCheck;
if (claimsFile) {
	const saved = JSON.parse(readFileSync(resolve(claimsFile), "utf8")) as {
		reader?: { claims?: Record<string, ReaderClaim[]> };
	};
	const claims = saved.reader?.claims;
	if (!claims) usage(`${claimsFile} holds no reader claims`);
	check = {
		at: Date.now(),
		sentences: withReaderClaims(codeCheck(update, material), claims, material),
		reader: { at: Date.now(), model: "replayed" },
	};
} else {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	check = await checkUpdate(update, material, {
		model: reader ? isolatedDecisionModel({ cwd: process.cwd(), agentDir }) : undefined,
		reader,
		avoid: (opt("--avoid") ?? "").split(",").filter(Boolean),
	});
}

if (flag("--json")) {
	console.log(JSON.stringify({ sources, missing, material: material.map((m) => m.id), check }, null, 2));
	process.exit(0);
}

console.log(`linked: ${sources.join(", ")}${missing.length ? ` (not found: ${missing.join(", ")})` : ""}`);
console.log(`material: ${material.length} items`);
const r = check.reader;
console.log(
	`reader: ${r?.error ? `failed: ${r.error}` : r?.skipped ? `not run (${r.skipped})` : `${r?.model ?? "?"}`}`,
);
let flagged = 0;
for (const s of check.sentences) {
	const field = s.field === "needsYou" ? "needs you" : s.field;
	console.log(`\n[${s.n}] ${field}: ${s.text}`);
	if (!s.flags.length) console.log("    ok");
	for (const f of s.flags) console.log(`    FLAG ${f.kind} (${f.by}): "${f.claim}" - ${f.why}`);
	if (s.flags.length) flagged++;
}
console.log(`\n${flagged} of ${check.sentences.length} sentences flagged`);
