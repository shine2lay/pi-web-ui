// App-owned sequential history chunks. All model judgment remains in DecisionReader.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { localDay, type DecisionRecord } from "./decision-records.js";
import type { DecisionStore } from "./decision-store.js";
import type { ReaderIdentity } from "./decision-call-lifecycle.js";
import {
	allocated,
	BATCH_TOKEN_LIMIT,
	heldTokens,
	newTokenBudget,
	quotaBlock,
	reservationBlock,
	reserveTokens,
	safeCount,
	settleTokens,
	validBudget,
	validDay,
	type TokenBudget,
	type UnknownCharge,
} from "./decision-batch-budget.js";
import {
	canonical,
	collectLegacyProof,
	H7,
	H7_NONCE,
	nativeH7Approval,
	newLocalCall,
	parseRecoveryCommand,
	persistLedger,
	recoveryReceipt,
	sha256,
	verifyLegacyProof,
	withLedgerExclusion,
	type LegacyProof,
	type NativeApproval,
	type PersistStage,
	type RecoveryCommand,
	type RecoveryReceipt,
} from "./decision-recovery.js";
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
	unknowns?: UnknownCharge[];
}
export interface BatchLedger {
	v: 1 | 2;
	generation?: number;
	approval: string;
	historicTokensByDay: Record<string, number>;
	historicUnknownByDay: Record<string, number>;
	newTokensByDay: Record<string, number>;
	chunks: ChunkSummary[];
	current?: Chunk;
	stopReason?: string;
	halted?: boolean;
	configProof: string;
	carriedUnknownByDay?: Record<string, number>;
	receipts?: Record<string, RecoveryReceipt>;
	audit?: { beforeHash: string; beforeImage: string };
}
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}
function validDays(value: unknown): value is Record<string, number> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.entries(value).every(([day, n]) => validDay(day) && safeCount(n))
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
export function carriedDays(l: BatchLedger): Record<string, number> {
	const out: Record<string, number> = {};
	for (const c of [
		...l.chunks.map((r) => ({ n: r.n, unknowns: r.unknowns ?? [] })),
		...(l.current ? [{ n: l.current.n, unknowns: l.current.budget.unknowns ?? [] }] : []),
	]) {
		for (const r of c.unknowns) {
			if (r.chunk !== c.n) throw new Error("unknown charge moved to another chunk");
			out[r.day] = (out[r.day] ?? 0) + r.tokens;
		}
	}
	return out;
}
export function validLedger(l: BatchLedger, c: BatchConfig): boolean {
	try {
		if (
			!l ||
			![1, 2].includes(l.v) ||
			l.configProof !== JSON.stringify(c) ||
			l.approval !== c.approval ||
			canonical(l.historicTokensByDay) !== canonical(c.historicTokensByDay) ||
			canonical(l.historicUnknownByDay) !== canonical(c.historicUnknownByDay) ||
			!Array.isArray(l.chunks) ||
			!validDays(l.newTokensByDay) ||
			(l.generation !== undefined && !safeCount(l.generation)) ||
			(l.stopReason !== undefined && typeof l.stopReason !== "string") ||
			(l.halted !== undefined && typeof l.halted !== "boolean")
		)
			return false;
		const current = l.current;
		if (
			current &&
			(!safeCount(current.at) ||
				!validBudget(current.budget) ||
				current.budget.v !== l.v ||
				!Array.isArray(current.ids) ||
				!current.ids.length ||
				current.ids.length > BATCH_RECORD_LIMIT ||
				!current.ids.every((id) => typeof id === "string" && id.length > 0) ||
				new Set(current.ids).size !== current.ids.length ||
				!Array.isArray(current.alreadyRead) ||
				new Set(current.alreadyRead).size !== current.alreadyRead.length ||
				!current.alreadyRead.every((id) => current.ids.includes(id)) ||
				current.n !== l.chunks.length + 1)
		)
			return false;
		if (
			!l.chunks.every(
				(r, i) =>
					r.n === i + 1 &&
					safeCount(r.at) &&
					safeCount(r.ended) &&
					r.ended >= r.at &&
					typeof r.reason === "string" &&
					safeCount(r.actual) &&
					safeCount(r.unknown) &&
					r.actual + r.unknown <= BATCH_TOKEN_LIMIT &&
					safeCount(r.calls) &&
					safeCount(r.selected) &&
					r.selected > 0 &&
					r.selected <= BATCH_RECORD_LIMIT &&
					safeCount(r.newRead) &&
					r.newRead <= r.selected &&
					(l.v === 1
						? r.unknown === 0 && r.unknowns === undefined
						: validBudget({ v: 2, limit: BATCH_TOKEN_LIMIT, actual: r.actual, calls: r.calls, unknowns: r.unknowns }) &&
							r.unknown === (r.unknowns ?? []).reduce((n, hold) => n + hold.tokens, 0)),
			)
		)
			return false;
		if (
			!safeCount(sum(l.newTokensByDay)) ||
			sum(l.newTokensByDay) !== l.chunks.reduce((n, r) => n + r.actual, 0) + (current?.budget.actual ?? 0)
		)
			return false;
		if (l.v === 1) return l.carriedUnknownByDay === undefined && l.receipts === undefined && l.audit === undefined;
		if (
			!safeCount(l.generation) ||
			!validDays(l.carriedUnknownByDay) ||
			canonical(l.carriedUnknownByDay) !== canonical(carriedDays(l)) ||
			!l.receipts ||
			Object.keys(l.receipts).length !== 1 ||
			!l.audit ||
			l.audit.beforeHash !== H7.beforeHash ||
			sha256(l.audit.beforeImage) !== H7.beforeHash
		)
			return false;
		const before = JSON.parse(l.audit.beforeImage) as BatchLedger;
		if (
			before.v !== 1 ||
			!validLedger(before, c) ||
			l.generation! <= (before.generation ?? 0) ||
			l.chunks.length < before.chunks.length ||
			before.chunks.some((row, i) => {
				const { unknowns: _unknowns, ...unchanged } = l.chunks[i];
				return canonical(unchanged) !== canonical(row);
			}) ||
			Object.entries(before.newTokensByDay).some(([day, tokens]) => (l.newTokensByDay[day] ?? 0) < tokens)
		)
			return false;
		const receipt = l.receipts[H7_NONCE];
		if (!receipt || receipt.hash !== sha256(canonical(receipt.payload))) return false;
		const p = receipt.payload;
		if (
			Object.keys(p).sort().join("|") !==
				"approval|beforeGeneration|beforeHash|chunk|ids|meaning|nonce|operation|originDay|proof|reservation|reservationHash|unknownTokens|v" ||
			p.beforeGeneration !== (before.generation ?? 0) ||
			canonical(p.reservation) !== canonical(before.current?.budget.pending) ||
			p.v !== 1 ||
			p.operation !== H7.operation ||
			p.nonce !== H7_NONCE ||
			p.beforeHash !== H7.beforeHash ||
			p.chunk !== H7.chunk ||
			canonical(p.ids) !== canonical(H7.ids) ||
			p.originDay !== H7.day ||
			p.unknownTokens !== H7.tokens ||
			p.reservationHash !== sha256(canonical(p.reservation)) ||
			p.approval.recordId !== H7.approvalId ||
			p.approval.rawHash !== H7.approvalHash ||
			p.approval.ref !== H7.approvalRef ||
			p.approval.question !== H7.question ||
			!safeCount(p.approval.at) ||
			p.approval.at <= H7.at ||
			p.approval.planHash !== H7.planHash ||
			p.approval.nativePlanHash !== H7.nativePlanHash ||
			p.approval.evidenceHash !== H7.evidenceHash ||
			p.meaning !== "LOCAL_DEATH_ONLY_COST_UNKNOWN"
		)
			return false;
		verifyLegacyProof(p.proof, p.proof.at); // receipt-time proof; not fresh permission on cold load
		const holds = [...l.chunks.flatMap((r) => r.unknowns ?? []), ...(current?.budget.unknowns ?? [])];
		if (holds.length !== 1) return false;
		const h = holds[0];
		return (
			h.chunk === H7.chunk &&
			h.day === H7.day &&
			h.tokens === H7.tokens &&
			h.at === H7.at &&
			h.inputUpper === H7.inputUpper &&
			h.outputUpper === H7.outputUpper &&
			h.receipt === receipt.hash &&
			h.id === sha256(canonical({ beforeHash: H7.beforeHash, chunk: H7.chunk, reservationHash: p.reservationHash }))
		);
	} catch {
		return false;
	}
}
export interface WriteFence {
	hash: string;
	generation: number;
	callRef?: string;
}
export interface BatchControlOptions {
	now?: () => number;
	guardActive?: () => boolean;
	log?: (row: ChunkSummary | { stopped: string; at: number }) => void;
	/** Trusted host dependencies for isolated deterministic fixtures; never control-socket input. */
	recoveryApproval?: () => NativeApproval;
	recoveryProof?: (quiescent: boolean) => LegacyProof;
	persistFault?: (stage: PersistStage) => void;
}
export interface RecoveryResult {
	ok: boolean;
	error?: string;
	dryRun?: boolean;
	existing?: boolean;
	receiptHash?: string;
	proofHash?: string;
	beforeHash?: string;
	wholeFileHash?: string;
	generation?: number;
	recorded?: number;
	unknown?: number;
	allocated?: number;
	remaining?: number;
}
export class DecisionBatchControl {
	private activeIds: string[] = [];
	private activeCallRef: string | undefined;
	private invalidGroup: string | undefined;
	private configProof: string | undefined;
	private ledger: BatchLedger | undefined;
	private ledgerHash: string | undefined;
	private locked = false;
	private invalidated = false;
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
	private config(): BatchConfig | undefined {
		if (this.invalidated) return undefined;
		try {
			const c = parseBatchConfig(readJson(this.configFile));
			if (!c) return undefined;
			const proof = JSON.stringify(c);
			if (this.configProof && this.configProof !== proof) return undefined;
			this.configProof = proof;
			if (existsSync(this.ledgerFile)) {
				const raw = readFileSync(this.ledgerFile, "utf8");
				const hash = sha256(raw);
				if (this.ledger && (this.ledgerHash !== hash || !validLedger(this.ledger, c))) return undefined; // never refresh a stale writer
				if (!this.ledger) {
					const l = JSON.parse(raw) as BatchLedger;
					if (!validLedger(l, c)) return undefined;
					this.ledger = l;
					this.ledgerHash = hash;
				}
			} else if (this.ledger) return undefined;
			return c;
		} catch {
			return undefined;
		}
	}
	/** No constructor/status/startup write or migration. Creation is an explicit prepare transaction. */
	private transact<T>(run: () => T, fence?: WriteFence): T {
		return withLedgerExclusion(this.ledgerFile, () => {
			this.locked = true;
			try {
				if (!this.config()) throw new Error("batch configuration unavailable or changed");
				if (
					fence &&
					(fence.hash !== this.ledgerHash ||
						fence.generation !== (this.ledger?.generation ?? 0) ||
						(fence.callRef && fence.callRef !== this.ledger?.current?.budget.pending?.local?.ref))
				)
					throw new Error("stale batch generation or local call");
				const out = run();
				if (fence) {
					fence.hash = this.ledgerHash ?? "";
					fence.generation = this.ledger?.generation ?? 0;
				}
				return out;
			} finally {
				this.locked = false;
			}
		});
	}
	private save(): void {
		if (!this.locked || !this.ledger) throw new Error("ledger write outside exclusion");
		const c = parseBatchConfig(readJson(this.configFile));
		if (!c || JSON.stringify(c) !== this.configProof) throw new Error("batch configuration unavailable or changed");
		this.ledger.generation = (this.ledger.generation ?? 0) + 1;
		if (!validLedger(this.ledger, c)) throw new Error("invalid ledger after-image");
		try {
			this.ledgerHash = persistLedger(this.ledgerFile, this.ledgerHash, this.ledger, this.opts.persistFault);
		} catch (error) {
			this.invalidated = true;
			throw error;
		}
	}
	captureFence(): WriteFence | undefined {
		if (!this.config() || !this.ledgerHash) return undefined;
		return { hash: this.ledgerHash, generation: this.ledger?.generation ?? 0 };
	}
	localCallRef(): string | undefined {
		return this.activeCallRef;
	}
	localCallMetadata() {
		const local = this.ledger?.current?.budget.pending?.local;
		return local && local.ref === this.activeCallRef ? { ...local } : undefined;
	}
	prepare(records: DecisionRecord[]): void {
		this.invalidGroup = undefined;
		const s = this.store.settings();
		if (
			!records.length ||
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
		const config = this.config();
		if (!s.enabled || !config || this.invalidGroup || this.ledger?.halted) return;
		this.transact(() => {
			if (!this.ledger)
				this.ledger = {
					v: 1,
					approval: config.approval,
					historicTokensByDay: { ...config.historicTokensByDay },
					historicUnknownByDay: { ...config.historicUnknownByDay },
					newTokensByDay: {},
					chunks: [],
					configProof: this.configProof!,
				};
			const current = this.ledger.current;
			if (current?.budget.pending) return;
			if (current && !this.activeIds.every((id) => current.ids.includes(id))) {
				if (!current.ids.every((id) => this.store.readerState().read[id])) {
					this.invalidGroup = "unfinished prior record batch";
					return;
				}
				this.finish("records complete");
			}
			if (!this.ledger.current) this.start();
		});
	}
	private start(): void {
		const read = this.store.readerState().read;
		this.ledger!.current = {
			n: this.ledger!.chunks.length + 1,
			at: this.now(),
			ids: [...this.activeIds],
			alreadyRead: this.activeIds.filter((id) => !!read[id]),
			budget: newTokenBudget(this.ledger!.v),
		};
		delete this.ledger!.stopReason;
		this.save();
	}
	private finish(reason: string): void {
		const l = this.ledger!,
			c = l.current;
		if (!c || c.budget.pending) return;
		if (heldTokens(c.budget) && !c.ids.every((id) => this.store.readerState().read[id]))
			throw new Error("unfinished recovered chunk cannot roll over");
		const read = this.store.readerState().read;
		const row: ChunkSummary = {
			n: c.n,
			at: c.at,
			ended: this.now(),
			reason,
			selected: c.ids.length,
			newRead: c.ids.filter((id) => read[id] && !c.alreadyRead.includes(id)).length,
			actual: c.budget.actual,
			unknown: heldTokens(c.budget),
			calls: c.budget.calls,
			...(l.v === 2 ? { unknowns: structuredClone(c.budget.unknowns ?? []) } : {}),
		};
		l.chunks.push(row);
		delete l.current;
		this.save();
		this.opts.log?.(row);
	}
	progress(): void {
		if (!this.activeIds.length || !this.ledger?.current) return;
		this.transact(() => {
			const c = this.ledger!.current!,
				read = this.store.readerState().read;
			if (c.ids.some((id) => read[id] === "x")) {
				this.pauseLocked("reader gave up on a record", true);
				return;
			}
			if (!c.budget.pending && c.ids.every((id) => read[id])) this.finish("records complete");
		});
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
	reserve(inputUpper: number, outputUpper: number, identity: ReaderIdentity, fence?: WriteFence): string | undefined {
		try {
			return this.transact(() => {
				const reason = this.preflight(identity);
				if (reason) return reason;
				const l = this.ledger!;
				let block = reservationBlock(l.current!.budget, inputUpper, outputUpper, this.now());
				if (block === "batch boundary" && heldTokens(l.current!.budget)) return "recovered chunk allowance exhausted";
				if (block === "batch boundary" && inputUpper + outputUpper <= BATCH_TOKEN_LIMIT) {
					this.finish("token boundary");
					this.start();
					block = reservationBlock(l.current!.budget, inputUpper, outputUpper, this.now());
				}
				if (block) return block;
				// Until the recovered IDs finish, neither chunk room nor its original day can roll over.
				const day = l.current!.budget.unknowns?.[0]?.day ?? localDay(this.now());
				const used =
					(l.historicTokensByDay[day] ?? 0) +
					(l.historicUnknownByDay[day] ?? 0) +
					(l.newTokensByDay[day] ?? 0) +
					(l.carriedUnknownByDay?.[day] ?? 0);
				if (!safeCount(used) || used + inputUpper + outputUpper > 6_000_000) return "daily token boundary";
				const call = { ...newLocalCall(this.now()), day };
				reserveTokens(l.current!.budget, inputUpper, outputUpper, this.now(), call);
				this.save();
				this.activeCallRef = call.ref;
				if (fence) fence.callRef = call.ref;
				return undefined;
			}, fence);
		} catch (error) {
			return error instanceof Error ? error.message : "ledger writer unavailable";
		}
	}
	settle(usage: { input: number; output: number }, fence?: WriteFence): void {
		this.transact(() => {
			const l = this.ledger;
			if (!l?.current) throw new Error("batch reservation missing");
			const pending = l.current.budget.pending;
			const day = pending?.local?.day ?? (pending ? localDay(pending.at) : undefined);
			if (!day || pending?.local?.ref !== (fence?.callRef ?? this.activeCallRef)) throw new Error("stale local call");
			settleTokens(l.current.budget, usage, fence?.callRef ?? this.activeCallRef);
			l.newTokensByDay[day] = (l.newTokensByDay[day] ?? 0) + usage.input + usage.output;
			delete l.stopReason;
			this.save();
			this.activeCallRef = undefined;
			if (fence) delete fence.callRef;
		}, fence);
	}
	private pauseLocked(reason: string, terminal: boolean): void {
		if (!this.ledger) return;
		this.ledger.stopReason = reason;
		if (terminal) this.ledger.halted = true;
		this.save();
	}
	pause(reason: string, terminal = false, fence?: WriteFence): void {
		this.transact(() => {
			const local = this.ledger?.current?.budget.pending?.local;
			if (local && local.ref !== (fence?.callRef ?? this.activeCallRef)) throw new Error("stale local call");
			this.pauseLocked(reason, terminal);
		}, fence);
		this.opts.log?.({ stopped: reason, at: this.now() });
	}
	recover(command: RecoveryCommand, quiescent: boolean): RecoveryResult {
		try {
			if (!parseRecoveryCommand(command)) throw new Error("invalid recovery operation binding");
			return this.transact(() => {
				if (this.store.settings().enabled || !quiescent || this.activeCallRef)
					throw new Error("reader must be disabled and quiescent");
				const l = this.ledger;
				if (!l) throw new Error("batch ledger missing");
				const approval = this.opts.recoveryApproval?.() ?? nativeH7Approval(this.store.dir);
				const existing = l.receipts?.[H7_NONCE];
				if (existing) {
					if (canonical(existing.payload.approval) !== canonical(approval)) throw new Error("replay approval mismatch");
					return this.recoveryResult(existing, command.dryRun, true);
				}
				if (
					l.v !== 1 ||
					this.ledgerHash !== H7.beforeHash ||
					l.current?.n !== H7.chunk ||
					canonical(l.current.ids) !== canonical(H7.ids) ||
					l.current.alreadyRead.length ||
					l.current.budget.actual !== 0 ||
					l.current.budget.calls !== 0 ||
					canonical(l.current.budget.pending) !==
						canonical({ tokens: H7.tokens, inputUpper: H7.inputUpper, outputUpper: H7.outputUpper, at: H7.at }) ||
					H7.ids.some((id) => this.store.readerState().read[id])
				)
					throw new Error("approved legacy reservation changed");
				const originUsed =
					(l.historicTokensByDay[H7.day] ?? 0) +
					(l.historicUnknownByDay[H7.day] ?? 0) +
					(l.newTokensByDay[H7.day] ?? 0) +
					H7.tokens;
				if (
					!safeCount(originUsed) ||
					originUsed >= 6_000_000 ||
					BATCH_TOKEN_LIMIT - allocated(l.current.budget) < H7.tokens
				)
					throw new Error("approved recovery has insufficient retained allowance");
				const proof = this.opts.recoveryProof?.(quiescent) ?? collectLegacyProof(quiescent);
				verifyLegacyProof(proof, this.now());
				const receipt = recoveryReceipt(approval, proof, l.current.budget.pending!, l.generation ?? 0);
				if (command.dryRun) return this.recoveryResult(receipt, true, false);
				const raw = readFileSync(this.ledgerFile, "utf8");
				const hold: UnknownCharge = {
					...l.current.budget.pending!,
					id: sha256(
						canonical({ beforeHash: H7.beforeHash, chunk: H7.chunk, reservationHash: receipt.payload.reservationHash }),
					),
					day: H7.day,
					chunk: H7.chunk,
					receipt: receipt.hash,
				};
				l.v = 2;
				l.current.budget.v = 2;
				l.current.budget.unknowns = [hold];
				delete l.current.budget.pending;
				for (const r of l.chunks) r.unknowns = [];
				l.carriedUnknownByDay = { [H7.day]: H7.tokens };
				l.receipts = { [H7_NONCE]: receipt };
				l.audit = { beforeHash: H7.beforeHash, beforeImage: raw };
				// Release only the interrupted-call stop; unrelated stops/terminal holds are not waived.
				if (l.stopReason === "unresolved call cost") delete l.stopReason;
				this.save();
				this.activeIds = [];
				return this.recoveryResult(receipt, false, false);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : "recovery unavailable";
			return {
				ok: false,
				error:
					/^(?:native |approved |legacy |reader |batch |origin-|invalid |stale |ledger |replay |current |process |installed )/.test(
						message,
					)
						? message
						: "recovery evidence or durable state unavailable",
			};
		}
	}
	private recoveryResult(r: RecoveryReceipt, dryRun: boolean, existing: boolean): RecoveryResult {
		const s = this.status();
		return {
			ok: true,
			dryRun,
			existing,
			receiptHash: r.hash,
			proofHash: sha256(canonical(r.payload.proof)),
			beforeHash: r.payload.beforeHash,
			wholeFileHash: this.ledgerHash,
			generation: this.ledger?.generation ?? 0,
			recorded: s.recorded!,
			unknown: s.unknown!,
			allocated: s.allocated!,
			remaining: BATCH_TOKEN_LIMIT - (s.currentAllocated ?? BATCH_TOKEN_LIMIT),
		};
	}
	status(): {
		recorded: number | null;
		unknown: number | null;
		allocated: number | null;
		chunks: number;
		currentAllocated: number | null;
		stopped?: string;
	} {
		const c = this.config(),
			l = c ? this.ledger : undefined;
		if (!l)
			return {
				recorded: null,
				unknown: null,
				allocated: null,
				chunks: 0,
				currentAllocated: null,
				stopped: "batch configuration unavailable",
			};
		const recorded = sum(l.historicTokensByDay) + sum(l.newTokensByDay);
		const unknown =
			sum(l.historicUnknownByDay) + sum(l.carriedUnknownByDay ?? {}) + (l.current?.budget.pending?.tokens ?? 0);
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
