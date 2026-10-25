/**
 * Design B's main-thread host (Ops #322, B4): runs the pass Worker every 30 s, hands its W5 snapshots to the meter
 * cache the Roles page reads, keeps the native admission receipt per published generation, and raises the 300 s
 * dead man's switch. Reporting only: it changes no budget, cap or pause and deletes nothing.
 *
 * Main-thread rules (import guard in tests/unit/usage-accounting-pi-sessions.test.ts): only node built-ins, the pass
 * host, the meter cache and the meter contract. It reaches the Worker by URL, never by import, so no engine (pass,
 * scan, store, sources, W5) is loaded on the main thread.
 *
 * Cadence: the pass runs on every tick; W5 is built only when it is wanted (a Roles window is open), for the first
 * pass, and while the meter shows a health fault or the alarm, because a W5 build at a late-week load takes 15-87 s
 * (Ops #423 H-B3, Architecture #277 S6) and would otherwise keep a core busy all day.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createUsageMeterCache } from "./usage-accounting-meter-cache.js";
import { METER_LIMITS } from "./usage-accounting-meter-contract.js";
import { startUsagePassWorker, type UsagePassHost } from "./usage-accounting-pass-host.js";

/** What the Roles view reads (server/roles-overview.ts usageMeterCache / usageMeterFirstObservedAt). */
export interface UsageAccountingView {
	cache(): Pick<ReturnType<typeof createUsageMeterCache>, "get"> | null;
	firstObservedAt(generation: { epoch: string; sequence: number }): number | null;
}
export interface UsageAccounting extends UsageAccountingView {
	readonly epoch: string;
	/** One timer step (the timer calls it every intervalMs; tests call it directly). */
	step(): Promise<void>;
	stop(): Promise<void>;
}
export interface UsageRoleWitness {
	roles: string[];
	/** [chat session id, role] pairs. */
	sessions: [string, string][];
}
export interface UsageAccountingOptions {
	dataDir: string;
	/** Each must be an existing directory spelled as its own real path (Architecture #289 note 1); at least one. */
	sessionRoots: string[];
	temperRoots: string[];
	ledgerDirectory: string | null;
	production: "enabled" | "disabled" | "unknown";
	/** The roles to report on and each chat session's role, taken from the chat's identity. Never from payerRole. */
	witness(): Promise<UsageRoleWitness>;
	/** True while a Roles window is open: W5 is built on every pass then. */
	wanted(): boolean;
	/** Called after a snapshot is accepted (the Roles watch pushes it then). */
	onPublish?(): void;
	log?(line: string): void;
	now?(): number;
	intervalMs?: number;
	alarmAfterMs?: number;
	summaryMs?: number;
	/** Tests: the Worker entry (bundled code with eval) or a stand-in host. */
	entry?: string | URL;
	eval?: boolean;
	start?: typeof startUsagePassWorker;
}

/** The ledger writer's switch as the pass sees it: missing file = enabled (server/usage-accounting-ledger.ts). */
export function usageLedgerProduction(dataDir: string): "enabled" | "disabled" | "unknown" {
	try {
		const config = JSON.parse(readFileSync(`${dataDir}/usage-ledger.json`, "utf8")) as { enabled?: unknown } | null;
		return config && typeof config.enabled === "boolean" ? (config.enabled ? "enabled" : "disabled") : "unknown";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "enabled" : "unknown";
	}
}

/** Refuses roots the Worker would refuse at open, before a Worker starts (Architecture #289 notes 1 and 6). */
export function checkSessionRoots(roots: string[]): string | null {
	if (roots.length === 0) return "no session root";
	for (const root of roots) {
		if (!isAbsolute(root)) return `session root is not absolute: ${root}`;
		try {
			if (!statSync(root).isDirectory()) return `session root is not a directory: ${root}`;
			if (realpathSync(root) !== root) return `session root is not spelled as its real path: ${root}`;
		} catch {
			return `session root is missing: ${root}`;
		}
	}
	return null;
}

const workerEntry = (): URL =>
	new URL(
		import.meta.url.endsWith(".ts") ? "./usage-accounting-pass-worker.ts" : "./usage-accounting-pass-worker.js",
		import.meta.url,
	);

interface PassMessage {
	kind: "pass";
	status: string;
	sequence: number;
	asOf: string | null;
	snapshot: unknown;
	w5Ms: number;
	workMs: number;
	bytesRead: number;
	ledgerBytes: number;
	backlogFiles: number;
	code: string | null;
}
type Health = { state: "unavailable" | "waiting-for-previous-writer"; code: string };
const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

