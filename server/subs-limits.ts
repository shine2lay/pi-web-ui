/**
 * subs-limits-box: the Limits box under History shows every subscription's limits, as pi-multi-pass
 * reads them. pi-multi-pass owns the checks (Anthropic's and ChatGPT's free usage pages) and keeps the
 * readings in one file, ~/.pi/agent/multi-pass-quota/subs-limits.json, written whole each time. This
 * server only shows that file and passes the refresh button on.
 *
 * The two meet on globalThis under Symbol.for("pi-multi-pass.limits"), like pi-queue's queue host the
 * other way around. Version 1 of that channel:
 *  - v: 1
 *  - listeners: Set<(event: {checking: boolean, readings?}) => void>, called when a check starts or
 *    ends and on every write of the file (numbers seen in a reply too). Either side may create the
 *    channel; the other joins it.
 *  - api?: {check(): Promise<readings>, readings(), checking(): boolean, file: string}, put there by
 *    pi-multi-pass when a chat loads it. check() checks every account and joins a check already running.
 * With no chat loaded yet (or another version), the box still shows the file; refresh then says so.
 * The file is also watched, so a check run elsewhere (the command-line pi's /subs limit-check) shows up.
 */
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import type { ServerMessage, UiLimitWindow, UiLimitsAccount, UiLimitsFailureReason } from "./protocol.js";

export const LIMITS_CHANNEL_KEY = Symbol.for("pi-multi-pass.limits");
export type SubsLimitsMessage = Extract<ServerMessage, { type: "subs_limits" }>;
/** In pi-multi-pass's own data folder (<agent dir>/multi-pass-quota/). */
export const LIMITS_FILE_NAME = "subs-limits.json";

export function limitsFilePath(agentDir: string): string {
	return join(agentDir, "multi-pass-quota", LIMITS_FILE_NAME);
}

export interface LimitsEvent {
	checking?: boolean;
	readings?: unknown;
}

export interface LimitsApiV1 {
	check(): Promise<unknown>;
	readings?(): unknown;
	checking?(): boolean;
	file?: string;
}

export interface LimitsChannelV1 {
	v: 1;
	listeners: Set<(event: LimitsEvent) => void>;
	api?: LimitsApiV1;
}

/** What the box shows: the file's rows, checked. */
export interface LimitsReadingsView {
	accounts: UiLimitsAccount[];
	checkedAt?: number;
}

const REASONS: ReadonlySet<string> = new Set<UiLimitsFailureReason>([
	"signed-out",
	"sign-in-expired",
	"busy",
	"timeout",
	"no-answer",
	"not-subscription",
	"unsupported",
	"error",
]);
const MAX_ACCOUNTS = 50;
const MAX_WINDOWS = 12;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown, max = 200): string | undefined =>
	typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

function cleanWindow(raw: unknown): UiLimitWindow | undefined {
	if (!isObj(raw)) return undefined;
	const key = str(raw.key, 80);
	const label = str(raw.label, 80);
	if (!key || !label) return undefined;
	const used = num(raw.usedPercent);
	const resetAt = num(raw.resetAt);
	return {
		key,
		label,
		...(used !== undefined ? { usedPercent: Math.min(100, Math.max(0, used)) } : {}),
		...(resetAt !== undefined ? { resetAt } : {}),
		...(raw.limited === true ? { limited: true } : {}),
	};
}

function cleanAccount(raw: unknown): UiLimitsAccount | undefined {
	if (!isObj(raw)) return undefined;
	const provider = str(raw.provider, 120);
	const name = str(raw.name, 120);
	if (!provider || !name) return undefined;
	const windows = (Array.isArray(raw.windows) ? raw.windows : [])
		.slice(0, MAX_WINDOWS)
		.map(cleanWindow)
		.filter((w): w is UiLimitWindow => !!w);
	const f = isObj(raw.failure) ? raw.failure : undefined;
	const failure =
		f && typeof f.reason === "string" && REASONS.has(f.reason)
			? {
					reason: f.reason as UiLimitsFailureReason,
					text: str(f.text, 200) ?? f.reason,
					at: num(f.at) ?? 0,
				}
			: undefined;
	const source = raw.source === "check" || raw.source === "reply" ? raw.source : undefined;
	const out: UiLimitsAccount = {
		provider,
		base: str(raw.base, 120) ?? provider,
		number: num(raw.number) ?? 1,
		name,
		windows,
	};
	const label = str(raw.label);
	const email = str(raw.email);
	const plan = str(raw.plan, 40);
	const checkedAt = num(raw.checkedAt);
	const triedAt = num(raw.triedAt);
	if (label) out.label = label;
	if (email) out.email = email;
	if (plan) out.plan = plan;
	if (raw.limited === true) out.limited = true;
	if (checkedAt !== undefined) out.checkedAt = checkedAt;
	if (source) out.source = source;
	if (triedAt !== undefined) out.triedAt = triedAt;
	if (failure) out.failure = failure;
	return out;
}

/** The readings file's content (version 1), checked; anything else = nothing yet. */
export function sanitizeLimits(raw: unknown): LimitsReadingsView | undefined {
	if (!isObj(raw) || raw.version !== 1 || !Array.isArray(raw.accounts)) return undefined;
	const accounts = raw.accounts
		.slice(0, MAX_ACCOUNTS)
		.map(cleanAccount)
		.filter((a): a is UiLimitsAccount => !!a);
	const checkedAt = num(raw.checkedAt);
	return checkedAt !== undefined ? { accounts, checkedAt } : { accounts };
}

