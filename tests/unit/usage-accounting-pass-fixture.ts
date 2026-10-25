// Ops #423 B3: runs design B's pass inside a Worker on synthetic copies only (never a real chat file).
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	readFileSync,
	truncateSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getHeapStatistics, setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";
import {
	accountUsage,
	factId,
	observeUsage,
	parseAccountingInput,
	type AccountingInput,
	type IdentityAlias,
	type UsageFact,
} from "../../server/usage-accounting-contract.js";
import {
	PASS_LIMITS,
	buildPassInput,
	closePassState,
	foldCandidate,
	openPassState,
	runPass,
	type PassBudget,
	type PassOptions,
	type PassResult,
	type PassState,
} from "../../server/usage-accounting-pass.js";
import { passFileKey } from "../../server/usage-accounting-pass-scan.js";
import { PiSessionUsageReader } from "../../server/usage-accounting-pi-sessions.js";
import { buildUsageMeterSnapshot, type SnapshotPartition } from "../../server/usage-accounting-snapshot.js";

const { name, dir, fixtures } = workerData as { name: string; dir: string; fixtures: string };
const lease = new SharedArrayBuffer(4);
const EPOCH = "a".repeat(64);
const WEEK_START = "2026-10-19T07:00:00.000Z";
const AS_OF = "2026-10-20T12:00:00.000Z";
const OPTIONS = { policyRef: "fixture:design-policy", asOf: AS_OF, staleAfterMs: 3_600_000 };
const DESIGN = [{ subject: { kind: "role" as const, role: "design" }, policy: null }];
const sessions = join(dir, "sessions");
const clock = { t: Date.parse(AS_OF) };

