#!/usr/bin/env -S node --import tsx
/**
 * roles-asks-read (Ops #268, docs/roles-asks-read.md): sealed timing of the Roles overview build when a
 * role has many started task chats. The real reader (server/roles-overview.ts) with a fake host over a
 * synthetic fixture: 15 roles, one ("design") with --big started task chats, the rest with 3 each; task
 * chats of realistic size (1, 2.3, 2.3, 4.2, 8 MB in turn: the live p50 2.3 MB, p75 4.2 MB, p90 8 MB,
 * Oct 2026), home chats of 5 MB. It times cold builds (a new reader each) and warm builds of one reader:
 * with every file unchanged, and after a small append to every started task chat (all of them busy).
 *
 *   scripts/sealed.sh node --import tsx scripts/roles-asks-timing.mts [--big 40] [--runs 10]
 *
 * Prints the reader's caps, sizes and times only (one JSON line). The fixture's chats are synthetic,
 * live in the sealed temp folder and are removed afterwards; no chat of the owner's is read.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { IdentityDef } from "../server/identities.ts";
import type { UiRolesOverview } from "../server/protocol.ts";
import * as overviewModule from "../server/roles-overview.ts";

const { RolesOverviewReader } = overviewModule;
type Host = ConstructorParameters<typeof RolesOverviewReader>[0];

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`);
	const v = i >= 0 ? Number(process.argv[i + 1]) : fallback;
	if (!Number.isInteger(v) || v < 1) throw new Error(`--${name} must be a whole number`);
	return v;
};
const BIG = arg("big", 40);
const RUNS = arg("runs", 10);
const ROLE_IDS = [
	"architecture",
	"backend",
	"coo",
	"data",
	"design",
	"docs",
	"frontend",
	"marketing",
	"ops",
	"product",
	"qa",
	"rollcall",
	"security",
	"systems",
	"temper",
];
const MB = 1_000_000;
const TASK_SIZES = [1.0, 2.3, 2.3, 4.2, 8.0].map((x) => Math.round(x * MB));
const HOME_SIZE = 5 * MB;
const T0 = Date.parse("2026-10-19T12:00:00Z");

const dir = mkdtempSync(join(tmpdir(), "roles-asks-timing-"));
const sessions = join(dir, "sessions");
mkdirSync(sessions, { recursive: true });

let seq = 0;
const id8 = () => (++seq).toString(16).padStart(8, "0");
const iso = (ms: number) => new Date(ms).toISOString();
const FILL = "fixture words for a realistic transcript line, nothing more. ".repeat(80);
const text = (n: number) => FILL.slice(0, n);
/** One transcript line shaped like the SDK writes it (kinds the reader skips, and the ones it keeps). */
function line(kind: "user" | "assistant" | "tool" | "tldr", ts: number): string {
	const base = { id: id8(), parentId: null, timestamp: iso(ts) };
	if (kind === "user")
		return JSON.stringify({
			type: "message",
			...base,
			message: { role: "user", content: [{ type: "text", text: text(300) }], timestamp: ts },
		});
	if (kind === "assistant")
		return JSON.stringify({
			type: "message",
			...base,
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: text(1200) },
					{ type: "text", text: text(900) },
					{ type: "toolCall", id: `call-${seq}`, name: "bash", arguments: { command: text(400) } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "fixture-model",
				usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 60 },
				stopReason: "toolUse",
				timestamp: ts,
			},
		});
	if (kind === "tool")
		return JSON.stringify({
			type: "message",
			...base,
			message: {
				role: "toolResult",
				toolCallId: `call-${seq}`,
				toolName: "bash",
				content: [{ type: "text", text: text(2400) }],
				isError: false,
				timestamp: ts,
			},
		});
	return JSON.stringify({
		type: "custom",
		customType: "tldr",
		data: { v: 1, text: `Fixture TL;DR line ${seq}`, needsYou: false, ts },
		...base,
	});
}
/** Lines until the file reaches `size` bytes: a user line, nine tool rounds, an answer; a TL;DR line every third block. */
function filler(size: number, start: number): string[] {
	const out: string[] = [];
	let bytes = 0;
	let ts = start;
	for (let block = 0; bytes < size; block++) {
		const kinds: Array<"user" | "assistant" | "tool" | "tldr"> = ["user"];
		for (let i = 0; i < 9; i++) kinds.push("assistant", "tool");
		kinds.push("assistant");
		if (block % 3 === 2) kinds.push("tldr");
		for (const k of kinds) {
			const l = line(k, (ts += 1000));
			out.push(l);
			bytes += l.length + 1;
		}
	}
	return out;
}
const custom = (customType: string, data: Record<string, unknown>, ts: number) =>
	JSON.stringify({
		type: "custom",
		customType,
		data: { v: 1, ts, ...data },
		id: id8(),
		parentId: null,
		timestamp: iso(ts),
	});
