/** Numbers-only, best-effort observation. Never await storage from an SDK listener. */
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent, SessionEntry } from "@earendil-works/pi-coding-agent";

export type UsageLedgerApp =
	"plugin-llm" | "decision-model" | "decision-bounded-model" | "goal-wizard" | "goal-reviewer";
export type UsageLedgerMeta = {
	dataDir?: string;
	conversationId?: string;
	parentConversationId?: string | null;
} & ({ origin: "chat" | "helper"; app?: never } | { origin: "app"; app: UsageLedgerApp });
export interface UsageLedgerRecord {
	v: "usage-ledger/1";
	at: string;
	occurredAt: string;
	kind: "assistant" | "cache_warm" | "compaction" | "branch_summary";
	provider: string | null;
	model: string | null;
	modelSource: "response" | "requested";
	responseId: string | null;
	stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | null;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal: number | null;
	conversationId: string;
	sessionId: string;
	sessionFile: string | null;
	persist: boolean;
	origin: "chat" | "helper" | "app";
	parentConversationId: string | null;
	app?: UsageLedgerApp;
}

type Metadata = UsageLedgerMeta | (() => UsageLedgerMeta);
export type UsageLedgerSession = Pick<AgentSession, "subscribe" | "sessionId" | "sessionFile" | "model"> & {
	sessionManager: Pick<AgentSession["sessionManager"], "isPersisted" | "getLeafEntry">;
};
type NumericUsage = Pick<
	UsageLedgerRecord,
	"input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens" | "costTotal"