function open(extra: Partial<PassOptions> = {}): PassState {
	mkdirSync(extra.dataDir ?? join(dir, "data"), { recursive: true, mode: 0o700 });
	return openPassState({
		dataDir: join(dir, "data"),
		lease,
		epoch: EPOCH,
		sessionRoots: [sessions],
		temperRoots: [],
		ledgerDirectory: null,
		production: "disabled",
		now: () => clock.t,
		subjects: DESIGN,
		roleOf: () => ({ role: "design", evidenceRef: "fixture-only:verified-role" }),
		...extra,
	});
}
/** The current week's committed fact and alias rows, from the store's hash-checked replay (native streams). */
function rowsOf(s: PassState) {
	const facts: UsageFact[] = [],
		aliases: IdentityAlias[] = [];
	let cursor: Parameters<PassState["store"]["observations"]>[1] = null;
	do {
		const page = s.store.observations(s.cur!.week, cursor, 4096);
		for (const o of page.observations)
			if (o.o === "fact") facts.push(o.r);
			else if (o.o === "alias") aliases.push(o.r);
		cursor = page.next;
	} while (cursor !== null);
	return { facts, aliases };
}
/** Contract totals over the committed week, replayed by a fresh pass state (never the writer's memory). */
function observed(s: PassState, asOf: string) {
	const { facts, aliases } = rowsOf(s);
	const streams = [...new Set(facts.map((f) => f.source.stream))].sort();
	const input = {
		v: 1,
		facts,
		aliases,
		allocations: [],
		roots: [],
		policies: [],
		memberships: [],
		snapshots: [],
		coverage: streams.map((stream) => ({
			stream,
			from: WEEK_START,
			through: asOf,
			observedAt: asOf,
			status: "complete",
		})),
		requiredStreams: streams,
	};
	const r = observeUsage(input, { asOf, staleAfterMs: 3_600_000, window: { from: WEEK_START, through: asOf } });
	return { gross: r.grossKnownListUsd, dedup: r.dedupKnownListUsd, facts: facts.length, aliases: aliases.length };
}
function meter(s: PassState, at: string) {
	const snapshot = buildUsageMeterSnapshot(buildPassInput(s, at, true));
	const subject = snapshot.subjects[0];
	return {
		state: snapshot.state,
		list: subject?.list ?? null,
		coverage: subject?.usageCoverage ?? null,
		unresolved: subject?.counts.unresolvedIdentities ?? null,
		faults: [...snapshot.faults, ...(subject?.faults ?? [])],
	};
}
function faults(r: PassResult): Record<string, number> {
	return Object.fromEntries((r.input?.evidence.faultCounts ?? []).map((f) => [f.code, f.count]));
}
function brief(r: PassResult) {
	return { status: r.status, completed: r.completed, faults: faults(r), ...r.stats };
}
async function until(s: PassState, budget: PassBudget = PASS_LIMITS, max = 50) {
	const seen: ReturnType<typeof brief>[] = [];
	for (let i = 0; i < max; i++) {
		const r = await runPass(s, budget);
		seen.push(brief(r));
		if (r.status !== "catching-up") break;
	}
	return seen;
}
/** Replays the committed week in a fresh state and returns its contract totals. */
async function replayed(asOf = AS_OF, extra: Partial<PassOptions> = {}) {
	const s = open(extra);
	try {
		const r = await runPass(s);
		return { pass: brief(r), totals: observed(s, asOf) };
	} finally {
		closePassState(s);
	}
}
const SESSION_FILES = ["plain", "fork", "resume-copy", "delegate"];
function stamp(file: string, at: string): void {
	const t = new Date(at);
	utimesSync(file, t, t);
}
function copySessions(names = SESSION_FILES, at = "2026-10-20T11:00:00.000Z"): void {
	mkdirSync(join(sessions, "cwd"), { recursive: true, mode: 0o700 });
	for (const n of names) {
		const to = join(sessions, "cwd", `${n}.jsonl`);
		copyFileSync(join(fixtures, "usage-accounting-pi-sessions", `${n}.jsonl`), to);
		stamp(to, at);
	}
}
/** #304 reference: one fresh reader instance, parents first, every row of every file, contract totals. */
async function direct(names = SESSION_FILES, asOf = AS_OF) {
	const reader = new PiSessionUsageReader();
	const facts: UsageFact[] = [],
		aliases: IdentityAlias[] = [];
	for (const n of names) {
		let cursor = null;
		for (let i = 0; i < 100; i++) {
			const r = await reader.read({
				file: join(sessions, "cwd", `${n}.jsonl`),
				producer: "pi",
				from: WEEK_START,
				through: asOf,
				observedAt: asOf,
				cursor,
			});
			facts.push(...(r.batch?.rows.facts ?? []));
			aliases.push(...(r.batch?.rows.aliases ?? []));
			if (r.endOfFile || !r.cursor || r.cursor.token === cursor?.token) break;
			cursor = r.cursor;
		}
	}
	const streams = [...new Set(facts.map((f) => f.source.stream))].sort();
	const r = observeUsage(
		{
			v: 1,
			facts,
			aliases,
			allocations: [],
			roots: [],
			policies: [],
			memberships: [],
			snapshots: [],
			coverage: streams.map((stream) => ({
				stream,
				from: WEEK_START,
				through: asOf,
				observedAt: asOf,
				status: "complete",
			})),
			requiredStreams: streams,
		},
		{ asOf, staleAfterMs: 3_600_000, window: { from: WEEK_START, through: asOf } },
	);
	return { gross: r.grossKnownListUsd, dedup: r.dedupKnownListUsd };
}
function entry(id: string, at: string, cost = 0.1): string {
	return (
		JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: at,
			message: {
				role: "assistant",
				timestamp: at,
				provider: "fixture-provider",
				model: "fixture-model",
				responseId: `response-${id}`,
				usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: cost } },
				content: [],
			},
		}) + "\n"
	);
}
function header(id: string, at: string): string {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: at, cwd: "/synthetic-only" }) + "\n";
}