export function readLimitsFile(file: string): LimitsReadingsView | undefined {
	try {
		return sanitizeLimits(JSON.parse(readFileSync(file, "utf8")));
	} catch {
		return undefined;
	}
}

/** The channel pi-multi-pass uses (created here when no chat has loaded it yet). undefined = a channel of
 *  another version is there: leave it alone and show the file only. */
export function joinLimitsChannel(g: Record<symbol, unknown> = globalThis as unknown as Record<symbol, unknown>) {
	const existing = g[LIMITS_CHANNEL_KEY];
	if (existing !== undefined) {
		if (!isObj(existing)) return undefined;
		const c = existing as unknown as Partial<LimitsChannelV1>;
		return c.v === 1 && c.listeners instanceof Set ? (c as LimitsChannelV1) : undefined;
	}
	const channel: LimitsChannelV1 = { v: 1, listeners: new Set() };
	g[LIMITS_CHANNEL_KEY] = channel;
	return channel;
}

export const NO_CHECKER = "No chat has loaded pi-multi-pass yet: open a chat, then refresh.";

export interface SubsLimitsHubOptions {
	file: string;
	/** Send to every open window. */
	broadcast: (msg: ServerMessage) => void;
	/** Where the channel lives (tests pass their own). */
	global?: Record<symbol, unknown>;
	/** How often the file is looked at for writes from other processes (ms); 0 = not watched. */
	pollMs?: number;
}

/** subs-limits-box: keeps every window's Limits box current. */
export class SubsLimitsHub {
	private readonly file: string;
	private readonly broadcast: (msg: ServerMessage) => void;
	private readonly g: Record<symbol, unknown>;
	private readonly pollMs: number;
	private channel: LimitsChannelV1 | undefined;
	private checking = false;
	private lastSent = "";
	private started = false;
	private readonly onEvent = (event: LimitsEvent): void => {
		if (typeof event?.checking === "boolean") this.checking = event.checking;
		const view = event && "readings" in event ? sanitizeLimits(event.readings) : undefined;
		this.push(view);
	};
	private readonly onFile = (): void => this.push();

	constructor(opts: SubsLimitsHubOptions) {
		this.file = opts.file;
		this.broadcast = opts.broadcast;
		this.g = opts.global ?? (globalThis as unknown as Record<symbol, unknown>);
		this.pollMs = opts.pollMs ?? 5000;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.channel = joinLimitsChannel(this.g);
		this.channel?.listeners.add(this.onEvent);
		if (this.pollMs > 0) watchFile(this.file, { interval: this.pollMs, persistent: false }, this.onFile);
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.channel?.listeners.delete(this.onEvent);
		if (this.pollMs > 0) unwatchFile(this.file, this.onFile);
	}

	/** The api pi-multi-pass put on the channel, if a chat has loaded it (the channel can be replaced). */
	private api(): LimitsApiV1 | undefined {
		const current = joinLimitsChannel(this.g);
		if (current && current !== this.channel) {
			this.channel?.listeners.delete(this.onEvent);
			this.channel = current;
			if (this.started) current.listeners.add(this.onEvent);
		}
		const api = current?.api;
		return api && typeof api.check === "function" ? api : undefined;
	}

	private isChecking(): boolean {
		const api = this.api();
		if (api && typeof api.checking === "function") {
			try {
				return api.checking() === true;
			} catch {
				/* fall back to the last event */
			}
		}
		return this.checking;
	}

	/** The message a window gets: the file (or the readings just announced), whether a check runs. */
	message(view: LimitsReadingsView | undefined = readLimitsFile(this.file), error?: string): SubsLimitsMessage {
		return {
			type: "subs_limits",
			accounts: view?.accounts ?? [],
			...(view?.checkedAt !== undefined ? { checkedAt: view.checkedAt } : {}),
			checking: this.isChecking(),
			...(error ? { error } : {}),
		};
	}

	/** Send every window the current readings, unless they're what it got last. */
	push(view?: LimitsReadingsView): void {
		try {
			const msg = this.message(view ?? readLimitsFile(this.file));
			const payload = JSON.stringify(msg);
			if (payload === this.lastSent) return;
			this.lastSent = payload;
			this.broadcast(msg);
		} catch {
			/* a bad file never stops the server */
		}
	}

	/** The refresh button: check every account (joins a check already running). Resolves with the
	 *  reason it couldn't start or failed (for the window that pressed it), or undefined. */
	async refresh(): Promise<string | undefined> {
		const api = this.api();
		if (!api) return NO_CHECKER;
		let running: Promise<unknown>;
		try {
			running = Promise.resolve(api.check());
		} catch (err) {
			return `The check couldn't start: ${(err as Error)?.message ?? String(err)}`;
		}
		this.checking = true;
		this.push();
		try {
			await running;
			return undefined;
		} catch (err) {
			return `The check failed: ${(err as Error)?.message ?? String(err)}`;
		} finally {
			this.checking = false;
			this.push();
		}
	}
}