function transcript(name: string, head: string[], size: number): string {
	const file = join(sessions, `${name}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: name, timestamp: iso(T0), cwd: dir }),
		JSON.stringify({
			type: "model_change",
			id: id8(),
			parentId: null,
			timestamp: iso(T0),
			provider: "anthropic",
			modelId: "fixture-model",
		}),
		...head,
	];
	const used = lines.reduce((n, l) => n + l.length + 1, 0);
	lines.push(...filler(Math.max(0, size - used), T0));
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}
const plan = (title: string) => ({
	title,
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
});

// ---- the fixture -------------------------------------------------------------------------------------------
const started: string[] = [];
let totalBytes = 0;
let bigBytes = 0;
const roles: IdentityDef[] = ROLE_IDS.map((id, r) => {
	const n = id === "design" ? BIG : 3;
	const chats: string[] = [];
	for (let i = 1; i <= n; i++) {
		const size = TASK_SIZES[(i - 1 + r) % TASK_SIZES.length];
		chats.push(transcript(`${id}-task-${i}`, [], size));
		totalBytes += size;
		if (id === "design") bigBytes += size;
	}
	started.push(...chats);
	const ops: string[] = [custom("queue", { op: "lanes", n }, T0)];
	for (let i = 1; i <= n; i++)
		ops.push(custom("queue", { op: "add", id: i, plan: plan(`T${i}`), touches: [`r${i}`] }, T0));
	ops.push(custom("queue", { op: "run" }, T0));
	for (let i = 1; i <= n; i++) {
		ops.push(custom("queue", { op: "start", id: i, lane: true }, T0));
		ops.push(custom("queue", { op: "chat", id: i, file: chats[i - 1], title: `Task ${i}` }, T0));
	}
	const home = transcript(`${id}-home`, ops, HOME_SIZE);
	totalBytes += HOME_SIZE;
	return {
		id,
		title: `${id} role`,
		homeChat: home,
		pastHomeChats: [],
		raw: {},
		dir: join(dir, "identities", id),
		role: { config: { workMode: null, goals: null }, problems: [] },
	} as unknown as IdentityDef;
});

const host: Host = {
	identities: () => roles,
	chatState: () => "closed",
	asks: () => [],
	openRequestsTo: () => ({ open: 0 }),
	latestReportTo: () => undefined,
	rolePaused: () => false,
	sessionRoots: () => [sessions],
	reportRunsFile: () => join(dir, "state", "runs.json"),
	schedulerJobsFile: () => join(dir, "scheduler", "jobs.json"),
	now: () => T0 + 3_600_000,
};

// ---- the timing ----------------------------------------------------------------------------------------------
const time = async (reader: InstanceType<typeof RolesOverviewReader>) => {
	const t = performance.now();
	const o = await reader.read();
	return { ms: performance.now() - t, o };
};
const stats = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	const rank = (p: number) => s[Math.min(s.length, Math.max(1, Math.ceil(p * s.length))) - 1];
	const r = (x: number) => Math.round(x * 10) / 10;
	return { p50: r(rank(0.5)), p90: r(rank(0.9)), max: r(s[s.length - 1]), all: s.map(r) };
};
const designOf = (o: UiRolesOverview) => {
	const role = o.roles.find((x) => x.id === "design");
	const active = role?.queue?.active ?? [];
	const flags = role as unknown as Record<string, unknown> | undefined;
	return {
		active: active.length,
		// a started task whose chat was read fully has its latest TL;DR line
		readFully: active.filter((t) => t.latest).length,
		problems: role?.problems ?? [],
		allChatsRead: flags?.allChatsRead,
	};
};
try {
	const cold: number[] = [];
	for (let i = 0; i < 3; i++) cold.push((await time(new RolesOverviewReader(host))).ms);
	const reader = new RolesOverviewReader(host);
	await time(reader);
	const same: number[] = [];
	let last: UiRolesOverview | undefined;
	for (let i = 0; i < RUNS; i++) {
		const r = await time(reader);
		same.push(r.ms);
		last = r.o;
	}
	const appended: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const ts = T0 + 7_200_000 + i * 1000;
		for (const f of started) appendFileSync(f, `${line("assistant", ts)}\n`);
		const r = await time(reader);
		appended.push(r.ms);
		last = r.o;
	}
	const caps = Object.fromEntries(
		Object.entries(overviewModule).filter(([k, v]) => k.startsWith("ROLES_TASK_CHATS") && typeof v === "number"),
	);
	console.log(
		JSON.stringify({
			caps,
			roles: roles.length,
			big: BIG,
			startedChats: started.length,
			bigMB: Math.round(bigBytes / MB),
			totalMB: Math.round(totalBytes / MB),
			coldMs: stats(cold),
			warmSameMs: stats(same),
			warmAppendMs: stats(appended),
			design: last ? designOf(last) : null,
		}),
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