// W0's known cases (tests/unit/usage-accounting-collector.test.ts), built the same way.
function ledgerInput(): AccountingInput {
	const parsed = parseAccountingInput(
		JSON.parse(readFileSync(join(fixtures, "usage-accounting", "ledger.json"), "utf8")),
	);
	if (!parsed.ok) throw new Error(parsed.code);
	return parsed.value;
}
function add(
	input: AccountingInput,
	attempt: string,
	amount: string,
	kind: UsageFact["kind"] = "assistant",
): UsageFact {
	const f = structuredClone(input.facts[0]);
	f.identity.attempt = attempt;
	f.id = factId(f.identity);
	f.kind = kind;
	f.source.event = `event:${attempt}`;
	f.prices[0].amount = amount;
	input.facts.push(f);
	input.allocations.push({ ...input.allocations[0], factId: f.id });
	return f;
}
/** Folds facts the way the pass folds every source, commits through B2, then compares against W0's report. */
async function w0Step(s: PassState, input: AccountingInput, facts: UsageFact[]) {
	const aliasOf = new Map(input.aliases.map((a) => [a.aliasFactId, a]));
	facts.forEach((fact, i) =>
		foldCandidate(s, s.cur!, {
			fact,
			key: ["fact", fact.id],
			alias: aliasOf.get(fact.id) ?? null,
			src: passFileKey("/synthetic-only/w0"),
			off: s.cur!.recs.size + i,
			len: null,
			group: "sessions",
			file: null,
			evidenceRef: "fixture-only:w0",
			sameCall: null,
		}),
	);
	await runPass(s);
	closePassState(s);
	const fresh = open();
	try {
		await runPass(fresh);
		const rows = rowsOf(fresh);
		const viaB = accountUsage({ ...input, facts: rows.facts, aliases: rows.aliases }, OPTIONS);
		const viaW0 = accountUsage(input, OPTIONS);
		return { viaB, viaW0, w5: meter(fresh, AS_OF), records: fresh.cur!.recs.size };
	} finally {
		closePassState(fresh);
	}
}

// R-MEM: retained heap after a full collection (the fixture's own gc handle; production never collects by hand).
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;
const heap = () => (collect(), process.memoryUsage().heapUsed);
const peak = () => getHeapStatistics().total_heap_size;
const ms = (t0: number) => Math.round((performance.now() - t0) * 100) / 100;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
/**
 * E1/E2 (Ops #420's attempt counts): seeds the week through the pass's own fold and B2 commits, then measures a
 * new state's catch-up, steady passes with small appends, the W5 build over 14 role subjects (R-W5) and heap (R-MEM).
 * Real wall-clock time; the fixture clock only fixes the week.
 */