>;
interface Observation {
	kind: UsageLedgerRecord["kind"];
	usage: unknown;
	timestamp?: unknown;
	provider?: unknown;
	model?: unknown;
	responseId?: unknown;
	stopReason?: unknown;
	response?: boolean;
	key?: string;
	object: object;
}
const apps = new Set<UsageLedgerApp>([
	"plugin-llm",
	"decision-model",
	"decision-bounded-model",
	"goal-wizard",
	"goal-reviewer",
]);
const stopReasons = new Set(["stop", "length", "toolUse", "error", "aborted"]);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const nonnegative = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value) && value >= 0;
function numbers(raw: unknown): NumericUsage | undefined {
	if (!raw || typeof raw !== "object") return;
	const u = raw as Record<string, unknown>;
	if (!nonnegative(u.input) || !nonnegative(u.output)) return;
	if (u.cacheRead !== undefined && !nonnegative(u.cacheRead)) return;
	if (u.cacheWrite !== undefined && !nonnegative(u.cacheWrite)) return;
	if (u.totalTokens !== undefined && !nonnegative(u.totalTokens)) return;
	const cacheRead = (u.cacheRead as number | undefined) ?? 0;
	const cacheWrite = (u.cacheWrite as number | undefined) ?? 0;
	const totalTokens = (u.totalTokens as number | undefined) ?? u.input + u.output + cacheRead + cacheWrite;
	if (!nonnegative(totalTokens)) return;
	const cost = u.cost && typeof u.cost === "object" ? (u.cost as { total?: unknown }).total : undefined;
	return {
		input: u.input,
		output: u.output,
		cacheRead,
		cacheWrite,
		totalTokens,
		costTotal: nonnegative(cost) ? cost : null,
	};
}
function timestamp(raw: unknown, fallback: string): string {
	if (typeof raw !== "string" && typeof raw !== "number") return fallback;
	const date = new Date(raw);
	return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

/** Injectable I/O only for sealed tests; warnings never include the rejected object or exception. */
export class UsageLedger {
	private pending: Promise<void> = Promise.resolve();
	private lastWarning = -Infinity;
	constructor(
		readonly dataDir: string,
		private readonly options: {
			now?: () => number;
			warn?: (message: string) => void;
			append?: (record: UsageLedgerRecord) => Promise<void>;
		} = {},
	) {}
	warn(): void {
		try {
			const now = this.options.now?.() ?? Date.now();
			if (now - this.lastWarning < 60_000) return;
			this.lastWarning = now;
			(this.options.warn ?? console.warn)(
				"[usage-ledger] Usage record skipped; check ledger settings, permissions and storage.",
			);
		} catch {
			/* Observers must never change a session, even if the logger fails. */
		}
	}
	/** Called only with a freshly projected scalar record, never an SDK event. */
	enqueue(record: UsageLedgerRecord): void {
		this.pending = this.pending
			.then(async () => {
				if (!(await this.enabled())) return;
				if (this.options.append) await this.options.append(record);
				else await this.append(record);
			})
			.catch(() => this.warn());
	}
	/** Test/diagnostic drain; deliberately not called by any chat or model lifecycle. */
	async flush(): Promise<void> {
		await this.pending;
	}
	private async enabled(): Promise<boolean> {
		try {
			const config = JSON.parse(await readFile(join(this.dataDir, "usage-ledger.json"), "utf8")) as {
				enabled?: unknown;
			} | null;
			if (!config || typeof config.enabled !== "boolean") throw new Error("invalid ledger switch");
			return config.enabled;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
			throw error;
		}
	}
	private async append(record: UsageLedgerRecord): Promise<void> {
		const directory = join(this.dataDir, "usage-ledger");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a ledger directory");
		if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
		const file = await open(
			join(directory, `${record.at.slice(0, 7)}.jsonl`),
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.nlink !== 1) throw new Error("not a private regular ledger file");
			if ((stat.mode & 0o777) !== 0o600) await file.chmod(0o600);
			await file.appendFile(`${JSON.stringify(record)}\n`, "utf8");
		} finally {
			await file.close();
		}
	}
}
const ledgers = new Map<string, UsageLedger>();
function ledgerFor(meta: UsageLedgerMeta): UsageLedger {
	const directory = resolve(meta.dataDir ?? process.env.PI_WEB_DATA_DIR ?? join(homedir(), ".pi-web-ui"));
	let ledger = ledgers.get(directory);
	if (!ledger) {
		ledger = new UsageLedger(directory);
		ledgers.set(directory, ledger);
	}
	return ledger;
}
interface Attachment {
	meta: Metadata;
	ledger?: UsageLedger;
	objects: WeakSet<object>;
	keys: Set<string>;
	compactionModel?: { provider: string; id: string };
	unsubscribe: () => void;
}
const attachments = new WeakMap<UsageLedgerSession, Attachment>();
const fallbackWarning = new UsageLedger("");
function warn(state: Attachment): void {
	try {
		if (state.ledger) {
			state.ledger.warn();
			return;
		}
		const meta = typeof state.meta === "function" ? state.meta() : state.meta;
		(state.ledger ?? ledgerFor(meta)).warn();
	} catch {
		fallbackWarning.warn();
	}
}
function record(session: UsageLedgerSession, state: Attachment, observation: Observation): void {
	try {
		const meta = typeof state.meta === "function" ? state.meta() : state.meta;
		const ledger = state.ledger ?? ledgerFor(meta);
		const usage = numbers(observation.usage);
		if (!usage || state.objects.has(observation.object)) return;
		if (meta.origin === "app" && !apps.has(meta.app)) return;
		const sessionId = session.sessionId;
		const key = observation.key ? `${sessionId}:${observation.kind}:${observation.key}` : undefined;
		if (key && state.keys.has(key)) return;
		const requested = observation.kind === "compaction" ? (state.compactionModel ?? session.model) : session.model;
		const responseModel = observation.response ? text(observation.model) : null;
		const at = new Date().toISOString();
		const row: UsageLedgerRecord = {
			v: "usage-ledger/1",
			at,
			occurredAt: timestamp(observation.timestamp, at),
			kind: observation.kind,
			provider: text(observation.provider) ?? requested?.provider ?? null,
			model: responseModel ?? text(observation.model) ?? requested?.id ?? null,
			modelSource: responseModel ? "response" : "requested",
			responseId: text(observation.responseId),
			stopReason:
				typeof observation.stopReason === "string" && stopReasons.has(observation.stopReason)
					? (observation.stopReason as UsageLedgerRecord["stopReason"])
					: null,
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			costTotal: usage.costTotal,
			conversationId: meta.conversationId ?? (meta.origin === "app" ? `app:${sessionId}` : sessionId),
			sessionId,
			sessionFile: session.sessionManager.isPersisted() ? (session.sessionFile ?? null) : null,
			persist: session.sessionManager.isPersisted(),
			origin: meta.origin,
			parentConversationId: meta.parentConversationId ?? null,
		};
		if (meta.origin === "app") row.app = meta.app;
		state.objects.add(observation.object);
		if (key) state.keys.add(key);
		ledger.enqueue(row);
	} catch {
		warn(state);
	}
}
/** Also used for navigateTree's returned entry: SDK 1.0.1 emits no public event for that result. */
export function recordUsageLedgerEntry(session: UsageLedgerSession, entry: SessionEntry | undefined): void {
	const state = attachments.get(session);
	if (!state || !entry) return;
	try {
		if (entry.type === "usage" && entry.kind === "cache_warm") {
			record(session, state, {
				kind: "cache_warm",
				usage: entry.usage,
				timestamp: entry.timestamp,
				provider: entry.provider,
				model: entry.model,
				key: entry.id,
				object: entry,
			});
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			record(session, state, {
				kind: entry.type,
				usage: entry.usage,
				timestamp: entry.timestamp,
				key: entry.id,
				object: entry,
			});
		}
	} catch {
		warn(state);
	}
}
/** Idempotent registration; no history scan, SDK mutation, asynchronous listener or lifecycle await. */
export function attachUsageLedger(session: UsageLedgerSession, meta: Metadata, ledger?: UsageLedger): () => void {
	const existing = attachments.get(session);
	if (existing) {
		existing.meta = meta;
		return existing.unsubscribe;
	}
	const state: Attachment = { meta, ledger, objects: new WeakSet(), keys: new Set(), unsubscribe: () => {} };
	attachments.set(session, state);
	try {
		const off = session.subscribe((event: AgentSessionEvent) => {
			try {
				if (event.type === "message_end" && event.message.role === "assistant") {
					const m = event.message;
					record(session, state, {
						kind: "assistant",
						usage: m.usage,
						timestamp: m.timestamp,
						provider: m.provider,
						model: m.model,
						responseId: m.responseId,
						stopReason: m.stopReason,
						response: true,
						key: m.responseId,
						object: m,
					});
				} else if (event.type === "entry_appended") {
					recordUsageLedgerEntry(session, event.entry);
				} else if (event.type === "compaction_start") {
					state.compactionModel = session.model
						? { provider: session.model.provider, id: session.model.id }
						: undefined;
				} else if (event.type === "compaction_end") {
					if (event.result?.usage) {
						const leaf = session.sessionManager.getLeafEntry();
						if (leaf?.type === "compaction" && leaf.usage === event.result.usage) recordUsageLedgerEntry(session, leaf);
						else record(session, state, { kind: "compaction", usage: event.result.usage, object: event.result });
					}
					state.compactionModel = undefined;
				}
			} catch {
				warn(state);
			}
		});
		state.unsubscribe = () => {
			off();
			attachments.delete(session);
		};
	} catch {
		attachments.delete(session);
		warn(state);
	}
	return state.unsubscribe;
}
