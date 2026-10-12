// App-owned sequential history chunks. All model judgment remains in DecisionReader.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { localDay, type DecisionRecord } from "./decision-records.js";
import type { DecisionStore } from "./decision-store.js";
import type { ReaderIdentity } from "./decision-call-lifecycle.js";
import {
	allocated,
	BATCH_TOKEN_LIMIT,
	newTokenBudget,
	quotaBlock,
	reservationBlock,
	reserveTokens,
	safeCount,
	settleTokens,
	validBudget,
	type TokenBudget,
} from "./decision-batch-budget.js";
export const BATCH_PROVIDER = "anthropic-4";
export const BATCH_MODEL = "claude-haiku-5-5";
export const BATCH_RECORD_LIMIT = 20;
export const BATCH_GUARD_UNIT = "decisions-batch-guard.service";
export interface BatchConfig {
	v: 1;
	approval: string;
	provider: typeof BATCH_PROVIDER;
	model: typeof BATCH_MODEL;
	thinking: "medium";
	maxRecords: 20;
	tokenLimit: 500000;
	dailyTokenCap: 6000000;
	historicTokensByDay: Record<string, number>;
	historicUnknownByDay: Record<string, number>;
}
interface Chunk {
	n: number;
	at: number;
	ids: string[];
	alreadyRead: string[];
	budget: TokenBudget;
}
interface ChunkSummary {
	n: number;
	at: number;
	ended: number;
	reason: string;
	selected: number;
	newRead: number;
	actual: number;
	unknown: number;
	calls: number;
}
interface BatchLedger {
	v: 1;
	approval: string;
	historicTokensByDay: Record<string, number>;
	historicUnknownByDay: Record<string, number>;
	newTokensByDay: Record<string, number>;
	chunks: ChunkSummary[];
	current?: Chunk;
	stopReason?: string;
	halted?: boolean;
	configProof: string;
}
function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}
function validDays(value: unknown): value is Record<string, number> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.entries(value).every(([day, n]) => /^\d{4}-\d{2}-\d{2}$/.test(day) && safeCount(n))
	);
}
export function parseBatchConfig(value: unknown): BatchConfig | undefined {
	const c = value as BatchConfig | undefined;
	if (
		!c ||
		c.v !== 1 ||
		typeof c.approval !== "string" ||
		!c.approval.trim() ||
		c.provider !== BATCH_PROVIDER ||
		c.model !== BATCH_MODEL ||
		c.thinking !== "medium" ||
		c.maxRecords !== BATCH_RECORD_LIMIT ||
		c.tokenLimit !== BATCH_TOKEN_LIMIT ||
		c.dailyTokenCap !== 6_000_000 ||
		!validDays(c.historicTokensByDay) ||
		!validDays(c.historicUnknownByDay)
	)
		return undefined;
	return c;
}
export interface BatchControlOptions {
	now?: () => number;
	guardActive?: () => boolean;
	log?: (row: ChunkSummary | { stopped: string; at: number }) => void;
}
export class DecisionBatchControl {
	private activeIds: string[] = [];
	private invalidGroup: string | undefined;
	private configProof: string | undefined;
	private ledger: BatchLedger | undefined;
	readonly configFile: string;
	readonly ledgerFile: string;
	readonly guardFile: string;
	constructor(
		readonly store: DecisionStore,
		private readonly opts: BatchControlOptions = {},
	) {
		this.configFile = join(store.dir, "reader-batch-settings.json");
		this.ledgerFile = join(store.dir, "reader-batches.json");
		this.guardFile = join(store.dir, "reader-batch-guard.json");
	}
	private now(): number {
		return this.opts.now?.() ?? Date.now();
	}
	private save(): void {
		if (this.ledger) {
			mkdirSync(this.store.dir, { recursive: true });
			writeJson(this.ledgerFile, this.ledger);
		}
	}
	private config(): BatchConfig | undefined {
		try {
			const c = parseBatchConfig(readJson(this.configFile));
			if (!c) return undefined;
			const proof = JSON.stringify(c);
			if (this.configProof && this.configProof !== proof) return undefined;
			this.configProof = proof;
			if (!this.ledger) {
				if (existsSync(this.ledgerFile)) {
					const l = readJson(this.ledgerFile) as BatchLedger;
					if (
						l.v !== 1 ||
						l.configProof !== proof ||
						l.approval !== c.approval ||
						JSON.stringify(l.historicTokensByDay) !== JSON.stringify(c.historicTokensByDay) ||
						JSON.stringify(l.historicUnknownByDay) !== JSON.stringify(c.historicUnknownByDay) ||
						!Array.isArray(l.chunks) ||
						!validDays(l.newTokensByDay) ||
						(l.current &&
							(!validBudget(l.current.budget) ||
								!Array.isArray(l.current.ids) ||
								l.current.ids.length === 0 ||
								l.current.ids.length > BATCH_RECORD_LIMIT ||
								!l.current.ids.every((id) => typeof id === "string" && id.length > 0) ||
								new Set(l.current.ids).size !== l.current.ids.length ||
								!Array.isArray(l.current.alreadyRead) ||
								!l.current.alreadyRead.every((id) => l.current!.ids.includes(id)) ||
								l.current.n !== l.chunks.length + 1))
					)
						return undefined;
					if (
						!l.chunks.every(
							(chunk, i) =>
								chunk.n === i + 1 &&
								safeCount(chunk.actual) &&
								chunk.actual <= BATCH_TOKEN_LIMIT &&
								chunk.unknown === 0 &&
								safeCount(chunk.calls) &&
								safeCount(chunk.selected) &&
								chunk.selected <= BATCH_RECORD_LIMIT &&
								safeCount(chunk.newRead) &&
								chunk.newRead <= chunk.selected,
						)
					)
						return undefined;
					const counted = Object.values(l.newTokensByDay).reduce((a, b) => a + b, 0);
					if (
						!safeCount(counted) ||
						counted !== l.chunks.reduce((n, chunk) => n + chunk.actual, 0) + (l.current?.budget.actual ?? 0)
					)
						return undefined;
					this.ledger = l;
				} else {
					this.ledger = {
						v: 1,
						approval: c.approval,
						historicTokensByDay: { ...c.historicTokensByDay },
						historicUnknownByDay: { ...c.historicUnknownByDay },
						newTokensByDay: {},
						chunks: [],
						configProof: proof,
					};
					this.save();
				}
			}
			return c;
		} catch {
			return undefined;
		}
	}
	/** Called by the qualified reader's existing diagnostic hook; no content is retained. */
	prepare(records: DecisionRecord[]): void {
		const s = this.store.settings();
		this.invalidGroup = undefined;
		if (
			records.length === 0 ||
			records.length > BATCH_RECORD_LIMIT ||
			new Set(records.map((r) => r.id)).size !== records.length
		)
			this.invalidGroup = "record batch exceeds its boundary";
		if (
			s.initiatives.length !== 1 ||
			s.initiatives[0] !== "team-in-temper" ||
			this.store.inInitiatives(records, ["team-in-temper"]).length !== records.length
		)
			this.invalidGroup = "record outside Team in Temper";
		this.activeIds = records.map((r) => r.id);
		if (!this.config() || this.invalidGroup || this.ledger!.halted) return;
		const current = this.ledger!.current;
		if (current?.budget.pending) return; // never reset a timed-out reservation
		if (current && !this.activeIds.every((id) => current.ids.includes(id))) {
			if (!current.ids.every((id) => this.store.readerState().read[id])) {
				this.invalidGroup = "unfinished prior record batch";
				return;
			}
			this.finish("records complete");
		}
		if (!this.ledger!.current) this.start();
	}
	private start(): void {
		const read = this.store.readerState().read;
		this.ledger!.current = {
			n: this.ledger!.chunks.length + 1,
			at: this.now(),
			ids: [...this.activeIds],
			alreadyRead: this.activeIds.filter((id) => !!read[id]),
			budget: newTokenBudget(),
		};
		delete this.ledger!.stopReason;
		this.save();
	}
	private finish(reason: string): void {
		const l = this.ledger!;
		const c = l.current;
		if (!c || c.budget.pending) return;
		const read = this.store.readerState().read;
		const row: ChunkSummary = {
			n: c.n,
			at: c.at,
			ended: this.now(),
			reason,
			selected: c.ids.length,
			newRead: c.ids.filter((id) => read[id] && !c.alreadyRead.includes(id)).length,
			actual: c.budget.actual,
			unknown: 0,
			calls: c.budget.calls,
		};
		l.chunks.push(row);
		delete l.current;
		this.save();
		this.opts.log?.(row);
	}
	progress(): void {
		if (!this.ledger?.current) return;
		const c = this.ledger.current;
		const read = this.store.readerState().read;
		if (c.ids.some((id) => read[id] === "x")) {
			this.pause("reader gave up on a record", true);
			return;
		}
		if (!c.budget.pending && c.ids.every((id) => read[id])) this.finish("records complete");
	}
	private guardBlock(identity?: ReaderIdentity): string | undefined {
		if (!this.config()) return "batch configuration unavailable or changed";
		const s = this.store.settings();
		if (!s.enabled) return "reader disabled";
		if (
			s.model !== "auto" ||
			s.thinking !== "medium" ||
			s.initiatives.length !== 1 ||
			s.initiatives[0] !== "team-in-temper" ||
			s.dailyTokenCap !== 6_000_000 ||
			s.batchRecords > BATCH_RECORD_LIMIT
		)
			return "reader settings differ from approval";
		if (this.invalidGroup || !this.activeIds.length) return this.invalidGroup ?? "record batch unavailable";
		if (
			identity &&
			(identity.provider !== BATCH_PROVIDER || identity.id !== BATCH_MODEL || identity.thinking !== "medium")
		)
			return "reader identity mismatch";
		try {
			const active =
				this.opts.guardActive?.() ??
				execFileSync("systemctl", ["--user", "show", BATCH_GUARD_UNIT, "-p", "ActiveState", "--value"], {
					encoding: "utf8",
					timeout: 5_000,
				}).trim() === "active";
			const g = readJson(this.guardFile) as {
				provider?: string;
				guardExpiresAt?: number;
				stopped?: boolean;
				lastReading?: { at: number; week: number; five: number };
			};
			if (
				!active ||
				g.provider !== BATCH_PROVIDER ||
				!Number.isFinite(g.guardExpiresAt) ||
				g.guardExpiresAt! * 1000 <= this.now() ||
				g.stopped !== false
			)
				return "usage guard inactive or stopped";
			return quotaBlock(g.lastReading ? { ...g.lastReading, at: g.lastReading.at * 1000 } : undefined, this.now());
		} catch {
			return "usage guard unavailable";
		}
	}
	preflight(identity?: ReaderIdentity): string | undefined {
		const reason = this.guardBlock(identity);
		if (reason) return reason;
		if (this.ledger?.halted) return this.ledger.stopReason ?? "reader stopped after failure";
		if (!this.ledger?.current || !validBudget(this.ledger.current.budget)) return "current batch unavailable";
		if (this.ledger.current.budget.pending) return "unresolved call cost";
		return undefined;
	}
	/** Every call receives a durable allowance BEFORE the one prompt. */
	reserve(inputUpper: number, outputUpper: number, identity: ReaderIdentity): string | undefined {
		const reason = this.preflight(identity);
		if (reason) return reason;
		const l = this.ledger!;
		let block = reservationBlock(l.current!.budget, inputUpper, outputUpper, this.now());
		if (block === "batch boundary" && inputUpper + outputUpper <= BATCH_TOKEN_LIMIT) {
			this.finish("token boundary");
			this.start(); // same unfinished records; no semantic retry or completed record is discarded
			block = reservationBlock(l.current!.budget, inputUpper, outputUpper, this.now());
		}
		if (block) return block;
		const day = localDay(this.now());
		const dayUsed =
			(l.historicTokensByDay[day] ?? 0) + (l.historicUnknownByDay[day] ?? 0) + (l.newTokensByDay[day] ?? 0);
		if (dayUsed + inputUpper + outputUpper > 6_000_000) return "daily token boundary";
		reserveTokens(l.current!.budget, inputUpper, outputUpper, this.now());
		this.save();
		return undefined;
	}
	settle(usage: { input: number; output: number }): void {
		const l = this.ledger;
		if (!l?.current) throw new Error("batch reservation missing");
		settleTokens(l.current.budget, usage);
		const day = localDay(this.now());
		l.newTokensByDay[day] = (l.newTokensByDay[day] ?? 0) + usage.input + usage.output;
		delete l.stopReason;
		this.save();
	}
	pause(reason: string, terminal = false): void {
		if (!this.ledger) this.config();
		if (this.ledger) {
			this.ledger.stopReason = reason;
			if (terminal) this.ledger.halted = true;
			this.save();
		}
		this.opts.log?.({ stopped: reason, at: this.now() });
	}
	status(): {
		recorded: number | null;
		unknown: number | null;
		allocated: number | null;
		chunks: number;
		currentAllocated: number | null;
		stopped?: string;
	} {
		this.config();
		const l = this.ledger;
		if (!l)
			return {
				recorded: null,
				unknown: null,
				allocated: null,
				chunks: 0,
				currentAllocated: null,
				stopped: "batch configuration unavailable",
			};
		const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
		const recorded = sum(l.historicTokensByDay) + sum(l.newTokensByDay);
		const unknown = sum(l.historicUnknownByDay) + (l.current?.budget.pending?.tokens ?? 0);
		return {
			recorded,
			unknown,
			allocated: recorded + unknown,
			chunks: l.chunks.length,
			currentAllocated: l.current ? allocated(l.current.budget) : 0,
			...(l.stopReason ? { stopped: l.stopReason } : {}),
		};
	}
}