async function scale(attempts: number, files: number) {
	const roles = Array.from({ length: 14 }, (_, i) => `role-${String(i).padStart(2, "0")}`);
	const extra: Partial<PassOptions> = {
		subjects: roles.map((role) => ({ subject: { kind: "role" as const, role }, policy: null })),
		roleOf: (_file, f) => ({
			role: roles[Number.parseInt(f.identity.attempt.slice(1), 10) % roles.length] ?? roles[0]!,
			evidenceRef: "fixture-only:verified-role",
		}),
	};
	const seedMs = await seedWeek(attempts, files, extra);
	// A new state: replays the hash-checked week in budgeted passes (catching-up), then steady. The seeding state is
	// out of scope by now, as one worker holds one state.
	const heapBefore = heap();
	const replay0 = performance.now();
	const fresh = open(extra);
	const catchUp = await until(fresh, PASS_LIMITS, 400);
	const replayMs = ms(replay0);
	const heapAfterReplay = heap();
	return measureWeek(fresh, { attempts, files, seedMs, catchUp, replayMs, heapBefore, heapAfterReplay });
}
async function seedWeek(attempts: number, files: number, extra: Partial<PassOptions>): Promise<number> {
	const template = ledgerInput().facts[0]!;
	const span = Date.parse(AS_OF) - 120_000 - Date.parse(WEEK_START);
	const s = open(extra);
	await runPass(s);
	const seed0 = performance.now();
	let off = 0;
	for (let i = 0; i < attempts; i++) {
		const f = structuredClone(template);
		const at = Date.parse(WEEK_START) + Math.floor((span * i) / attempts);
		f.identity.attempt = `a${i}`;
		f.id = factId(f.identity);
		f.occurredAt = new Date(at).toISOString();
		f.source = {
			...f.source,
			stream: `fixture-file-${i % files}`,
			event: `event-${i}`,
			observedAt: new Date(at + 1000).toISOString(),
		};
		f.prices[0]!.amount = "0.001234";
		foldCandidate(s, s.cur!, {
			fact: f,
			key: ["fact", f.id],
			alias: null,
			src: passFileKey(`/synthetic-only/f${i % files}`),
			off: off++,
			len: null,
			group: "sessions",
			file: null,
			evidenceRef: "fixture-only:scale",
			sameCall: null,
		});
		if ((i + 1) % 4096 === 0) await runPass(s);
	}
	await runPass(s);
	const seedMs = ms(seed0);
	closePassState(s);
	return seedMs;
}
async function measureWeek(
	fresh: PassState,
	m: {
		attempts: number;
		files: number;
		seedMs: number;
		catchUp: ReturnType<typeof brief>[];
		replayMs: number;
		heapBefore: number;
		heapAfterReplay: number;
	},
) {
	const { attempts, files, seedMs, catchUp, replayMs, heapBefore, heapAfterReplay } = m;
	// Four live synthetic chats; each steady pass appends one call to two of them.
	mkdirSync(join(sessions, "cwd"), { recursive: true, mode: 0o700 });
	const live = [0, 1, 2, 3].map((n) => join(sessions, "cwd", `live-${n}.jsonl`));
	for (const [n, file] of live.entries()) {
		writeFileSync(
			file,
			header(`session-live-${n}`, "2026-10-20T11:00:00.000Z") + entry(`live-init-${n}`, "2026-10-20T11:00:01.000Z"),
		);
		stamp(file, "2026-10-20T11:00:02.000Z");
	}
	await until(fresh);
	const idle: ReturnType<typeof brief>[] = [];
	const steady: ReturnType<typeof brief>[] = [];
	for (let k = 1; k <= 7; k++) {
		idle.push(brief(await runPass(fresh)));
		for (const file of [live[k % 4]!, live[(k + 1) % 4]!]) {
			// Unique entry and response ids: a responseId reused by another entry is a conflict, rightly unknown.
			appendFileSync(file, entry(`live-${k}-file-${file.slice(-7, -6)}`, `2026-10-20T11:0${k}:00.000Z`));
			stamp(file, `2026-10-20T11:0${k}:01.000Z`);
		}
		steady.push(brief(await runPass(fresh)));
	}
	// R-W5: the pass's input build and W5's snapshot over the whole week, 14 subjects; three runs.
	const inputMs: number[] = [],
		w5Ms: number[] = [];
	let snapshot: ReturnType<typeof buildUsageMeterSnapshot> | null = null;
	// Heap in use (garbage included) as W5 takes each partition: an upper bound of the build's live peak.
	let buildPeak = 0;
	function* sampled(g: Iterable<SnapshotPartition>) {
		for (const p of g) {
			buildPeak = Math.max(buildPeak, process.memoryUsage().heapUsed);
			yield p;
		}
	}
	for (let k = 0; k < 3; k++) {
		const t0 = performance.now();
		const input = buildPassInput(fresh, AS_OF, true);
		inputMs.push(ms(t0));
		const t1 = performance.now();
		snapshot = buildUsageMeterSnapshot({ ...input, partitions: sampled(input.partitions) });
		w5Ms.push(ms(t1));
	}
	const heapCommitted = peak();
	const heapAfterW5 = heap();
	// Partition sizes as W5 measures them (METER_LIMITS.lookupRows 4,096 and lookupBytes 4 MiB), one at a time.
	const sizes: { rows: number; bytes: number }[] = [];
	for (const p of buildPassInput(fresh, AS_OF, true).partitions)
		sizes.push({
			rows: Object.values(p.rows).reduce((n, x) => n + (x as unknown[]).length, 0),
			bytes: Buffer.byteLength(JSON.stringify({ rows: p.rows, factRoles: p.factRoles })),
		});
	const unknown = { ...fresh.cur!.unknown };
	const records = fresh.cur!.recs.size;
	closePassState(fresh);
	const pick = (xs: ReturnType<typeof brief>[]) => ({
		workMs: median(xs.map((x) => x.workMs)),
		ioMs: median(xs.map((x) => x.ioMs)),
		bytesRead: median(xs.map((x) => x.bytesRead)),
		maxWorkMs: Math.max(...xs.map((x) => x.workMs)),
		statuses: [...new Set(xs.map((x) => x.status))],
		faults: [...new Set(xs.flatMap((x) => Object.keys(x.faults)))],
	});
	return {
		attempts,
		files,
		records,
		seedMs,
		replay: {
			ms: replayMs,
			passes: catchUp.length,
			maxWorkMs: Math.max(...catchUp.map((p) => p.workMs)),
			status: last(catchUp).status,
		},
		idle: pick(idle),
		steady: pick(steady),
		w5: {
			inputMs: median(inputMs),
			snapshotMs: median(w5Ms),
			runs: inputMs.map((x, i) => x + w5Ms[i]!),
			state: snapshot?.state ?? null,
			subjects: snapshot?.subjects.length ?? 0,
			gross: snapshot?.subjects.map((x) => x.list?.grossObservations ?? null).slice(0, 2) ?? [],
			faults: [...(snapshot?.faults ?? []), ...(snapshot?.subjects[0]?.faults ?? [])].slice(0, 8),
		},
		heap: {
			before: heapBefore,
			afterReplay: heapAfterReplay,
			afterW5: heapAfterW5,
			buildPeak,
			committedAfterW5: heapCommitted,
		},
		unknown,
		partitions: {
			count: sizes.length,
			maxRows: Math.max(...sizes.map((x) => x.rows)),
			maxBytes: Math.max(...sizes.map((x) => x.bytes)),
		},
	};
}
const last = <T>(xs: T[]): T => xs[xs.length - 1]!;