/** Starts the Worker and the timer. Throws (nothing started) when a session root is refused. */
export function startUsageAccounting(opts: UsageAccountingOptions): UsageAccounting {
	const refused = checkSessionRoots(opts.sessionRoots);
	if (refused) throw new Error(refused);
	const now = opts.now ?? Date.now;
	const log = opts.log ?? ((line: string) => console.log(line));
	const alarmAfterMs = opts.alarmAfterMs ?? METER_LIMITS.alarmAfterMs;
	const epoch = randomBytes(32).toString("hex");
	const cache = createUsageMeterCache();
	cache.activateEpoch(epoch);
	/** Native admission receipts: generation sequence -> the pass time that first saw its new bytes. */
	const receipts = new Map<number, number>();
	let pending: number | null = null;
	let lastPassAt = now();
	let alarmed = false;
	let health: Health | null = null;
	let published = false;
	let lost = false;
	let stopped = false;
	let witnessed: string | null = null;
	let witnessFailing = false;
	const counts = {
		passes: new Map<string, number>(),
		dropped: 0,
		skipped: 0,
		work: [] as number[],
		w5: [] as number[],
		backlog: 0,
	};

	const raise = (next: Health) => {
		if (health?.state === next.state && health.code === next.code) return;
		const ok = cache.accept(
			JSON.stringify({ v: "usage-meter-health/1", epoch, at: new Date(now()).toISOString(), ...next }),
		);
		if (ok) health = next;
		log(`[usage-accounting] meter ${next.state} (${next.code})${ok ? "" : "; the cache refused the health note"}`);
	};
	const checkAlarm = () => {
		if (alarmed || stopped || now() - lastPassAt < alarmAfterMs) return;
		alarmed = true;
		log(`[usage-accounting] ALARM: no pass has finished for ${Math.round((now() - lastPassAt) / 1000)} s`);
		raise({ state: "unavailable", code: "worker-unavailable" });
	};
	const onMessage = (raw: unknown) => {
		const m = raw as { kind?: string; code?: unknown };
		if (m?.kind === "dropped") counts.dropped++;
		else if (m?.kind === "worker-unavailable") {
			lost = true;
			// No hot restart (Architecture #289 note 3): a wrong root or a crash stays visible until the next service start.
			log(
				`[usage-accounting] pass worker lost${typeof m.code === "string" ? ` (${m.code})` : ""}; ` +
					"no restart until pi-web-ui starts again",
			);
			raise({ state: "unavailable", code: "worker-unavailable" });
		} else if (m?.kind === "pass") onPass(raw as PassMessage);
	};
	const onPass = (m: PassMessage) => {
		lastPassAt = now();
		counts.passes.set(m.status, (counts.passes.get(m.status) ?? 0) + 1);
		counts.work.push(m.workMs);
		counts.backlog = m.backlogFiles;
		if (m.asOf && m.bytesRead + m.ledgerBytes > 0 && pending === null) pending = Date.parse(m.asOf);
		if (m.snapshot) {
			counts.w5.push(m.w5Ms);
			const sequence = (m.snapshot as { generation?: { sequence?: unknown } }).generation?.sequence;
			if (!cache.accept(JSON.stringify(m.snapshot)) || typeof sequence !== "number") {
				log(`[usage-accounting] snapshot ${m.sequence} refused by the meter cache`);
				return;
			}
			if (pending !== null) receipts.set(sequence, pending);
			pending = null;
			for (const k of receipts.keys()) if (receipts.size > 8) receipts.delete(k);
			health = null;
			if (alarmed) log("[usage-accounting] alarm cleared: a pass finished and published");
			alarmed = false;
			if (!published) log(`[usage-accounting] first snapshot published (W5 ${Math.round(m.w5Ms)} ms)`);
			published = true;
			opts.onPublish?.();
		} else if (m.status === "unavailable")
			raise(
				m.code === "waiting-for-previous-writer"
					? { state: "waiting-for-previous-writer", code: "waiting-for-previous-writer" }
					: { state: "unavailable", code: m.code === "store-capacity" ? "store-capacity" : "index-unavailable" },
			);
	};

	const start = opts.start ?? startUsagePassWorker;
	const host: UsagePassHost = start(
		opts.entry ?? workerEntry(),
		{
			dataDir: opts.dataDir,
			lease: new SharedArrayBuffer(4),
			epoch,
			sessionRoots: opts.sessionRoots,
			temperRoots: opts.temperRoots,
			ledgerDirectory: opts.ledgerDirectory,
			production: opts.production,
		},
		onMessage,
		{ eval: opts.eval ?? false },
	);

	const step = async () => {
		checkAlarm();
		if (stopped || lost) return;
		let witness: UsageRoleWitness | null = null;
		try {
			witness = await opts.witness();
			if (witnessFailing) log("[usage-accounting] role witness readable again");
			witnessFailing = false;
		} catch (error) {
			if (!witnessFailing) log(`[usage-accounting] role witness unreadable: ${(error as Error)?.name ?? "error"}`);
			witnessFailing = true;
		}
		if (stopped) return;
		// The first pass reads the whole week: never without a witness, or its facts would stay without a role.
		if (!witness && witnessed === null) {
			counts.skipped++;
			return;
		}
		const key = witness ? JSON.stringify(witness) : witnessed;
		const build = !published || alarmed || health !== null || opts.wanted();
		const payload: Record<string, unknown> = { build };
		if (witness && key !== witnessed) payload.witness = witness;
		if (host.tick(payload)) witnessed = key;
		else counts.skipped++;
	};
	const timer = setInterval(() => void step(), opts.intervalMs ?? METER_LIMITS.updateMs);
	timer.unref?.();
	// A summary every 10 min for the live W5/load reading; no line per pass.
	const summary = setInterval(() => {
		const passes = [...counts.passes].map(([k, v]) => `${k} ${v}`).join(", ") || "none";
		log(
			`[usage-accounting] 10 min: passes ${passes}; dropped ${counts.dropped}, skipped ${counts.skipped}; ` +
				`pass work median ${Math.round(median(counts.work))} ms, max ${Math.round(Math.max(0, ...counts.work))} ms; ` +
				`W5 builds ${counts.w5.length}, median ${Math.round(median(counts.w5))} ms, max ${Math.round(Math.max(0, ...counts.w5))} ms; ` +
				`files left to read ${counts.backlog}`,
		);
		counts.passes.clear();
		counts.dropped = counts.skipped = 0;
		counts.work = [];
		counts.w5 = [];
	}, opts.summaryMs ?? 600_000);
	summary.unref?.();
	void step();

	return {
		epoch,
		cache: () => cache,
		firstObservedAt: (g) => (g?.epoch === epoch ? (receipts.get(g.sequence) ?? null) : null),
		step,
		async stop() {
			if (stopped) return;
			stopped = true;
			clearInterval(timer);
			clearInterval(summary);
			await host.close();
		},
	};
}