const cases: Record<string, () => Promise<unknown>> = {
	async e0() {
		return scale(8_192, 64);
	},
	async e1() {
		return scale(125_231, 1_050);
	},
	async e2() {
		return scale(250_462, 2_408);
	},
	async w0() {
		mkdirSync(sessions, { recursive: true, mode: 0o700 });
		const out: unknown[] = [];
		// Case 1: main + warm + delegate + a duplicate main, then retry + compaction.
		{
			const input = ledgerInput();
			add(input, "warm", "0.02", "cache-warm");
			add(input, "delegate", "0.03", "delegate");
			input.facts.push(structuredClone(input.facts[0]));
			let s = open();
			await runPass(s);
			out.push(await w0Step(s, input, input.facts));
			const retry = add(input, "retry", "0.10");
			const compact = add(input, "compact", "0.000000000001", "compaction");
			s = open();
			await runPass(s);
			out.push(await w0Step(s, input, [retry, compact]));
		}
		// Case 2: a Temper alias of main-1, then a correction (revision 1) of both with provider/invoice bases.
		{
			const data2 = join(dir, "data2");
			const input = ledgerInput();
			add(input, "warm", "0.02", "cache-warm");
			add(input, "delegate", "0.03", "delegate");
			add(input, "retry", "0.10");
			add(input, "compact", "0.000000000001", "compaction");
			const alias = structuredClone(input.facts[0]);
			alias.identity.producer = "temper";
			alias.id = factId(alias.identity);
			alias.source.stream = "fixture-temper";
			input.facts.push(alias);
			input.allocations.push({ ...input.allocations[0], factId: alias.id });
			input.aliases.push({
				aliasFactId: alias.id,
				canonicalFactId: input.facts[0].id,
				provenance: "native-call-map/1",
				evidenceRef: "fixture-only:pi-temper-call",
			});
			input.coverage.push({ ...input.coverage[0], stream: "fixture-temper" });
			input.requiredStreams.push("fixture-temper");
			const reopen = (extra: Partial<PassOptions> = {}) => open({ dataDir: data2, ...extra });
			const step = async (facts: UsageFact[]) => {
				const s = reopen();
				await runPass(s);
				const aliasOf = new Map(input.aliases.map((a) => [a.aliasFactId, a]));
				for (const fact of facts)
					foldCandidate(s, s.cur!, {
						fact,
						key: ["fact", fact.id],
						alias: aliasOf.get(fact.id) ?? null,
						src: passFileKey("/synthetic-only/w0-alias"),
						off: s.cur!.recs.size,
						len: null,
						group: "sessions",
						file: null,
						evidenceRef: "fixture-only:w0",
						sameCall: null,
					});
				await runPass(s);
				closePassState(s);
				const fresh = reopen();
				try {
					await runPass(fresh);
					const rows = rowsOf(fresh);
					return {
						viaB: accountUsage({ ...input, facts: rows.facts, aliases: rows.aliases }, OPTIONS),
						viaW0: accountUsage(input, OPTIONS),
						w5: meter(fresh, AS_OF),
						records: fresh.cur!.recs.size,
					};
				} finally {
					closePassState(fresh);
				}
			};
			out.push(await step(input.facts));
			const revised = structuredClone(input.facts[0]);
			revised.revision = 1;
			revised.supersedes = 0;
			revised.source.observedAt = "2026-10-20T11:00:00.000Z";
			revised.prices[0].amount = "0.12";
			revised.prices.push(
				{ basis: "provider-reported", currency: "USD", amount: "0.05", status: "known", rateVersion: null },
				{ basis: "invoice", currency: "USD", amount: "0.07", status: "known", rateVersion: null },
			);
			const revisedAlias = structuredClone(alias);
			revisedAlias.revision = 1;
			revisedAlias.supersedes = 0;
			revisedAlias.source.observedAt = revised.source.observedAt;
			revisedAlias.prices[0].amount = "0.12";
			input.facts.push(revised, revisedAlias);
			out.push(await step([revised, revisedAlias]));
		}
		return out;
	},

	async sessions() {
		copySessions();
		// A native Temper pi-worker root inside the sessions root is excluded (T0 owns it).
		const temper = join(sessions, "temper-worker");
		mkdirSync(temper, { mode: 0o700 });
		copyFileSync(join(fixtures, "usage-accounting-pi-sessions", "usage-kinds.jsonl"), join(temper, "excluded.jsonl"));
		stamp(join(temper, "excluded.jsonl"), "2026-10-20T11:00:00.000Z");
		const s = open({ temperRoots: [temper] });
		const passes = await until(s);
		const steady = brief(await runPass(s));
		// Append one call to plain: only that file is opened, and only its new bytes plus the integrity anchor.
		const plain = join(sessions, "cwd", "plain.jsonl");
		const before = readFileSync(plain).length;
		const line = entry("appended-1", "2026-10-20T11:30:00.000Z", 0.5);
		appendFileSync(plain, line);
		stamp(plain, "2026-10-20T11:31:00.000Z");
		const appended = brief(await runPass(s));
		const w5 = meter(s, AS_OF);
		const debug = {
			// The W5 projection (one stream per group) must not collide events of a resumed copy (same header id).
			grouped: (() => {
				const b = buildPassInput(s, AS_OF, true);
				const facts: UsageFact[] = [],
					aliases: IdentityAlias[] = [];
				for (const p of b.partitions) (facts.push(...p.rows.facts), aliases.push(...p.rows.aliases));
				const r = observeUsage(
					{
						v: 1,
						facts,
						aliases,
						allocations: [],
						roots: [],
						policies: [],
						memberships: [],
						snapshots: [],
						coverage: b.coverage,
						requiredStreams: b.evidence.requiredStreams,
					},
					{ asOf: AS_OF, staleAfterMs: 3_600_000, window: { from: WEEK_START, through: AS_OF } },
				);
				return { gross: r.grossKnownListUsd, dedup: r.dedupKnownListUsd, faults: r.faults };
			})(),
		};
		closePassState(s);
		const after = await replayed(AS_OF, { temperRoots: [temper] });
		return {
			passes,
			steady,
			appended,
			appendedBytes: line.length,
			fileBytes: before,
			w5,
			after,
			direct: await direct(),
			debug,
			files: [...s.files.values()].map((f) => f.file.slice(sessions.length + 1)).sort(),
		};
	},

	async history() {
		// H-B3: a steady pass reads nothing; an append costs its new bytes plus #304's bounded integrity rechecks,
		// never the file's history.
		mkdirSync(join(sessions, "cwd"), { recursive: true, mode: 0o700 });
		const file = join(sessions, "cwd", "long.jsonl");
		let text = header("session-long", "2026-10-19T08:00:00.000Z");
		for (let i = 0; i < 3000; i++)
			text += entry(`call-${i}`, new Date(Date.parse("2026-10-19T08:00:00.000Z") + i * 1000).toISOString(), 0.001);
		writeFileSync(file, text);
		stamp(file, "2026-10-20T10:00:00.000Z");
		const s = open();
		const first = await until(s);
		const steady = brief(await runPass(s));
		const line = entry("call-new", "2026-10-20T11:00:00.000Z", 0.5);
		appendFileSync(file, line);
		stamp(file, "2026-10-20T11:01:00.000Z");
		const appended = brief(await runPass(s));
		const after = brief(await runPass(s));
		const totals = observed(s, AS_OF);
		closePassState(s);
		return { fileBytes: Buffer.byteLength(text), lineBytes: line.length, first, steady, appended, after, totals };
	},

	async tamper() {
		// W5's rows stream from the committed observations: a byte changed in place (same file, same size) is caught by
		// the store's end-of-replay SHA256, so W5 gets an error, never a snapshot, and the pass rebuilds, failing closed.
		copySessions(["plain"]);
		const s = open();
		const first = (await until(s)).map((p) => p.status);
		const clean = [...buildPassInput(s, AS_OF, true).partitions].length;
		const file = join(dir, "data", "usage-week", `week-${s.cur!.week}.observations`);
		const text = readFileSync(file, "latin1");
		const at = text.indexOf('"output":2');
		writeFileSync(file, text.slice(0, at) + '"output":3' + text.slice(at + 10), "latin1");
		const snapshot = buildUsageMeterSnapshot(buildPassInput(s, AS_OF, true));
		const w5 = { state: snapshot.state, faults: snapshot.faults.map((f) => f.code) };
		const error = s.lastError;
		const broken = s.broken;
		const next = (await runPass(s)).status;
		// An input from an earlier pass is refused once a later pass has run.
		const stale = (() => {
			const input = buildPassInput(s, AS_OF, true);
			s.sequence++;
			try {
				for (const _ of input.partitions);
				return "read";
			} catch (e) {
				return (e as Error).message;
			}
		})();
		closePassState(s);
		return { first: last(first), clean, at: at > 0, w5, error, broken, next, stale };
	},

	async cursors() {
		copySessions(["plain"]);
		const plain = join(sessions, "cwd", "plain.jsonl");
		const original = readFileSync(plain);
		const s = open();
		const first = await until(s);
		const base = observed(s, AS_OF);
		// Shrunk below the cursor: re-read from byte 0, keys dedupe, nothing is charged twice.
		const lines = original.toString("utf8").split("\n");
		truncateSync(plain, Buffer.byteLength(lines.slice(0, 2).join("\n") + "\n"));
		stamp(plain, "2026-10-20T11:10:00.000Z");
		const truncated = brief(await runPass(s));
		const afterTruncate = observed(s, AS_OF);
		// Restored: the old prefix still anchors, the rest re-reads as duplicates.
		writeFileSync(plain, original);
		stamp(plain, "2026-10-20T11:20:00.000Z");
		const restored = brief(await runPass(s));
		const afterRestore = observed(s, AS_OF);
		// Rewritten in place with another header (same size): cursor-changed -> re-read from 0, same calls stay once.
		const text = original.toString("utf8").replace('"id":"session-plain"', '"id":"session-plaiN"');
		writeFileSync(plain, text);
		stamp(plain, "2026-10-20T11:40:00.000Z");
		const rewritten = brief(await runPass(s));
		const afterRewrite = observed(s, AS_OF);
		const clean = brief(await runPass(s));
		closePassState(s);
		return { first, base, truncated, afterTruncate, restored, afterRestore, rewritten, afterRewrite, clean };
	},

	async cap() {
		copySessions(["plain", "delegate", "fork"]);
		const s = open({ scan: { files: 2 } });
		const passes = await until(s);
		const tracked = [...s.files.values()].filter((f) => f.file).length;
		closePassState(s);
		return { passes, tracked };
	},

	async budget() {
		copySessions();
		const s = open();
		const tiny = await until(s, { bytes: PASS_LIMITS.bytes, workMs: 0 }, 1);
		const split = await until(s, { bytes: PASS_LIMITS.readWorstBytes + 1, workMs: 2000 }, 40);
		const totals = observed(s, AS_OF);
		closePassState(s);
		return { tiny, split, totals, direct: await direct() };
	},

	async rollover() {
		// Week 2026-10-19 ends Monday 2026-10-26 00:00 PDT = 07:00Z.
		mkdirSync(join(sessions, "cwd"), { recursive: true, mode: 0o700 });
		const file = join(sessions, "cwd", "roll.jsonl");
		writeFileSync(file, header("session-roll", "2026-10-26T06:00:00.000Z") + entry("e1", "2026-10-26T06:50:00.000Z"));
		stamp(file, "2026-10-26T06:55:00.000Z");
		clock.t = Date.parse("2026-10-26T06:58:00.000Z");
		const s = open();
		const sunday = brief(await runPass(s));
		appendFileSync(file, entry("e2", "2026-10-26T06:59:00.000Z") + entry("e3", "2026-10-26T07:02:00.000Z"));
		stamp(file, "2026-10-26T07:03:00.000Z");
		clock.t = Date.parse("2026-10-26T07:05:00.000Z");
		const monday = brief(await runPass(s));
		const mondayWeek = s.cur!.week;
		// Whether the store still holds last week (receipt() refuses a week it has not loaded, changing nothing).
		const holds = (week: string) => {
			try {
				s.store.receipt(week, "same-call", "0".repeat(64));
				return "loaded";
			} catch (e) {
				return (e as { code?: string }).code ?? "error";
			}
		};
		const duringGrace = { store: holds("2026-10-19"), released: s.prev!.released, fold: s.prev!.recs.size };
		appendFileSync(file, entry("e4", "2026-10-26T06:59:30.000Z"));
		stamp(file, "2026-10-26T07:08:00.000Z");
		clock.t = Date.parse("2026-10-26T07:11:00.000Z");
		const late = brief(await runPass(s));
		const afterGrace = { store: holds("2026-10-19"), released: s.prev!.released, fold: s.prev!.recs.size };
		const current = observed(s, "2026-10-26T07:11:00.000Z");
		closePassState(s);
		// A restart after the grace keeps last week's checkpoint, not its fold; its committed records stay on disk.
		const fresh = open();
		await runPass(fresh);
		const prevWeek = fresh.prev!.week;
		const restart = {
			released: fresh.prev!.released,
			fold: fresh.prev!.recs.size,
			checkpoint: fresh.prev!.checkpoint !== null,
		};
		const load = fresh.store.reload(prevWeek);
		const records = { prev: load.state === "open" ? load.records : -1, cur: fresh.cur!.recs.size, prevWeek };
		closePassState(fresh);
		return { sunday, monday, mondayWeek, late, current, records, duringGrace, afterGrace, restart };
	},

	async overlap() {
		copySessions(["plain"]);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let slowCalls = 0;
		const s = open({
			slow: async () => {
				slowCalls++;
				if (slowCalls === 1) await gate;
			},
		});
		const first = runPass(s);
		const during = await runPass(s);
		const sequenceDuring = s.sequence;
		release();
		const done = await first;
		const next = await runPass(s);
		closePassState(s);
		return { during: during.status, sequenceDuring, first: done.status, second: next.status, sequence: s.sequence };
	},

	async ledger() {
		copySessions(["plain"]);
		const ledgerDir = join(dir, "usage-ledger");
		mkdirSync(ledgerDir, { mode: 0o700 });
		const record = (changes: Record<string, unknown>) =>
			JSON.stringify({
				v: "usage-ledger/1",
				at: "2026-10-20T09:00:00.000Z",
				occurredAt: "2026-10-20T09:00:00.000Z",
				kind: "assistant",
				provider: "anthropic",
				model: "recorded-model",
				modelSource: "response",
				responseId: "helper-response-1",
				stopReason: "stop",
				input: 10,
				output: 2,
				cacheRead: 3,
				cacheWrite: 4,
				totalTokens: 19,
				costTotal: 0.125,
				conversationId: "helper-1",
				sessionId: "session-1",
				sessionFile: null,
				persist: false,
				origin: "helper",
				parentConversationId: "parent-1",
				...changes,
			}) + "\n";
		const file = join(ledgerDir, "2026-10.jsonl");
		writeFileSync(file, record({}) + record({ responseId: "helper-response-2", costTotal: 0.25 }), { mode: 0o600 });
		const s = open({ ledgerDirectory: ledgerDir, production: "enabled" });
		const passes = await until(s);
		const first = observed(s, AS_OF);
		const ledgerFaults = s.ledger.faults.map((f) => f.code);
		const steady = brief(await runPass(s));
		// The same helper call again: answered by first() from the hash-checked store, never charged twice.
		appendFileSync(file, record({}));
		const repeat = brief(await runPass(s));
		const afterRepeat = observed(s, AS_OF);
		closePassState(s);
		const fresh = open({ ledgerDirectory: ledgerDir, production: "enabled" });
		const reopened = brief(await runPass(fresh));
		const afterReopen = observed(fresh, AS_OF);
		const receipts = fresh.store.listWeeks();
		closePassState(fresh);
		return { passes, first, ledgerFaults, steady, repeat, afterRepeat, reopened, afterReopen, receipts };
	},
};

cases[name]()
	.then((result) => parentPort!.postMessage({ ok: true, result }))
	.catch((error: unknown) =>
		parentPort!.postMessage({
			ok: false,
			error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error),
		}),
	);
