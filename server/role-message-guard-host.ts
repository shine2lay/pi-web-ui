// ---------------------------------------------------------------------------
// role-message-guard-host.ts — role-message-ladder (#122): the native host for the approval ladder
// ---------------------------------------------------------------------------
// Wires the inert parts into live role messages:
//   C role-message-guard-contract.ts (types), E role-message-guard-core.ts + role-message-guard-store.ts (the one
//   admission authority and its journal), A role-message-guard-approvals.ts (request / decide / Owner question).
// This file supplies the real host ports E and A need: who is sending (the server's chat binding, never the
// model's words), where the chat stands in its message chain (RoleMessages.causalityOf), who approves (the COO's
// current home chat; the owner at hop 12+ or when the COO asks for itself), the native first-answer record for
// approver and Owner answers (decisions.jsonl), the Owner question (browser dialog + authorised Telegram), the
// transport (RoleMessages.admit) and one in-process lease over every guard write.
//
// Policy (owner, 2026-10-12, PLAN-v3-SPLIT.md): hops 1–6 as before; 7–11 need a finite COO grant; 12+ a finite
// Owner grant (12–16 at most). No urgent exemption of any kind in this delivery (#125/#130). The 20 accepted per
// role per rolling hour is unchanged, approval controls included. When the guard can't start or recover, sends fall
// back to the native depth-6 rule (RoleMessages.send), the same as a rollback to the previous build.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { Ask, AskFieldAnswer, AskHub } from "./asks.js";
import type { UiRoleGuardQuestion } from "./protocol.js";
import { samePath, type IdentityDef } from "./identities.js";
import { createGuardApprovalAdapters } from "./role-message-guard-approvals.js";
import type {
	GuardActor,
	GuardApprovalBinding,
	GuardApprovalContext,
	GuardApproverSelection,
	GuardAuthority,
	GuardBusinessKind,
	GuardConsumerBinding,
	GuardGrant,
	GuardHolds,
	GuardHostVerified,
	GuardHostVerifier,
	GuardInvocationReference,
	GuardKnownCausality,
	GuardLegacyAcceptedMessage,
	GuardOperationIdentity,
	GuardOutboxEntry,
	GuardOwnerQuestion,
	GuardPolicyV1,
	GuardProofReference,
	GuardRequest,
	GuardResult,
	GuardRetention,
	GuardScope,
	GuardStoreState,
	GuardTime,
	GuardTransportResult,
	GuardVerification,
	GuardVerifiedDecision,
	GuardVerifiedSnapshot,
} from "./role-message-guard-contract.js";
import { guardCommandFingerprint, RoleMessageGuardCore, type GuardMessageIntent } from "./role-message-guard-core.js";
import { guardDigest, GuardFileStore, guardJournalRefusal } from "./role-message-guard-store.js";
import {
	ROLE_MESSAGES_PER_HOUR,
	type RoleMessageDraft,
	type RoleMessageGuardTag,
	type RoleMessageRecord,
	type RoleMessages,
	type RoleMessageSender,
	type RoleMessageSendInput,
	type RoleMessageSendResult,
} from "./role-messages.js";

// ---------------------------------------------------------------------------
// Frozen pins and the selected numbers
// ---------------------------------------------------------------------------

const VERSION = "role-message-guard/v1" as const;

/** The frozen consumer binding A and E both check (contract 04fe491, PLAN-v3-SPLIT.md). */
export const GUARD_CONSUMER_BINDING: GuardConsumerBinding = {
	version: VERSION,
	contractCommit: "04fe491fb3afc3b42462ad782b2099c7971c7008",
	contractSha256: "79a5a1e1a704ecfbb36a70fc1b210ee6e27575013843122cf202a84592b4c7af",
	policyDocumentSha256: "5d8433fd0a8f9a82103009e43491182caf14b80ad2a20b874709c5b3762724a9",
	blockers: [],
};

/** Exactly E's frozen policy (core policyV1); E refuses anything else. */
export const GUARD_POLICY: GuardPolicyV1 = {
	version: VERSION,
	depth: { unapprovedThrough: 6, lowerThrough: 11, ownerFrom: 12 },
	grant: { maximumBusinessSends: 5, lifetimeMs: 3600000 },
	ordinary: { acceptedPerOrigin: 20, rollingWindowMs: 3600000 },
	request: {
		outstandingPerRequester: 20,
		lifetimeMs: 86400000,
		openPerRootTierScopeGeneration: 1,
		initialNotifications: 1,
		decisionNotifications: 1,
		explicitUpwardEscalations: 1,
	},
	protected: {
		bypass: "depth_only",
		consumesOrdinaryHourly: true,
		assignedDestinations: 1,
		initialPerEpisode: 1,
		terminalPerEpisode: 1,
		newIncidentsPerOriginHour: 2,
		deliveriesPerOriginHour: 4,
		deliveriesPerDestinationHour: 4,
		deliveriesPerSystemHour: 12,
		liveIncidents: 12,
		lifetimeMs: 86400000,
		maximumRenderedBytes: 2048,
	},
	rollback: { depthThrough: 6, acceptedPerOrigin: 20, preserveAccepted: true },
};

/** Storage caps proposed to Ops (rm-1fe61704, measured live volume: ≤365 messages a day, ≤20 per role-hour) and
 *  approved with changes (rm-efd6df89): requests and grants count only open requests and live grants, 600 each.
 *  Ops rm-fc4b9788 (option C): a store over half on the measured worst case gets a higher cap. The worst real 5 hours
 *  twice plus 100 runaway sends peak at 1188 transactions and as many audit receipts, so those caps are 3000 (40%). */
export const GUARD_RETENTION: GuardRetention = {
	maximumRequests: 600,
	maximumGrants: 600,
	maximumTransactions: 3000,
	maximumAuditReceipts: 3000,
	maximumOutboxEntries: 2000,
	maximumUsageEvents: 600,
	maximumTombstones: 6000,
	maximumContextBytes: 16384,
	// Ops rm-fc4b9788 (option C): settled transactions, audit receipts and delivery entries leave 5 h after they
	// settle, and each tombstone (E's replay memory) 5 h after it is made, whatever is still open elsewhere.
	settledRetentionMs: 5 * 60 * 60 * 1000,
	sourceReplayHorizonMs: 5 * 60 * 60 * 1000,
};
/** Each guard file at most this many bytes (E fails closed past it). */
export const GUARD_FILE_MAX_BYTES = 16 * 1024 * 1024;
/** Approval history (Ops rm-efd6df89): metadata only, kept 30 days, at most 16 MiB plus one archive; never blocks. */
export const GUARD_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const GUARD_HISTORY_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** One log warning per store once it is this full; armed again once it falls below GUARD_WARN_REARM. */
export const GUARD_WARN_AT = 0.8;
export const GUARD_WARN_REARM = 0.7;
const OPEN_REQUEST_STATES: readonly string[] = [
	"context_needed",
	"awaiting_approver",
	"awaiting_owner",
	"rate_limited",
	"held",
];
/** Start a fresh generation once the accepted-message copy passes this (only when nothing is open). */
export const GUARD_ROTATE_BYTES = 1024 * 1024;
export const GUARD_ROTATE_MESSAGES = 300;
export const GUARD_ROTATE_TOMBSTONES = 3000;
/** Ops #241 (docs/role-message-fresh-start.md): the operator's one-shot request for a fresh start, in the guard dir. */
export const GUARD_FRESH_START_FILE = "fresh-start.json";
/** The request is acted on only when both files of its generation have been untouched this long. */
export const GUARD_FRESH_START_QUIET_MS = 2 * 60 * 60 * 1000;
/** A request is good for at most this long after it was made. */
export const GUARD_FRESH_START_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Ops #248 (Security N1): a request is a few hundred bytes; a bigger file is refused unread. */
export const GUARD_FRESH_START_MAX_BYTES = 4096;
/** The off switch: this environment variable set to "off" keeps the ladder off (native 6-message rule). */
export const GUARD_APPROVALS_SWITCH = "PI_WEB_UI_MESSAGE_APPROVALS";

const NO_HOLDS: GuardHolds = {
	ownerPaused: false,
	roleDeliveryPaused: false,
	wakesDisabled: false,
	accessDenied: false,
	scopeDenied: false,
	spendingOrConsentDenied: false,
	queueOrSessionMismatch: false,
	sourcePermissionRevoked: false,
};
const HOUR_MS = 3600000;
const CHOICES = ["deny", "one_send", "requested_quantity"] as const;
type Choice = (typeof CHOICES)[number];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function verified<T>(value: T): GuardVerification<T> {
	return { state: "verified", value: value as GuardHostVerified<T> };
}
function refused<T>(state: "unavailable" | "invalid" | "unknown", reason: string): GuardVerification<T> {
	return { state, reason };
}
const short = (v: unknown) => guardDigest(v).slice(0, 16);
function same(a: unknown, b: unknown): boolean {
	return guardDigest(a) === guardDigest(b);
}
function rootOf(c: GuardKnownCausality): string {
	return c.kind === "rooted" ? c.rootId : c.anchorId;
}
function parentOf(c: GuardKnownCausality): string | undefined {
	return c.incomingRecordId ?? undefined;
}
/** Which grant (if any) a business send uses. Pure, so the stage tests can pin it.
 *  - A grant belongs to one chain line: same root, and the record it was asked from is an ancestor of
 *    this send (branches after that point share its five sends; a branch from before it can't use it).
 *  - Below hop 7 nothing is used unless the caller names a grant.
 *  - A relevant grant that is spent, expired, denied or revoked is still handed to E, so the sender hears
 *    the exact reason instead of a fresh "approval needed".
 *  - A relevant grant whose scope doesn't cover this sender, recipient, task or hop is a mismatch, and
 *    nothing is charged. */
export function chooseGrant(input: {
	grants: readonly GuardGrant[];
	causal: GuardKnownCausality;
	actor: GuardActor;
	to: string;
	now: number;
	wanted: string | null;
	ancestorAt: (recordId: string, hop: number) => string | undefined;
}): { kind: "none" } | { kind: "use"; grant: GuardGrant } | { kind: "mismatch"; grant: GuardGrant; why: string } {
	const { causal, actor, to, now, wanted } = input;
	const hop = causal.nextHop;
	const onLine = (g: GuardGrant) => {
		if (rootOf(g.binding.causal) !== rootOf(causal)) return false;
		const anchor = parentOf(g.binding.causal);
		const mine = parentOf(causal);
		if (!anchor) return true; // asked at the root: the whole root is the line
		return !!mine && input.ancestorAt(mine, g.binding.causal.nextHop - 1) === anchor;
	};
	const live = (g: GuardGrant) => g.state === "approved" && now < g.expiresAt && g.acceptedUses < g.maximumUses;
	let pick: GuardGrant | undefined;
	if (wanted) {
		pick = input.grants.find((g) => g.id === wanted);
		if (!pick) return { kind: "none" };
		if (!onLine(pick)) return { kind: "mismatch", grant: pick, why: "it belongs to another chain" };
	} else {
		if (hop <= GUARD_POLICY.depth.unapprovedThrough) return { kind: "none" };
		const mine = input.grants.filter(onLine);
		if (!mine.length) return { kind: "none" };
		const inRange = (g: GuardGrant) => hop >= g.binding.causal.nextHop && hop <= g.binding.upperHop;
		const usable = mine
			.filter((g) => live(g) && inRange(g))
			.sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id));
		// Several live grants on one line: use the first whose scope fits this send.
		pick =
			usable.find((g) => !misfit(g, actor, to)) ??
			usable[0] ??
			[...mine].filter(inRange).sort((a, b) => b.expiresAt - a.expiresAt || a.id.localeCompare(b.id))[0];
		if (!pick) return { kind: "none" }; // nothing covers this hop: E asks for the right tier's approval
	}
	// Past the grant's last message: it is simply done; E asks for the next tier's approval.
	if (hop > pick.binding.upperHop) return { kind: "none" };
	if (hop < pick.binding.causal.nextHop)
		return {
			kind: "mismatch",
			grant: pick,
			why: `it covers messages ${pick.binding.causal.nextHop} to ${pick.binding.upperHop}, this is message ${hop}`,
		};
	const why = misfit(pick, actor, to);
	return why ? { kind: "mismatch", grant: pick, why } : { kind: "use", grant: pick };
}
function misfit(g: GuardGrant, actor: GuardActor, to: string): string | null {
	if (!g.binding.scope.participants.includes(actor.role)) return `${actor.role} isn't named in it`;
	if (!g.binding.scope.recipients.includes(to)) return `${to} isn't a recipient in it`;
	if (!same(g.binding.scope.task, actor.task)) return "it was given for another task";
	return null;
}
function quantityOf(n: number): 1 | 2 | 3 | 4 | 5 {
	return Math.max(1, Math.min(5, Math.floor(n))) as 1 | 2 | 3 | 4 | 5;
}
function writeDurable(path: string, text: string): void {
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, text);
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
/** Ops #241: the operator's request (scripts/role-guard-fresh-start.mjs writes it). */
interface GuardFreshStartRequest {
	v: 1;
	gen: number;
	journalSha256: string;
	acceptedSha256: string;
	at: number;
	expiresAt: number;
	reason: string;
}
function parseFreshStartRequest(text: string): GuardFreshStartRequest | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const r = value as Record<string, unknown>;
	const hex = (x: unknown) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
	const whole = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1;
	const ok =
		r.v === 1 &&
		whole(r.gen) &&
		hex(r.journalSha256) &&
		hex(r.acceptedSha256) &&
		whole(r.at) &&
		whole(r.expiresAt) &&
		typeof r.reason === "string";
	return ok ? (r as unknown as GuardFreshStartRequest) : null;
}
/** Ops #248 (Security N1): the request's text, from one open that doesn't follow a link or wait on a pipe, checked
 *  on that open file (a plain file of this user, mode 0600, at most 4 KiB) and read from it, capped. null when there
 *  is none; otherwise why it isn't read. */
function readFreshStartFile(path: string): { text: string } | string | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		return code === "ELOOP" ? "the request is not a plain file" : "the request can't be read";
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) return "the request is not a plain file";
		if (typeof process.getuid === "function" && st.uid !== process.getuid())
			return "the request belongs to another user";
		if (st.mode & 0o022) return "other users can write the request";
		if ((st.mode & 0o777) !== 0o600) return `the request's mode is 0${(st.mode & 0o777).toString(8)}, not 0600`;
		if (st.size > GUARD_FRESH_START_MAX_BYTES) return "the request is over 4 KiB";
		const buf = Buffer.alloc(GUARD_FRESH_START_MAX_BYTES + 1);
		let n = 0;
		while (n < buf.length) {
			const got = readSync(fd, buf, n, buf.length - n, null);
			if (got === 0) break;
			n += got;
		}
		if (n > GUARD_FRESH_START_MAX_BYTES) return "the request is over 4 KiB";
		return { text: buf.subarray(0, n).toString("utf8") };
	} catch {
		return "the request can't be read";
	} finally {
		closeSync(fd);
	}
}
function sha256Of(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}
/** A byte-exact copy, flushed before it is renamed into place; 0600 like the store's own files. */
function writeDurableBytes(path: string, bytes: Buffer): void {
	const tmp = `${path}.tmp-${process.pid}`;
	rmSync(tmp, { force: true });
	writeFileSync(tmp, bytes, { mode: 0o600 });
	const fd = openSync(tmp, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}
/** The pid a lock file names, or null when it is missing, names none or isn't a plain file. Ops #257 (B3): one open
 *  that doesn't follow a link or wait on a pipe, checked on that open file, as readFreshStartFile() does. */
function readPid(path: string): number | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		const buf = Buffer.alloc(32);
		const n = Number.parseInt(buf.toString("utf8", 0, readSync(fd, buf, 0, buf.length, 0)), 10);
		return Number.isSafeInteger(n) ? n : null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}
/** Ops #257 (B3): why the guard's lock can't be taken as it is: it is there and isn't a plain file (a folder, a pipe,
 *  a link), looked at with lstat, never opened or followed. null when it is a plain file or isn't there. */
function lockNotFile(path: string): string | null {
	let st: ReturnType<typeof lstatSync> | undefined;
	try {
		st = lstatSync(path);
	} catch {
		return null; // not there: the link that takes it decides
	}
	if (!st || st.isFile()) return null;
	const kind = st.isSymbolicLink()
		? "a link"
		: st.isDirectory()
			? "a folder"
			: st.isFIFO()
				? "a pipe"
				: st.isSocket()
					? "a socket"
					: "a device";
	return `the guard's lock is ${kind}, not a plain file; it was left in place`;
}
function fsyncDir(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Re-entrant in-process lease: E's store, rotation, decision records and every admit run one at a time. */
export class GuardLease {
	private readonly held = new AsyncLocalStorage<true>();
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(work: () => Promise<T>): Promise<T> {
		if (this.held.getStore()) return work();
		const next = this.tail.then(() => this.held.run(true, work));
		this.tail = next.catch(() => undefined);
		return next;
	}
	/** Scheduling may outlive this owner: its timers/turns must acquire their own lease. */
	detach<T>(schedule: () => T): T {
		return this.held.exit(schedule);
	}
}

// ---------------------------------------------------------------------------
// Durable native records the ports read (first answer wins)
// ---------------------------------------------------------------------------

/** One approver or Owner answer as the server received it (never the model's or a plugin's claim alone). */
export interface GuardDecisionEvent {
	eventId: string;
	kind: "role" | "owner";
	/** guardDigest of the request binding it answers. */
	bindingDigest: string;
	choice: Choice | "escalate_owner";
	reason: string;
	answeredAt: number;
	/** role: the approver's chat (actor). */
	approver?: GuardActor;
	/** owner: the question and the channel. */
	questionId?: string;
	generation?: string;
	source?: "browser" | "telegram";
}

/** The Owner question shown for one Owner-tier request generation. */
export interface GuardQuestionRecord {
	questionId: string;
	generation: string;
	requestId: string;
	bindingDigest: string;
	choicesDigest: string;
	createdAt: number;
	state: "pending" | "answered";
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface RoleMessageGuardHostOptions {
	/** ~/.pi-web-ui/role-message-guard */
	dir: string;
	roleMessages: () => RoleMessages | null | undefined;
	identities: () => readonly IdentityDef[];
	askHub?: AskHub | null;
	/** The open Owner questions changed (index.ts pushes role_guard_questions to every page). */
	questionsChanged?: () => void;
	log: (line: string) => void;
	now?: () => number;
	/** Tests: smaller rotation thresholds. */
	rotateBytes?: number;
	/** Tests: a smaller history file before it rotates. */
	historyMaxBytes?: number;
	/** Tests: smaller storage caps (the live app uses GUARD_RETENTION). */
	retention?: GuardRetention;
}

/** One line of the approval history (history.jsonl): metadata only, never the context's words. */
export interface GuardHistoryLine {
	at: number;
	event: "request" | "escalation" | "decision" | "grant" | "grant_use" | "grant_end" | "revoked_all";
	requestId?: string;
	generation?: string;
	requester?: string;
	tier?: string;
	state?: string;
	quantity?: number;
	fromHop?: number;
	upperHop?: number;
	grantId?: string;
	uses?: number;
	maximumUses?: number;
	expiresAt?: number;
}

/** Per-call context for E's materialize (who the native record is from, and its chain ids). */
interface CallContext {
	sender?: RoleMessageSender;
	draft?: RoleMessageDraft;
	causal?: GuardKnownCausality;
	guard?: RoleMessageGuardTag;
}

/** The agent's approval action (message_role approval). */
export interface RoleMessageApprovalInput {
	action?: unknown;
	requestId?: unknown;
	generation?: unknown;
	choice?: unknown;
	reason?: unknown;
	recipients?: unknown;
	participants?: unknown;
	quantity?: unknown;
	scopeId?: unknown;
	operation?: unknown;
	context?: unknown;
}

export type RoleMessageGuardSendResult =
	| RoleMessageSendResult
	| {
			ok: false;
			error: string;
			approvalRequired: { hop: number; tier: "lower" | "owner"; approver: string };
			reason?: string;
	  }
	/** reason: E's blocked reason (or the host's own check), for logs and the acceptance binding; the model reads `error`. */
	| { ok: false; error: string; reason: string };

export class RoleMessageGuardHost {
	private readonly lease = new GuardLease();
	private readonly ctx = new AsyncLocalStorage<CallContext>();
	private readonly now: () => number;
	private lastObserved = 0;
	private store: GuardFileStore | null = null;
	private storeDir = "";
	private core: RoleMessageGuardCore | null = null;
	private adapters: ReturnType<typeof createGuardApprovalAdapters> | null = null;
	private status_: "starting" | "ready" | "degraded" = "starting";
	private degradedReason = "";
	/** Ops #253 (Security O2): the rotation failures logged so far (each reason once while the server runs). */
	private readonly rotationFailures = new Set<string>();
	/** invocationId -> the server-bound actor of a live tool call (or a host notice to the requester). */
	private readonly invocations = new Map<string, { ref: GuardInvocationReference; actor: GuardActor }>();
	/** sessionFile -> the chat's last user text at its current tool call (where it stands in its chain). */
	private readonly lastUser = new Map<string, string>();
	/** role|revision -> when its home was first observed (deterministic selection proof). */
	private readonly homeSeen = new Map<string, number>();
	private decisions: GuardDecisionEvent[] = [];
	private questions: GuardQuestionRecord[] = [];
	private lockPath = "";
	/** Ops #257 (B1): the lock file this server linked (its device and inode), null while it holds none. */
	private lockHeld: { dev: number; ino: number } | null = null;
	/** history.jsonl: what each request and grant looked like at the last check (null until seeded at start). */
	private historySeen: Map<string, string> | null = null;
	/** Stores already warned about (80% full); cleared once below 70%. */
	private readonly warned = new Set<string>();

	constructor(private readonly o: RoleMessageGuardHostOptions) {
		this.now = o.now ?? Date.now;
	}

	private get retention(): GuardRetention {
		return this.o.retention ?? GUARD_RETENTION;
	}

	get state(): { status: "starting" | "ready" | "degraded"; reason: string } {
		return { status: this.status_, reason: this.degradedReason };
	}

	// -------------------------------------------------------------------------
	// Startup, rotation, rollback detection, stop
	// -------------------------------------------------------------------------

	async start(): Promise<void> {
		// Ops #241: the off switch comes first, before the lock or any guard file: nothing is read or written.
		const switched = process.env[GUARD_APPROVALS_SWITCH]?.trim().toLowerCase();
		if (switched === "off") return this.degrade(`turned off (${GUARD_APPROVALS_SWITCH}=off)`);
		if (switched && switched !== "on")
			this.o.log(
				`approval ladder: ${GUARD_APPROVALS_SWITCH}=${JSON.stringify(switched.slice(0, 40))} is not understood (only "off" turns approvals off); they stay on`,
			);
		try {
			mkdirSync(this.o.dir, { recursive: true });
			this.lockPath = join(this.o.dir, "lock");
			// Ops #257 (B3): anything but a plain file at `lock` turns the start off and stays as it is.
			const notFile = lockNotFile(this.lockPath);
			if (notFile) return this.degrade(notFile);
			const other = this.readLock();
			if (other && other !== process.pid && pidAlive(other))
				return this.degrade(`another server (pid ${other}) holds the guard`);
			// Ops #248 (Security N3): a current.json that isn't understood turns the ladder off here, before the lock
			// or any guard file is written: guessing a generation could clean away the live one.
			const gen = this.currentGeneration();
			if (typeof gen === "string") return this.degrade(`current.json ${gen}`);
			const held = this.takeLock();
			if (held) return this.degrade(held);
			this.sweepLockLeftovers();
			this.decisions = this.readJsonl<GuardDecisionEvent>(join(this.o.dir, "decisions.jsonl"));
			this.questions = this.readJson<GuardQuestionRecord[]>(join(this.o.dir, "questions.json")) ?? [];
			await this.exclusive(async () => {
				this.cleanGenerations(gen);
				let dir = join(this.o.dir, `gen-${gen}`);
				// Ops #253 (Architecture A1): a first start names its generation before it makes it. A crash before the store
				// is ready then leaves current.json naming gen-<gen>, made or not, which the next start opens as usual; never
				// a gen folder without current.json, which N3 turns off.
				if (!this.hasGeneration()) this.writeCurrent(gen);
				mkdirSync(dir, { recursive: true });
				let store = this.newStore(dir);
				if (!existsSync(join(dir, "journal.json"))) {
					const r = await store.initialize(this.freshState(), { v: 1, paused: false, messages: [] });
					if (r.state !== "ready") throw new Error(`bootstrap: ${r.reason}`);
					this.writeCurrent(gen);
					this.o.log(`approval ladder: new guard store (generation ${gen})`);
					this.settleFreshStartRequest(gen);
				} else {
					const r = await store.recover();
					if (r.state === "ready") this.settleFreshStartRequest(gen);
					else {
						// Ops #241: only the operator's request for exactly these files starts a new generation.
						const fresh = await this.freshStart(gen);
						if (!fresh) throw new Error(`recover: ${r.reason}`);
						({ store, dir } = fresh);
					}
				}
				this.useStore(store, dir);
			});
			const rolledBack = await this.previousReaderRan();
			if (rolledBack) {
				this.o.log(`approval ladder: ${rolledBack}; open requests and grants revoked (fresh generation)`);
				await this.rotate(true);
			}
			this.status_ = "ready";
			await this.reconcileOutbox();
			await this.representQuestions();
			await this.maybeRotate();
			if (this.state.status !== "ready") return; // Ops #253 (O2): the rotation turned approvals off (logged)
			this.tidyHistory();
			await this.afterChange();
			const lost = this.lockLost(); // Ops #257 (B1): still this server's lock before it says "on"
			if (lost) return this.degrade(lost);
			this.o.log("approval ladder: on (hops 1-6 free; 7-11 COO grant; 12+ owner grant)");
		} catch (err) {
			this.degrade((err as Error).message);
		}
	}

	stop(): void {
		if (!this.lockHeld) return; // never held it (off, another server's, or start() not called)
		try {
			// Ops #257 (B1): only the file this server linked, never a lock another server took since.
			if (!this.lockLost()) rmSync(this.lockPath, { force: true });
		} catch {
			/* best effort */
		}
		this.lockHeld = null;
	}

	/** Ops #257 (B1): the lease, entered only while `lock` is still the file this server linked. Every guard write
	 *  runs under the lease, so once another server holds the lock, approvals turn off here and the work doesn't run. */
	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		return this.lease.run(async () => {
			const lost = this.lockLost();
			if (lost) {
				if (this.status_ === "ready") this.degrade(lost);
				throw new Error(lost);
			}
			return work();
		});
	}

	private degrade(reason: string): void {
		this.status_ = "degraded";
		this.degradedReason = reason;
		this.core = null;
		this.adapters = null;
		this.o.log(`approval ladder UNAVAILABLE (${reason}): sends use the native depth-6 rule; no approvals`);
	}

	// Ops #241 (docs/role-message-fresh-start.md): the operator's one-shot fresh start of an unreadable record.

	/** recover() failed on generation `gen`. With the operator's request for exactly these files, keep a byte-identical
	 *  copy in archive-gen-<gen> and begin the next generation with beginGeneration(), as rotate() does (gen-<gen>
	 *  stays in place too); open approvals of the old record end. No request, or one that doesn't match: null, and
	 *  nothing is written. Runs under the lease. A crash before current.json switches leaves the request, and the next
	 *  start does it again. */
	private async freshStart(gen: number): Promise<{ store: GuardFileStore; dir: string } | null> {
		const request = this.freshStartRequest(gen);
		if (request === null) return null;
		if (typeof request === "string") {
			this.o.log(`approval ladder: fresh start refused (${request})`);
			return null;
		}
		const from = join(this.o.dir, `gen-${gen}`);
		const archive = join(this.o.dir, `archive-gen-${gen}`);
		mkdirSync(archive, { recursive: true });
		for (const [name, digest] of [
			["journal.json", request.journalSha256],
			["accepted.json", request.acceptedSha256],
		] as const) {
			const bytes = readFileSync(join(from, name));
			if (sha256Of(bytes) !== digest) throw new Error(`fresh start: ${name} changed while it was copied`);
			writeDurableBytes(join(archive, name), bytes);
			if (sha256Of(readFileSync(join(archive, name))) !== digest)
				throw new Error(`fresh start: the archive copy of ${name} differs`);
		}
		fsyncDir(archive);
		const begun = await this.beginGeneration(gen + 1, "fresh start"); // start() adopts it
		this.writeHistory([{ at: this.now(), event: "revoked_all" }]);
		this.markFreshStartDone();
		this.o.log(`approval ladder: fresh start from generation ${gen} (old record kept in archive-gen-${gen})`);
		return begun;
	}

	/** The request for generation `gen`: null when there is none, why it can't be acted on, or the request when it is
	 *  bound to exactly these files, both untouched for 2 h, still good, and the journal committed and readable. */
	private freshStartRequest(gen: number): GuardFreshStartRequest | string | null {
		const read = readFreshStartFile(join(this.o.dir, GUARD_FRESH_START_FILE));
		if (read === null || typeof read === "string") return read;
		const request = parseFreshStartRequest(read.text);
		if (!request) return "the request's format is not understood";
		if (request.gen !== gen) return `the request is for generation ${request.gen}, the current one is ${gen}`;
		const now = this.now();
		if (request.at > now) return "the request is dated in the future";
		if (request.expiresAt - request.at > GUARD_FRESH_START_LIFETIME_MS) return "the request is good for over 24 h";
		if (now >= request.expiresAt) return `the request expired at ${new Date(request.expiresAt).toISOString()}`;
		let journalText = "";
		for (const [name, digest] of [
			["journal.json", request.journalSha256],
			["accepted.json", request.acceptedSha256],
		] as const) {
			const file = join(this.o.dir, `gen-${gen}`, name);
			try {
				if (now - statSync(file).mtimeMs < GUARD_FRESH_START_QUIET_MS) return `${name} changed less than 2 h ago`;
				const bytes = readFileSync(file);
				if (sha256Of(bytes) !== digest) return `${name} is not the file the request was made for (sha256 differs)`;
				if (name === "journal.json") journalText = bytes.toString("utf8");
			} catch {
				return `${name} can't be read`;
			}
		}
		// Ops #248 (Architecture S1): only a committed journal that decodes is started over. One holding a prepared send,
		// or one that can't be parsed, stays as it is (never cleaned or overwritten) and the ladder stays off with why.
		return guardJournalRefusal(journalText) ?? request;
	}

	/** The record opened as usual, so a request is never acted on. One for an older generation is a fresh start that
	 *  finished before its request was marked done: mark it done now. Any other stays where it is, ignored. */
	private settleFreshStartRequest(gen: number): void {
		const read = readFreshStartFile(join(this.o.dir, GUARD_FRESH_START_FILE)); // Ops #248 (N1): same reader
		if (read === null) return;
		const request = typeof read === "string" ? null : parseFreshStartRequest(read.text);
		if (request && request.gen < gen) {
			this.markFreshStartDone();
			this.o.log(
				`approval ladder: fresh start request for generation ${request.gen} marked done (already on generation ${gen})`,
			);
		} else
			this.o.log(
				`approval ladder: fresh start request ignored (${typeof read === "string" ? `${read}; ` : ""}generation ${gen} opened as usual)`,
			);
	}

	private markFreshStartDone(): void {
		try {
			renameSync(join(this.o.dir, GUARD_FRESH_START_FILE), join(this.o.dir, `fresh-start.done-${this.now()}.json`));
		} catch (err) {
			this.o.log(`approval ladder: fresh start request not marked done (${(err as Error).message})`);
		}
	}

	private readLock(): number | null {
		return readPid(this.lockPath);
	}
	/** Ops #257 (B1): why `lock` is no longer the file this server linked (same device and inode), or null while it is. */
	private lockLost(): string | null {
		const held = this.lockHeld;
		if (!held) return "this server holds no lock on the guard";
		let st: ReturnType<typeof lstatSync> | undefined;
		try {
			st = lstatSync(this.lockPath);
		} catch {
			return "the guard's lock is gone";
		}
		if (st && st.dev === held.dev && st.ino === held.ino) return null;
		return `another server (pid ${(st?.isFile() ? this.readLock() : null) ?? "unknown"}) took the guard's lock`;
	}
	/** Ops #253 (Architecture A4): take the lock in one step that fails when it is there, so two servers starting at
	 *  once can't both hold it. The pid is written and flushed to a file of this process's own, then linked to `lock`: a
	 *  link fails when `lock` exists, as openSync "wx" does, and the lock is never seen empty. A lock that is there: a
	 *  live other server's turns the ladder off, as before. A gone server's (dead pid), an unreadable one or this
	 *  process's own is moved aside, and the take is tried once more; a second failure turns the ladder off. The rename
	 *  takes whatever `lock` is by then, which can be a live server's lock made after the look (Ops #257, B1): its pid is
	 *  read again, and a live server's lock is given back. When a third server linked its own in that moment, the give
	 *  back fails and the moved lock is removed; the server it was taken from then finds `lock` isn't its file at its
	 *  next check (lockLost()) and turns off. Returns why it can't, or null once held (the linked file's inode kept in
	 *  lockHeld). Leaves no file of its own behind either way. */
	private takeLock(): string | null {
		const mine = `${this.lockPath}.tmp-${process.pid}`;
		const aside = `${this.lockPath}.stale-${process.pid}`;
		try {
			rmSync(mine, { force: true });
			// Ops #257 (Security N1): made new ("wx"), so a link put here since the line above is never written through and
			// the file always gets mode 0600; anything there turns the start off.
			writeFileSync(mine, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
			const fd = openSync(mine, "r");
			let made: { dev: number; ino: number };
			try {
				fsyncSync(fd);
				const st = fstatSync(fd);
				made = { dev: st.dev, ino: st.ino };
			} finally {
				closeSync(fd);
			}
			if (this.linkLock(mine, made)) return null;
			// Ops #257 (B3): looked at again here, as one can appear after the start's first look; never moved.
			const notFile = lockNotFile(this.lockPath);
			if (notFile) return notFile;
			const other = this.readLock();
			if (other && other !== process.pid && pidAlive(other)) return `another server (pid ${other}) holds the guard`;
			let moved = false;
			try {
				renameSync(this.lockPath, aside);
				moved = true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // ENOENT: gone already
			}
			const was = moved ? readPid(aside) : null;
			if (was && was !== process.pid && pidAlive(was)) {
				// A live server took the lock between the look above and the move: give it back.
				try {
					linkSync(aside, this.lockPath);
				} catch {
					/* yet another server holds it now */
				}
				return `another server (pid ${was}) holds the guard`;
			}
			if (this.linkLock(mine, made)) return null;
			return `another server (pid ${this.readLock() ?? "unknown"}) took the guard as this one started`;
		} finally {
			// Ops #257 (B3): best effort, so a removal that fails can't hide the outcome above.
			for (const left of [mine, aside]) {
				try {
					rmSync(left, { force: true });
				} catch {
					/* left behind */
				}
			}
		}
	}
	/** Ops #257 (Architecture B5): once this server holds the lock, remove the lock.tmp-<pid> and lock.stale-<pid> files
	 *  of servers that are gone (a crash inside takeLock() leaves them). A live server's (one taking the lock right now)
	 *  and anything but a plain file stay. Best effort: a file that can't be removed stays; logs what went. */
	private sweepLockLeftovers(): void {
		const removed: string[] = [];
		try {
			for (const name of readdirSync(this.o.dir)) {
				const m = /^lock\.(?:tmp|stale)-(\d+)$/.exec(name);
				if (!m) continue;
				const pid = Number(m[1]);
				if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) continue;
				const path = join(this.o.dir, name);
				try {
					if (!lstatSync(path).isFile()) continue;
					rmSync(path);
					removed.push(name);
				} catch {
					/* left behind */
				}
			}
		} catch {
			/* the folder can't be listed: nothing removed */
		}
		if (removed.length)
			this.o.log(`approval ladder: removed ${removed.sort().join(", ")} (left by a server that is gone)`);
	}
	/** Link this process's flushed lock file to `lock`: true once held (the folder flushed, the file's inode kept),
	 *  false when one is there. */
	private linkLock(mine: string, made: { dev: number; ino: number }): boolean {
		try {
			linkSync(mine, this.lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
			throw err;
		}
		this.lockHeld = made;
		fsyncDir(this.o.dir);
		return true;
	}
	private readJson<T>(path: string): T | null {
		try {
			return JSON.parse(readFileSync(path, "utf8")) as T;
		} catch {
			return null;
		}
	}
	private readJsonl<T>(path: string): T[] {
		try {
			return readFileSync(path, "utf8")
				.split("\n")
				.filter((l) => l.trim())
				.flatMap((l) => {
					try {
						return [JSON.parse(l) as T];
					} catch {
						return [];
					}
				});
		} catch {
			return [];
		}
	}
	/** The generation current.json names; a first start (no gen-N or archive-gen-N folder yet) begins generation 1.
	 *  Ops #248 (Security N3): once a generation exists, a current.json that is missing, unreadable, not understood or
	 *  names a folder that isn't there gives why instead, and the caller stops without writing anything. */
	private currentGeneration(): number | string {
		let gen: number | null = null;
		let why = "is not understood";
		try {
			const c = JSON.parse(readFileSync(join(this.o.dir, "current.json"), "utf8")) as { gen?: unknown } | null;
			if (typeof c?.gen === "number" && Number.isSafeInteger(c.gen) && c.gen >= 1) gen = c.gen;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") why = "is missing";
			else if (code) why = `can't be read (${code})`;
		}
		if (!this.hasGeneration()) return gen ?? 1;
		if (gen === null) return why;
		let there = false;
		try {
			there = lstatSync(join(this.o.dir, `gen-${gen}`)).isDirectory();
		} catch {
			there = false;
		}
		return there ? gen : `points at gen-${gen}, which doesn't exist`;
	}
	/** A gen-N or archive-gen-N folder exists: no longer a first start. */
	private hasGeneration(): boolean {
		return readdirSync(this.o.dir).some((n) => /^(archive-)?gen-\d+$/.test(n));
	}
	private writeCurrent(gen: number): void {
		writeDurable(join(this.o.dir, "current.json"), `${JSON.stringify({ gen })}\n`);
		fsyncDir(this.o.dir); // Ops #253 (Architecture A2): the rename itself reaches the disk, so a power loss can't undo it
	}
	/** Keep the current generation and the one before it (the one archive). */
	private cleanGenerations(current: number): void {
		for (const name of readdirSync(this.o.dir)) {
			const m = /^gen-(\d+)$/.exec(name);
			if (!m) continue;
			const n = Number(m[1]);
			if (n !== current && n !== current - 1) rmSync(join(this.o.dir, name), { recursive: true, force: true });
		}
	}
	private newStore(dir: string): GuardFileStore {
		return new GuardFileStore({
			journalPath: join(dir, "journal.json"),
			legacyPath: join(dir, "accepted.json"),
			maximumBytes: GUARD_FILE_MAX_BYTES,
			withExclusive: (work) => this.exclusive(work),
			boundary: null,
		});
	}
	private useStore(store: GuardFileStore, dir: string): void {
		this.store = store;
		this.storeDir = dir;
		this.core = new RoleMessageGuardCore({
			binding: GUARD_CONSUMER_BINDING,
			policy: GUARD_POLICY,
			retention: this.retention,
			store,
			verifier: this.verifier(),
			transport: {
				dispatch: (entry) => this.dispatch(entry),
				wake: async (entry) => this.confirmed(entry, entry.receipt.wakeKey),
				query: async (entry) => this.query(entry),
			},
			clock: async () => this.clock(),
			requestSnapshot: async (actor, request) => this.snapshotFor(actor, request.binding.causal, null),
			reverifyDecision: async (decision, request) => this.reverifyDecision(decision, request),
			verifyGrantLineage: async (grant, snapshot, scope, to) => this.verifyGrantLineage(grant, snapshot, scope, to),
			restoreSnapshot: async (entry) =>
				this.snapshotFor(entry.receipt.identity.actor, entry.receipt.causal, null, entry.receipt.messageId),
			verifyStatusActor: async (actor) =>
				this.actorCurrent(actor) ? verified(actor) : refused("unavailable", "not this role's current chat binding"),
			materialize: async (intent) => this.materialize(intent),
			maintenanceIdentity: (purpose, key) => {
				const identity = {
					operationId: `maintenance:${purpose}:${key}`,
					fingerprint: "",
					actor: HOST_ACTOR,
					version: VERSION,
				};
				return { ...identity, fingerprint: short({ purpose, key }) } as GuardOperationIdentity;
			},
			// A rollback to depth 6 is the previous build (pi-web-deploy rollback), never an in-place switch.
			authoriseRollback: async () => false,
		});
		this.adapters = createGuardApprovalAdapters({
			binding: GUARD_CONSUMER_BINDING,
			policy: GUARD_POLICY,
			maximumContextBytes: GUARD_RETENTION.maximumContextBytes,
			host: this.verifier(),
			core: this.core,
			native: {
				time: async () => this.clock(),
				control: async (actor, request, phase) => this.control(actor, request, phase),
				question: async (request, choicesDigest) => this.question(request, choicesDigest),
				ownerRequest: async (ref) => this.ownerRequest(ref),
				present: async (q, ask) => this.present(q, ask),
			},
		});
	}

	/** A new store's first state: the 20-per-hour count carries over from the native record of the last hour. */
	private freshState(): GuardStoreState {
		const now = this.now();
		const rm = this.o.roleMessages();
		const usage = (rm?.recent(now - HOUR_MS) ?? [])
			.filter((m) => m.kind !== "report" && m.at <= now)
			.map((m) => ({
				transactionId: `native-${m.id}`,
				committedAt: m.at,
				origin: m.from.role,
				destination: m.to.role,
				usage: {
					ordinaryOrigin: 1 as const,
					grantBusinessUse: 0 as const,
					protectedOrigin: 0 as const,
					protectedDestination: 0 as const,
					protectedSystem: 0 as const,
					newIncidentOrigin: 0 as const,
				},
			}));
		this.lastObserved = Math.max(this.lastObserved, now);
		return {
			version: VERSION,
			revision: "0",
			mode: "enabled",
			lastTrustedTime: now,
			requests: [],
			grants: [],
			incidents: [],
			usage,
			transactions: [],
			outbox: [],
			audits: [],
			tombstones: [],
			overflow: { count: 0, state: "none" },
		};
	}

	/** A previous reader (the build before the ladder) sent messages after the guard last wrote: its sends never
	 *  went through the guard, so every open grant and request is revoked (fresh generation). */
	private async previousReaderRan(): Promise<string | null> {
		const read = await this.store?.read();
		if (!read || read.state !== "ready") return null;
		const since = read.value.lastTrustedTime;
		if (!read.value.requests.length && !read.value.grants.length) return null;
		const rm = this.o.roleMessages();
		const foreign = (rm?.recent(since) ?? []).filter((m) => m.at > since && m.kind !== "report" && !m.root);
		return foreign.length ? `${foreign.length} role message(s) were sent without the ladder since it last wrote` : null;
	}

	/** Nothing open: no unsettled transaction, no undelivered message, no open request or live grant. */
	private quiescent(s: GuardStoreState, now: number): boolean {
		return (
			s.transactions.every((t) => t.state === "committed") &&
			s.outbox.every(
				(o) => o.state === "handled" || o.state === "failed" || (o.state === "dispatched" && o.message.kind === "fyi"),
			) &&
			s.requests.every(
				(r) =>
					!["context_needed", "awaiting_approver", "awaiting_owner", "rate_limited", "held"].includes(r.state) ||
					now >= r.expiresAt,
			) &&
			s.grants.every((g) => g.state !== "approved" || now >= g.expiresAt)
		);
	}

	/** Start a fresh generation when the accepted copy or the tombstones grow past their marks (only when quiescent).
	 *  Ops #253 (Security O2): never throws, so a send that was accepted always comes back to its chat as accepted
	 *  (afterAccepted() runs this after the send went). A rotation that fails goes to rotationFailed(). */
	private async maybeRotate(): Promise<void> {
		if (this.status_ !== "ready" || !this.storeDir) return;
		try {
			let bytes = 0;
			try {
				bytes = statSync(join(this.storeDir, "accepted.json")).size;
			} catch {
				bytes = 0;
			}
			const read = await this.store?.read();
			if (!read || read.state !== "ready") return;
			const legacy = this.readJson<{ messages?: unknown[] }>(join(this.storeDir, "accepted.json"));
			const big =
				bytes > (this.o.rotateBytes ?? GUARD_ROTATE_BYTES) ||
				(legacy?.messages?.length ?? 0) > GUARD_ROTATE_MESSAGES ||
				read.value.tombstones.length > GUARD_ROTATE_TOMBSTONES;
			if (big && this.quiescent(read.value, this.now())) await this.rotate(false);
		} catch (err) {
			this.rotationFailed(err instanceof Error ? err.message : String(err));
		}
	}

	/** Ops #253 (Security O2): after a rotation failed. While current.json still names the open store's generation,
	 *  approvals stay on it: logged once per reason while the server runs, and the next send that finds the store due
	 *  tries again. Otherwise, or when current.json can't be read, the ladder turns off: never guess (Ops #248, N3).
	 *  Writes no guard file. */
	private rotationFailed(message: string): void {
		const reason = message.replace(/^rotation: /, "");
		let at: number | string;
		try {
			at = this.currentGeneration();
		} catch (err) {
			at = `can't be read (${err instanceof Error ? err.message : String(err)})`;
		}
		if (typeof at !== "number" || join(this.o.dir, `gen-${at}`) !== this.storeDir)
			return this.degrade(`rotation: ${reason}`);
		if (this.rotationFailures.has(reason)) return;
		this.rotationFailures.add(reason);
		this.o.log(`approval ladder: rotation failed (${reason}); staying on generation ${at}`);
	}

	/** New generation dir, initialised with a fresh state; current.json switches atomically; the old dir stays as the
	 *  one archive. A crash before the switch leaves the old generation current. force: revoke what is open. */
	private async rotate(force: boolean): Promise<void> {
		await this.exclusive(async () => {
			const read = await this.store?.read();
			if (!read || read.state !== "ready") throw new Error("rotation: store not ready");
			if (!force && !this.quiescent(read.value, this.now())) return;
			const at = this.currentGeneration();
			if (typeof at === "string") throw new Error(`rotation: current.json ${at}`); // Ops #248 (N3): never guess
			const gen = at + 1;
			await this.beginGeneration(gen, "rotation", (store, dir) => this.useStore(store, dir));
			this.historySeen = new Map();
			if (force) this.writeHistory([{ at: this.now(), event: "revoked_all" }]);
			this.o.log(`approval ladder: guard store generation ${gen}${force ? " (revoked open approvals)" : ""}`);
		});
	}

	/** Ops #248 (Architecture S2): the one way a generation begins, for rotate() and the fresh start, so the two can't
	 *  drift. Removes a half-made gen-<gen>, initialises it with a fresh state (the store flushes its files), switches
	 *  current.json to it (flushed), hands the store to `adopt` when given, then removes generations older than the one
	 *  before it (a removal that fails is logged, not thrown: Ops #257, B5). A crash before the switch leaves the old
	 *  generation current. `what` names the caller in an error.
	 *  Runs under the lease. */
	private async beginGeneration(
		gen: number,
		what: string,
		adopt?: (store: GuardFileStore, dir: string) => void,
	): Promise<{ store: GuardFileStore; dir: string }> {
		const dir = join(this.o.dir, `gen-${gen}`);
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		const store = this.newStore(dir);
		const r = await store.initialize(this.freshState(), { v: 1, paused: false, messages: [] });
		if (r.state !== "ready") throw new Error(`${what}: ${r.reason}`);
		this.writeCurrent(gen);
		adopt?.(store, dir);
		// Ops #257 (Architecture B5): the switch is done, so the generation counts as begun; a clean-up that fails now
		// leaves the older folders for the next one, and the log says so.
		try {
			this.cleanGenerations(gen);
		} catch (err) {
			this.o.log(
				`approval ladder: rotated to generation ${gen}; cleanup failed (${err instanceof Error ? err.message : String(err)})`,
			);
		}
		return { store, dir };
	}

	/** After a restart: finish what E accepted before it (same identity only; no blind resend). */
	private async reconcileOutbox(): Promise<void> {
		const read = await this.store?.read();
		if (!read || read.state !== "ready" || !this.core) return;
		for (const entry of read.value.outbox) {
			if (entry.state === "handled" || entry.state === "failed") continue;
			try {
				await this.core.reconcile(entry.receipt.identity);
			} catch (err) {
				this.o.log(`approval ladder: reconcile ${entry.receipt.messageId}: ${(err as Error).message}`);
			}
		}
	}

	/** After a restart: show every still-open Owner question again (same question id; first answer still wins). */
	private async representQuestions(): Promise<void> {
		const read = await this.store?.read();
		if (!read || read.state !== "ready" || !this.adapters) return;
		const now = this.now();
		for (const q of this.questions.filter((x) => x.state === "pending")) {
			const r = read.value.requests.find((x) => guardDigest(x.binding) === q.bindingDigest);
			if (!r || r.state !== "awaiting_owner" || now >= r.expiresAt) continue;
			if (!this.adapters) return; // Ops #257 (N2): approvals turned off during the last one
			await this.adapters.native.presentOwnerQuestion(r);
		}
	}

	// -------------------------------------------------------------------------
	// Actors, chain position, approver
	// -------------------------------------------------------------------------

	private def(role: string): IdentityDef | undefined {
		return this.o.identities().find((d) => d.id === role);
	}
	private revision(def: IdentityDef): string {
		return short({ id: def.id, homeChat: def.homeChat ?? null });
	}
	/** The one way an actor is built (key order matters for exact comparison). */
	actorOf(role: string, file: string, task: GuardActor["task"], isHome: boolean): GuardActor | null {
		const def = this.def(role);
		if (!def) return null;
		const name = basename(file);
		return {
			role,
			sessionFile: file,
			sessionId: name,
			runtimeIncarnation: `native-session/${name}`,
			task,
			currentHome: isHome,
			identityRevision: this.revision(def),
		};
	}
	private senderActor(sender: RoleMessageSender): GuardActor | null {
		const g = sender.guard;
		if (!g) return null;
		const task: GuardActor["task"] = g.isHome
			? { kind: "home" }
			: g.task
				? { kind: "task", queueId: g.task.queueId, taskId: g.task.taskId, generation: basename(sender.file) }
				: { kind: "other", bindingId: basename(sender.file) };
		return this.actorOf(sender.role, sender.file, task, g.isHome);
	}
	private actorCurrent(a: GuardActor): boolean {
		if (a.role === HOST_ACTOR.role) return false;
		const def = this.def(a.role);
		if (!def) return false;
		const isHome = !!def.homeChat && samePath(def.homeChat, a.sessionFile);
		return a.currentHome === isHome && a.identityRevision === this.revision(def) && (a.task.kind === "home") === isHome;
	}
	private homeActor(role: string): GuardActor | null {
		const def = this.def(role);
		return def?.homeChat ? this.actorOf(role, def.homeChat, { kind: "home" }, true) : null;
	}

	/** Where a chat stands, from the role message it is handling (its last user message). */
	causalOf(
		file: string,
		lastUserText: string,
		state?: GuardStoreState,
	): GuardKnownCausality | { kind: "unknown"; reason: "pruned" | "contradictory" | "stale" } {
		const rm = this.o.roleMessages();
		const c = rm ? rm.causalityOf(file, lastUserText) : ({ kind: "none" } as const);
		if (c.kind === "none") {
			const d = guardDigest({ file, text: lastUserText });
			return {
				kind: "rooted",
				rootId: `root-${d.slice(0, 16)}`,
				parentId: null,
				nextHop: 1,
				sourceRevision: d.slice(0, 16),
				incomingRecordId: null,
				incomingHash: guardDigest(lastUserText),
			};
		}
		if (c.kind === "unknown") return { kind: "unknown", reason: c.reason === "missing" ? "pruned" : "contradictory" };
		const r = c.record;
		if (r.guard) {
			// A typed approval control keeps the business chain's place (no +1).
			const req = state?.requests.find(
				(x) => x.binding.requestId === r.guard!.requestId && x.binding.generation === r.guard!.generation,
			);
			return req ? req.binding.causal : { kind: "unknown", reason: "stale" };
		}
		const hash = r.hash ?? "";
		if (!r.root) {
			return {
				kind: "legacy_boundary",
				anchorId: `legacy-${r.id}`,
				incomingRecordId: r.id,
				incomingHash: hash,
				nextHop: r.chain + 1,
				historicalRoot: "unknown",
			};
		}
		return {
			kind: "rooted",
			rootId: r.root,
			parentId: r.id,
			nextHop: r.chain + 1,
			sourceRevision: hash,
			incomingRecordId: r.id,
			incomingHash: hash,
		};
	}

	private selection(binding: GuardApprovalBinding): GuardVerification<GuardApproverSelection> {
		if (binding.causal.nextHop >= GUARD_POLICY.depth.ownerFrom)
			return verified({ tier: "owner", reason: "hop_12_plus" });
		const coo = this.homeActor("coo");
		if (binding.requester.role === "coo" || !coo) {
			// The COO asking for itself has no distinct lower approver; nor has anyone when the COO has no home chat.
			return verified({ tier: "owner", reason: "no_distinct_lower_approver" });
		}
		const def = this.def("coo")!;
		const key = `coo|${this.revision(def)}|${def.homeChat}`;
		const seen = this.homeSeen.get(key) ?? this.now();
		this.homeSeen.set(key, seen);
		const proof: GuardProofReference = {
			sourceId: "pi-web-ui/identities",
			sourceVersion: "1",
			sourceIncarnation: "native",
			eventId: `home-coo-${this.revision(def)}`,
			revision: this.revision(def),
			digest: guardDigest({ id: def.id, homeChat: def.homeChat }),
			observedAt: seen,
		};
		return verified({ tier: "lower", role: "coo", route: "coo", home: coo, proof });
	}

	// -------------------------------------------------------------------------
	// E/A host verifier
	// -------------------------------------------------------------------------

	private verifier(): GuardHostVerifier {
		return {
			verifyInvocation: async (ref) => {
				const v = this.invocations.get(ref.invocationId);
				if (!v || v.ref.toolCallId !== ref.toolCallId || v.ref.runtimeBindingId !== ref.runtimeBindingId)
					return refused("invalid", "not a live invocation of this server");
				return this.actorCurrent(v.actor)
					? verified(v.actor)
					: refused("unavailable", "the chat is no longer bound to its role");
			},
			verifyCausality: async (actor) => {
				const text = this.lastUser.get(actor.sessionFile);
				if (text === undefined) return refused("unavailable", "no live chat position");
				const state = await this.state_();
				const c = this.causalOf(actor.sessionFile, text, state ?? undefined);
				return c.kind === "unknown" ? refused("unknown", `chain position ${c.reason}`) : verified(c);
			},
			selectApprover: async (binding) => this.selection(binding),
			verifyRoleDecision: async (ref, binding) => this.roleDecisionEvent(ref, binding),
			verifyOwnerAnswer: async (ref, q) => {
				const first = this.decisions.find((d) => d.kind === "owner" && d.questionId === q.questionId);
				if (!first || first.eventId !== ref.nativeAnswerEventId)
					return refused("invalid", "not the first native Owner answer");
				return this.ownerDecision(first, q);
			},
			verifyIncident: async () => refused("unavailable", "urgent notices are not part of this delivery"),
			revalidate: async (snapshot) => {
				if (!this.actorCurrent(snapshot.actor))
					return refused("unavailable", "the chat is no longer bound to its role");
				return verified({ ...snapshot, time: this.clock() });
			},
		};
	}

	private clock(): GuardTime {
		const now = this.now();
		if (now < this.lastObserved) return { nowMs: now, lastObservedMs: this.lastObserved, state: "unknown" };
		const t: GuardTime = { nowMs: now, lastObservedMs: this.lastObserved || now, state: "trusted" };
		this.lastObserved = now;
		return t;
	}

	private snapshotFor(
		actor: GuardActor,
		causal: GuardKnownCausality,
		authority: GuardAuthority | null,
		revision?: string,
	): GuardVerification<GuardVerifiedSnapshot> {
		if (!this.actorCurrent(actor)) return refused("unavailable", "the chat is no longer bound to its role");
		return verified({
			actor,
			causal,
			holds: NO_HOLDS,
			time: this.clock(),
			authority,
			incident: null,
			sourceRevision: revision ?? short(causal),
		});
	}

	private async state_(): Promise<GuardStoreState | null> {
		// Ops #257 (N2): a read that finds the lock taken by another server (B1) turns approvals off and throws; it gives
		// nothing then, as a record that can't be read does, and the caller sees approvals off.
		try {
			const r = await this.store?.read();
			return r?.state === "ready" ? r.value : null;
		} catch {
			return null;
		}
	}

	/** Ops #257 (N2): approvals turned off during one of a call's awaits (another call failed, another server took the
	 *  lock). The call then answers plainly instead of reading the gone adapters, and says only what is known. */
	private offNow(): boolean {
		return this.status_ !== "ready" || !this.adapters || !this.core;
	}
	private offText(done: string): string {
		return `Approvals turned off meanwhile (${this.degradedReason || "the ladder is off"}). ${done}`;
	}
	private offAnswer(done: string): { ok: false; text: string } {
		return {
			ok: false,
			text: this.offText(`${done} Messages 7 and above can't be sent now; ask the owner how to go on.`),
		};
	}

	// -------------------------------------------------------------------------
	// Storage: approval history and fill warnings (Ops rm-efd6df89)
	// -------------------------------------------------------------------------

	/** How full each of E's capped stores is (counted the way E counts them). */
	fills(s: GuardStoreState): { name: string; used: number; max: number }[] {
		const R = this.retention;
		const size = (name: string) => {
			try {
				return statSync(join(this.storeDir, name)).size;
			} catch {
				return 0; // not written yet
			}
		};
		const bytes = size("journal.json");
		return [
			{
				name: "open approval requests",
				used: s.requests.filter((r) => OPEN_REQUEST_STATES.includes(r.state)).length,
				max: R.maximumRequests,
			},
			{ name: "live grants", used: s.grants.filter((g) => g.state === "approved").length, max: R.maximumGrants },
			{ name: "usage events (last hour)", used: s.usage.length, max: R.maximumUsageEvents },
			{ name: "transactions", used: s.transactions.length, max: R.maximumTransactions },
			{ name: "audit receipts", used: s.audits.length, max: R.maximumAuditReceipts },
			{ name: "outbox entries", used: s.outbox.length, max: R.maximumOutboxEntries },
			{ name: "tombstones", used: s.tombstones.length, max: R.maximumTombstones },
			{ name: "guard store file (bytes)", used: bytes, max: GUARD_FILE_MAX_BYTES },
			// The accepted-message copy leaves only by rotation, which waits until nothing is open.
			{ name: "accepted copy file (bytes)", used: size("accepted.json"), max: GUARD_FILE_MAX_BYTES },
		];
	}

	/** The refusal text for retention_capacity: which store is full and what to do. */
	private async capacityText(): Promise<string> {
		const s = await this.state_();
		const full = s ? this.fills(s).sort((a, b) => b.used / b.max - a.used / a.max)[0] : undefined;
		const which = full ? ` (${full.name}: ${full.used} of ${full.max})` : "";
		return `the ladder's storage is full${which}; nothing was recorded or counted. Tell Ops; it frees up as old records age out.`;
	}

	/** After every ladder action: history lines for what changed, and the 80% warnings. Never throws. */
	async afterChange(): Promise<void> {
		try {
			const s = await this.state_();
			if (!s) return;
			for (const f of this.fills(s)) {
				const ratio = f.used / f.max;
				if (ratio >= GUARD_WARN_AT && !this.warned.has(f.name)) {
					this.warned.add(f.name);
					this.o.log(
						`approval ladder WARNING: ${f.name} at ${Math.round(ratio * 100)}% (${f.used} of ${f.max}); at 100% new approvals and sends past message 6 are refused. Tell Ops.`,
					);
				} else if (ratio < GUARD_WARN_REARM) this.warned.delete(f.name);
			}
			this.recordHistory(s);
		} catch (err) {
			this.o.log(`approval ladder: history not written (${(err as Error).message})`);
		}
	}

	private recordHistory(s: GuardStoreState): void {
		const seed = this.historySeen === null;
		const seen = (this.historySeen ??= new Map());
		const lines: GuardHistoryLine[] = [];
		const at = this.now();
		for (const r of s.requests) {
			const b = r.binding;
			const key = `r:${b.requestId}/${b.generation}`;
			const before = seen.get(key);
			if (before === r.state) continue;
			seen.set(key, r.state);
			if (seed) continue;
			const base = {
				at,
				requestId: b.requestId,
				generation: b.generation,
				requester: b.requester.role,
				tier: b.tier,
				state: r.state,
			};
			if (before === undefined)
				lines.push({
					...base,
					event: b.generation.startsWith("owner-escalation-") ? "escalation" : "request",
					quantity: b.quantity,
					fromHop: b.causal.nextHop,
					upperHop: b.upperHop,
				});
			else lines.push({ ...base, event: "decision" });
		}
		for (const g of s.grants) {
			const key = `g:${g.id}`;
			const now = `${g.state}/${g.acceptedUses}`;
			const before = seen.get(key);
			if (before === now) continue;
			seen.set(key, now);
			if (seed) continue;
			const base = {
				at,
				grantId: g.id,
				requestId: g.binding.requestId,
				generation: g.binding.generation,
				requester: g.binding.requester.role,
				tier: g.binding.tier,
				state: g.state,
				uses: g.acceptedUses,
				maximumUses: g.maximumUses,
			};
			const [beforeState, beforeUses] = (before ?? "/").split("/");
			if (before === undefined)
				lines.push({
					...base,
					event: "grant",
					fromHop: g.binding.causal.nextHop,
					upperHop: g.binding.upperHop,
					expiresAt: g.expiresAt,
				});
			if (before !== undefined && Number(beforeUses) !== g.acceptedUses) lines.push({ ...base, event: "grant_use" });
			if (before !== undefined && beforeState !== g.state) lines.push({ ...base, event: "grant_end" });
		}
		// Settled records leave E's store after a day; forget them here too.
		if (seen.size > 4 * (GUARD_RETENTION.maximumRequests + GUARD_RETENTION.maximumGrants)) {
			const live = new Set([
				...s.requests.map((r) => `r:${r.binding.requestId}/${r.binding.generation}`),
				...s.grants.map((g) => `g:${g.id}`),
			]);
			for (const k of seen.keys()) if (!live.has(k)) seen.delete(k);
		}
		this.writeHistory(lines);
	}

	private get historyPath(): string {
		return join(this.o.dir, "history.jsonl");
	}

	/** Append; past the size cap the file becomes the one archive (history.1.jsonl). Errors are logged, never thrown. */
	private writeHistory(lines: GuardHistoryLine[]): void {
		if (lines.length === 0) return;
		try {
			const text = lines.map((l) => `${JSON.stringify(l)}\n`).join("");
			let size = 0;
			try {
				size = statSync(this.historyPath).size;
			} catch {
				/* new file */
			}
			if (size > 0 && size + Buffer.byteLength(text) > (this.o.historyMaxBytes ?? GUARD_HISTORY_MAX_BYTES))
				renameSync(this.historyPath, join(this.o.dir, "history.1.jsonl"));
			appendFileSync(this.historyPath, text);
		} catch (err) {
			this.o.log(`approval ladder: history not written (${(err as Error).message})`);
		}
	}

	/** At start: drop history lines older than 30 days, and the archive once all of it is. */
	private tidyHistory(): void {
		const cutoff = this.now() - GUARD_HISTORY_KEEP_MS;
		const keep = (path: string): string[] | null => {
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch {
				return null;
			}
			const all = raw.split("\n").filter((l) => l.trim());
			const kept = all.filter((l) => {
				try {
					return (JSON.parse(l) as GuardHistoryLine).at >= cutoff;
				} catch {
					return false;
				}
			});
			return kept.length === all.length ? null : kept;
		};
		try {
			const archive = join(this.o.dir, "history.1.jsonl");
			const a = keep(archive);
			if (a && a.length === 0) rmSync(archive, { force: true });
			else if (a) writeDurable(archive, a.map((l) => `${l}\n`).join(""));
			const h = keep(this.historyPath);
			if (h) writeDurable(this.historyPath, h.map((l) => `${l}\n`).join(""));
		} catch (err) {
			this.o.log(`approval ladder: history not tidied (${(err as Error).message})`);
		}
	}

	private appendDecision(e: GuardDecisionEvent): void {
		const path = join(this.o.dir, "decisions.jsonl");
		appendFileSync(path, `${JSON.stringify(e)}\n`);
		const fd = openSync(path, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.decisions.push(e);
	}
	private saveQuestions(): void {
		const keep = this.questions.filter((q) => this.now() - q.createdAt < 2 * 86400000 || q.state === "pending");
		this.questions = keep;
		writeDurable(join(this.o.dir, "questions.json"), `${JSON.stringify(keep, null, "\t")}\n`);
	}

	private decisionProof(e: GuardDecisionEvent): GuardProofReference {
		return {
			sourceId: "pi-web-ui/role-message-guard/decisions",
			sourceVersion: "1",
			sourceIncarnation: "native",
			eventId: e.eventId,
			revision: e.eventId,
			digest: guardDigest(e),
			observedAt: e.answeredAt,
		};
	}

	/** The approver's answer: the first one recorded for this request binding wins. */
	private async roleDecisionEvent(
		ref: { invocation: GuardInvocationReference; choice: string; reason: string },
		binding: GuardApprovalBinding,
	): Promise<GuardVerification<GuardVerifiedDecision>> {
		const v = this.invocations.get(ref.invocation.invocationId);
		if (!v || v.ref.toolCallId !== ref.invocation.toolCallId || !this.actorCurrent(v.actor))
			return refused("invalid", "not a live approver call");
		const state = await this.state_();
		const request = state?.requests.find((r) => same(r.binding, binding));
		if (!request || request.selectedApprover.tier !== "lower")
			return refused("invalid", "no lower-tier request for this binding");
		if (!same(v.actor, request.selectedApprover.home))
			return refused("invalid", "only the selected approver's home chat decides");
		const bindingDigest = guardDigest(binding);
		let event = this.decisions.find((d) => d.kind === "role" && d.bindingDigest === bindingDigest);
		if (!event) {
			if (![...CHOICES, "escalate_owner"].includes(ref.choice)) return refused("invalid", "unknown choice");
			event = {
				eventId: `rd-${short({ bindingDigest, invocation: ref.invocation })}`,
				kind: "role",
				bindingDigest,
				choice: ref.choice as GuardDecisionEvent["choice"],
				reason: ref.reason,
				answeredAt: this.clock().nowMs,
				approver: v.actor,
			};
			await this.exclusive(async () => this.appendDecision(event!));
		}
		return this.roleDecision(event, request);
	}
	private roleDecision(e: GuardDecisionEvent, request: GuardRequest): GuardVerification<GuardVerifiedDecision> {
		if (request.selectedApprover.tier !== "lower") return refused("invalid", "not a lower-tier request");
		return verified({
			binding: request.binding,
			choice: e.choice,
			reason: e.reason,
			authority: {
				tier: "lower",
				selection: request.selectedApprover,
				decisionId: e.eventId,
				proof: this.decisionProof(e),
			},
			answeredAt: e.answeredAt,
			firstAnswerEventId: e.eventId,
		});
	}
	private ownerDecision(e: GuardDecisionEvent, q: GuardOwnerQuestion): GuardVerification<GuardVerifiedDecision> {
		if (e.kind !== "owner" || e.choice === "escalate_owner" || !e.source)
			return refused("invalid", "not an Owner answer");
		const source =
			e.source === "browser"
				? ({ kind: "authenticated_browser", authenticatedOwnerBindingId: "pi-web-token" } as const)
				: ({
						kind: "authorised_owner_telegram",
						pluginId: "telegram",
						authenticatedOwnerBindingId: "telegram-plugin:telegram",
					} as const);
		return verified({
			binding: q.binding,
			choice: e.choice,
			reason: e.reason,
			authority: {
				tier: "owner",
				questionId: q.questionId,
				questionGeneration: q.generation,
				choicesDigest: q.choicesDigest,
				decisionId: e.eventId,
				source,
				proof: this.decisionProof(e),
			},
			answeredAt: e.answeredAt,
			firstAnswerEventId: e.eventId,
		});
	}
	/** E re-derives every decision from the native event, never from the stored copy alone. */
	private async reverifyDecision(
		d: GuardVerifiedDecision,
		request: GuardRequest,
	): Promise<GuardVerification<GuardVerifiedDecision>> {
		const e = this.decisions.find((x) => x.eventId === d.authority.decisionId);
		if (!e || e.bindingDigest !== guardDigest(request.binding)) return refused("invalid", "no native decision event");
		let rebuilt: GuardVerification<GuardVerifiedDecision>;
		if (e.kind === "role") rebuilt = this.roleDecision(e, request);
		else {
			const q = this.questions.find((x) => x.questionId === e.questionId);
			if (!q) return refused("invalid", "no native Owner question");
			rebuilt = this.ownerDecision(e, this.questionOf(request, q));
		}
		if (rebuilt.state !== "verified") return rebuilt;
		return same(rebuilt.value, d) ? rebuilt : refused("invalid", "decision differs from its native record");
	}

	private async verifyGrantLineage(
		grant: GuardGrant,
		snapshot: GuardHostVerified<GuardVerifiedSnapshot>,
		scope: GuardScope,
		to: string,
	): Promise<GuardVerification<GuardVerifiedSnapshot>> {
		if (rootOf(grant.binding.causal) !== rootOf(snapshot.causal)) return refused("invalid", "another chain");
		if (!scope.participants.includes(snapshot.actor.role) || !scope.recipients.includes(to))
			return refused("invalid", "outside the grant's scope");
		return verified(snapshot);
	}

	// -------------------------------------------------------------------------
	// Native approval ports for A
	// -------------------------------------------------------------------------

	private control(actor: GuardActor, request: GuardRequest, phase: "initial" | "decision") {
		let to: string;
		if (phase === "initial") {
			if (request.selectedApprover.tier !== "lower")
				return refused<{ to: string; snapshot: GuardHostVerified<GuardVerifiedSnapshot> }>(
					"invalid",
					"an Owner phase has no agent message",
				);
			to = request.selectedApprover.role;
		} else to = request.binding.requester.role;
		const snap = this.snapshotFor(actor, request.binding.causal, null, short(request.binding));
		if (snap.state !== "verified")
			return snap as unknown as GuardVerification<{ to: string; snapshot: GuardHostVerified<GuardVerifiedSnapshot> }>;
		return verified({ to, snapshot: snap.value });
	}

	private questionOf(r: GuardRequest, q: GuardQuestionRecord): GuardOwnerQuestion {
		return {
			binding: r.binding,
			questionId: q.questionId,
			generation: q.generation,
			detail: r.context,
			choices: ["deny", "one_send", "requested_quantity"],
			choicesDigest: q.choicesDigest,
		};
	}
	private async question(r: GuardRequest, choicesDigest: string): Promise<GuardVerification<GuardOwnerQuestion>> {
		const bindingDigest = guardDigest(r.binding);
		let q = this.questions.find((x) => x.bindingDigest === bindingDigest);
		if (q && q.choicesDigest !== choicesDigest) return refused("invalid", "question digest changed");
		if (!q) {
			q = {
				questionId: `rq-${bindingDigest.slice(0, 12)}`,
				generation: r.binding.generation,
				requestId: r.binding.requestId,
				bindingDigest,
				choicesDigest,
				createdAt: this.now(),
				state: "pending",
			};
			this.questions.push(q);
			await this.exclusive(async () => this.saveQuestions());
		}
		return verified(this.questionOf(r, q));
	}
	private async ownerRequest(ref: {
		questionId: string;
		generation: string;
	}): Promise<GuardVerification<GuardRequest>> {
		const q = this.questions.find((x) => x.questionId === ref.questionId && x.generation === ref.generation);
		if (!q) return refused("invalid", "no such Owner question");
		const state = await this.state_();
		const r = state?.requests.find((x) => guardDigest(x.binding) === q.bindingDigest && x.binding.tier === "owner");
		return r ? verified(r) : refused("unavailable", "the request is gone");
	}
	private async present(q: GuardOwnerQuestion, ask: Ask): Promise<GuardTransportResult> {
		const shown: string[] = [];
		const requesterRole = q.binding.requester.role;
		const full: Ask = {
			...ask,
			body: `${requesterRole} asks to continue a chain of role messages past message ${q.binding.causal.nextHop - 1}.`,
		};
		if (this.o.askHub) {
			// Telegram: only the authorised Telegram plugin's answer counts here (never a plugin claiming "browser").
			this.o.askHub.settle(q.questionId, { how: "gone", reason: "shown again" });
			const added = this.o.askHub.add(full, (answers, from) => {
				if (from !== "telegram") return { ok: false, error: "Answer this in the app or on Telegram." };
				return this.answerFromAsk(q.questionId, q.generation, answers, "telegram");
			});
			if (added) shown.push("telegram");
		}
		// The app: every page gets the open questions (A's approval dialog); its answer comes back only through the
		// page's own authenticated socket command (role_guard_owner_answer).
		if (this.o.questionsChanged) {
			this.o.questionsChanged();
			shown.push("browser");
		}
		if (!shown.length) return { state: "held", reason: "no Owner channel connected" };
		return {
			state: "confirmed",
			proof: {
				sourceId: "pi-web-ui/owner-question",
				sourceVersion: "1",
				sourceIncarnation: "native",
				eventId: `present-${q.questionId}`,
				revision: q.generation,
				digest: q.choicesDigest,
				observedAt: this.now(),
			},
		};
	}
	private answerFromAsk(
		questionId: string,
		generation: string,
		answers: AskFieldAnswer[],
		source: "telegram",
	): Promise<{ ok: boolean; error?: string }> {
		const picked = answers.find((a) => a.id === generation)?.selected?.[0];
		if (!picked || !CHOICES.includes(picked as Choice))
			return Promise.resolve({ ok: false, error: "Pick one of the choices." });
		return this.ownerAnswer(questionId, generation, picked as Choice, source);
	}

	/** The open Owner questions with their requests (for the app's approval dialog). */
	async openQuestions(): Promise<UiRoleGuardQuestion[]> {
		if (this.status_ !== "ready") return [];
		const state = await this.state_();
		if (!state) return [];
		const now = this.now();
		const out: UiRoleGuardQuestion[] = [];
		for (const q of this.questions.filter((x) => x.state === "pending")) {
			const r = state.requests.find((x) => guardDigest(x.binding) === q.bindingDigest);
			if (!r || r.state !== "awaiting_owner" || now >= r.expiresAt) continue;
			out.push({
				questionId: q.questionId,
				generation: q.generation,
				requesterRole: r.binding.requester.role,
				request: r,
				ownerQuestion: this.questionOf(r, q),
			});
		}
		return out;
	}

	/** The owner's answer, from the authenticated page (browser) or the authorised Telegram plugin. First one wins. */
	async ownerAnswer(
		questionId: string,
		generation: string,
		picked: string,
		source: "browser" | "telegram",
	): Promise<{ ok: boolean; error?: string }> {
		try {
			return await this.ownerAnswerNow(questionId, generation, picked, source);
		} catch (err) {
			// Ops #257 (N2): approvals turned off while it ran, and a step threw for it: the plain answer, not the raw error.
			if (this.offNow()) return { ok: false, error: this.offText("Your answer may not have been applied; ask Ops.") };
			throw err;
		} finally {
			await this.afterChange();
		}
	}

	private async ownerAnswerNow(
		questionId: string,
		generation: string,
		picked: string,
		source: "browser" | "telegram",
	): Promise<{ ok: boolean; error?: string }> {
		if (this.status_ !== "ready" || !this.adapters) return { ok: false, error: "Approvals are unavailable right now." };
		const q = this.questions.find((x) => x.questionId === questionId && x.generation === generation);
		if (!q) return { ok: false, error: "This question is no longer open." };
		if (!(CHOICES as readonly string[]).includes(picked)) return { ok: false, error: "Pick one of the choices." };
		const choice = picked as Choice;
		const existing = this.decisions.find((d) => d.kind === "owner" && d.questionId === questionId);
		if (existing) return { ok: false, error: `Already answered (${existing.choice}, ${existing.source}).` };
		const event: GuardDecisionEvent = {
			eventId: `oa-${randomUUID()}`,
			kind: "owner",
			bindingDigest: q.bindingDigest,
			choice,
			reason: `Owner answered in ${source === "browser" ? "the app" : "Telegram"}`,
			answeredAt: this.clock().nowMs,
			questionId,
			generation,
			source,
		};
		await this.exclusive(async () => this.appendDecision(event));
		if (this.offNow()) return { ok: false, error: this.offText("Your answer was saved but not applied; ask Ops.") };
		const res = await this.adapters.native.ownerAnswer({ nativeAnswerEventId: event.eventId, questionId, generation });
		const ok = res.state === "recorded" || res.state === "accepted";
		q.state = "answered";
		await this.exclusive(async () => this.saveQuestions());
		this.o.askHub?.settle(questionId, { how: "answered", summary: choice, from: source });
		this.o.questionsChanged?.();
		if (!ok) {
			this.o.log(`approval ladder: Owner answer ${event.eventId} not recorded (${outcomeText(res)})`);
			return { ok: false, error: `Not recorded: ${outcomeText(res)}` };
		}
		this.o.log(`approval ladder: Owner ${choice} for ${q.requestId}/${generation} (${source})`);
		await this.notifyRequester(q.requestId, generation);
		return { ok: true };
	}

	/** Tell the requesting chat about a decision (E's typed control; for an Owner decision an FYI that resumes it). */
	private async notifyRequester(requestId: string, generation: string): Promise<void> {
		const state = await this.state_();
		const r = state?.requests.find((x) => x.binding.requestId === requestId && x.binding.generation === generation);
		if (!r || !this.adapters) return;
		const actor = r.binding.requester;
		const ref = this.invocation(actor, `notice-${requestId}-${generation}`);
		const res = await this.ctx.run(
			{ causal: r.binding.causal, guard: { requestId, generation, phase: "decision" } },
			() => this.adapters!.agent.notify(ref, requestId, generation, "decision"),
		);
		await this.afterAccepted(res);
	}

	// -------------------------------------------------------------------------
	// Transport and materialize
	// -------------------------------------------------------------------------

	private confirmed(entry: GuardOutboxEntry, eventId: string): GuardTransportResult {
		return {
			state: "confirmed",
			proof: {
				sourceId: "pi-web-ui/role-messages",
				sourceVersion: "1",
				sourceIncarnation: "native",
				eventId,
				revision: entry.message.id,
				digest: entry.receipt.legacyMessageDigest,
				observedAt: this.now(),
			},
		};
	}
	private async dispatch(entry: GuardOutboxEntry): Promise<GuardTransportResult> {
		const rm = this.o.roleMessages();
		if (!rm) return { state: "unknown", reason: "role messages not running" };
		return this.exclusive(async () => {
			const res = rm.admit(structuredClone(entry.message) as unknown as RoleMessageRecord, (schedule) =>
				this.lease.detach(schedule),
			);
			return res.ok ? this.confirmed(entry, entry.receipt.dispatchKey) : { state: "failed", reason: "not stored" };
		});
	}
	private async query(entry: GuardOutboxEntry): Promise<GuardTransportResult> {
		const rm = this.o.roleMessages();
		if (!rm) return { state: "unknown", reason: "role messages not running" };
		if (!rm.byId(entry.message.id)) return { state: "failed", reason: "not handed off before a restart" };
		const wake = entry.wakeState === "requested" || entry.wakeState === "unknown";
		return this.confirmed(entry, wake ? entry.receipt.wakeKey : entry.receipt.dispatchKey);
	}

	private senderOf(actor: GuardActor): RoleMessageSender {
		const ctx = this.ctx.getStore();
		if (ctx?.sender && samePath(ctx.sender.file, actor.sessionFile) && ctx.sender.role === actor.role)
			return ctx.sender;
		const def = this.def(actor.role);
		const chat =
			actor.task.kind === "home"
				? "home chat"
				: actor.task.kind === "task"
					? `Queue #${actor.task.taskId}`
					: "a chat of its own";
		return { role: actor.role, title: def?.title ?? actor.role, file: actor.sessionFile, chat, handling: 0 };
	}
	private async materialize(intent: GuardMessageIntent): Promise<GuardLegacyAcceptedMessage> {
		const rm = this.o.roleMessages();
		if (!rm) throw new Error("role messages not running");
		const ctx = this.ctx.getStore() ?? {};
		const sender = this.senderOf(intent.actor);
		const draft: RoleMessageDraft =
			ctx.draft && ctx.draft.text === intent.text && ctx.draft.to.role === intent.to
				? ctx.draft
				: {
						kind: intent.kind,
						text: intent.text,
						to: { role: intent.to, title: this.def(intent.to)?.title ?? intent.to },
						replyTo: intent.replyTo,
						initiative: "",
					};
		const record = rm.recordOf(
			sender,
			{ ...draft, kind: intent.kind, replyTo: intent.replyTo },
			intent.id,
			intent.at,
			intent.chain,
			{
				...(ctx.causal ? { root: rootOf(ctx.causal), parent: parentOf(ctx.causal) } : {}),
				...(intent.target ? { target: intent.target } : {}),
				...(ctx.guard ? { guard: ctx.guard } : {}),
			},
		);
		return record as unknown as GuardLegacyAcceptedMessage;
	}

	/** Deliver what E accepted (same identity; E owns dispatch state), then rotate if due. */
	private async afterAccepted(res: unknown): Promise<void> {
		if (!this.core || !res || typeof res !== "object" || (res as GuardResult).state !== "accepted") return;
		const accepted = res as Extract<GuardResult, { state: "accepted" }>;
		await this.core.reconcile(accepted.receipt.identity);
		await this.maybeRotate();
	}

	private invocation(actor: GuardActor, toolCallId: string): GuardInvocationReference {
		const ref: GuardInvocationReference = {
			invocationId: `inv-${short({ file: actor.sessionFile, toolCallId })}`,
			toolCallId,
			runtimeBindingId: actor.sessionFile,
		};
		this.invocations.set(ref.invocationId, { ref, actor });
		if (this.invocations.size > 500) this.invocations.delete(this.invocations.keys().next().value!);
		return ref;
	}

	// -------------------------------------------------------------------------
	// message_role: business sends and approval actions
	// -------------------------------------------------------------------------

	/** One business message under the ladder. Falls back to the native depth-6 rule when the guard is down. */
	async send(
		sender: RoleMessageSender,
		input: RoleMessageSendInput & { grant?: unknown },
		toolCallId: string,
	): Promise<RoleMessageGuardSendResult> {
		try {
			return await this.sendNow(sender, input, toolCallId);
		} finally {
			if (this.status_ === "ready") await this.afterChange();
		}
	}

	private async sendNow(
		sender: RoleMessageSender,
		input: RoleMessageSendInput & { grant?: unknown },
		toolCallId: string,
	): Promise<RoleMessageGuardSendResult> {
		const rm = this.o.roleMessages();
		if (!rm) return { ok: false, error: "Role messages aren't available in this app." };
		if (this.status_ !== "ready" || !this.core) return rm.send(sender, input);
		const prepared = rm.prepare(sender, input);
		if (!prepared.ok) return { ...prepared, reason: "invalid_input" };
		const actor = this.senderActor(sender);
		if (!actor) return rm.send(sender, input);
		const lastHour = rm.hourlyCount(sender.role);
		if (lastHour >= ROLE_MESSAGES_PER_HOUR)
			return {
				ok: false,
				error: `Not sent: ${sender.role} has sent ${lastHour} role messages in the last hour (the limit is ${ROLE_MESSAGES_PER_HOUR}). Ask the owner before sending more.`,
				reason: "ordinary_hourly",
			};
		const state = await this.state_();
		// Ops #257 (B1, N2): approvals turned off during the read (another server took the lock, another call failed).
		if (this.offNow())
			return {
				ok: false,
				error: `Not sent: ${this.offText("Nothing was recorded; send it again and it goes by the native rule (messages 7 and above can't be sent).")}`,
			};
		const causal = this.causalOf(sender.file, sender.guard?.lastUserText ?? "", state ?? undefined);
		if (causal.kind === "unknown")
			return {
				ok: false,
				error: `Not sent: this chat's place in its chain of role messages can't be proved (${causal.reason}). Ask the owner how to go on.`,
				reason: "causality_unknown",
			};
		const hop = causal.nextHop;
		const to = prepared.draft.to.role;
		const now = this.now();
		const wanted = typeof input.grant === "string" && input.grant.trim() ? input.grant.trim() : null;
		const choice = chooseGrant({
			grants: state?.grants ?? [],
			causal,
			actor,
			to,
			now,
			wanted,
			ancestorAt: (recordId, hop) => rm.ancestorAt(recordId, hop),
		});
		if (choice.kind === "mismatch")
			return {
				ok: false,
				error: `Not sent: ${blockedText("scope_mismatch")} (grant ${choice.grant.id}: ${choice.why}).`,
				reason: "scope_mismatch",
			};
		const grant = choice.kind === "use" ? choice.grant : null;
		const scope: GuardScope = grant
			? grant.binding.scope
			: {
					scopeId: "ordinary",
					operation: "role_message",
					participants: [...new Set([actor.role, to])] as [string, ...string[]],
					recipients: [to],
					task: actor.task,
				};
		const snap = this.snapshotFor(actor, causal, grant?.authority ?? null);
		if (snap.state !== "verified")
			return { ok: false, error: `Not sent: ${snap.reason}.`, reason: "authority_unavailable" };
		const body = {
			kind: "business_send" as const,
			snapshot: snap.value,
			scope,
			to,
			businessKind: prepared.draft.kind as GuardBusinessKind,
			text: prepared.draft.text,
			replyTo: prepared.draft.replyTo,
			grantId: grant?.id ?? null,
		};
		if (!["question", "request", "fyi", "reply"].includes(body.businessKind)) return rm.send(sender, input);
		const identity0 = {
			operationId: `send-${short({ file: sender.file, toolCallId })}`,
			fingerprint: "",
			actor,
			version: VERSION,
		};
		const command = { ...body, identity: identity0 };
		const identity = { ...identity0, fingerprint: guardCommandFingerprint(command) };
		this.lastUser.set(sender.file, sender.guard?.lastUserText ?? "");
		let res: GuardResult;
		try {
			res = await this.ctx.run({ sender, draft: prepared.draft, causal }, () =>
				this.core!.execute({ ...command, identity }),
			);
		} catch (err) {
			return { ok: false, error: `Not sent: the approval ladder couldn't record it (${(err as Error).message}).` };
		}
		if (res.state === "accepted") {
			await this.afterAccepted(res);
			const record = rm.byId(res.receipt.messageId);
			if (!record)
				return { ok: false, error: "Accepted but not handed off yet; it is delivered once the app catches up." };
			const targetChat =
				record.kind === "reply" && record.replyTo
					? `the chat that asked (${rm.byId(record.replyTo)?.from.chat ?? "?"}), else its home chat`
					: "its home chat";
			return { ok: true, record, paused: rm.paused, targetChat };
		}
		if (res.state === "blocked" && res.reason === "approval_required") {
			const tier = res.requiredTier ?? (hop >= GUARD_POLICY.depth.ownerFrom ? "owner" : "lower");
			const approver = tier === "owner" || actor.role === "coo" ? "the owner" : "the COO";
			const span =
				tier === "owner" ? "messages 12 and above need the owner's grant" : "messages 7 to 11 need the COO's grant";
			return {
				ok: false,
				error:
					`Approval needed: this would be message ${hop} in one chain of role messages. Messages 1 to 6 go without approval; ${span}. ` +
					`Ask ${approver} with message_role approval {action: "request", recipients: ["${to}"], context: {goal, progressAndChanges, priorDecisions, whyNeeded, nextStepAndOutcome, outstandingQuestions, optionsAndTradeoffs, timeCostRisk, exactCommunicationAuthority, declaredClaims, safetyScopeAndHolds}} ` +
					`(to, kind and text aren't needed for it). Once granted, send this again: the grant is used by itself. A grant covers at most 5 sends for one hour.`,
				approvalRequired: { hop, tier, approver },
				reason: "approval_required",
			};
		}
		if (res.state === "blocked" && res.reason === "retention_capacity")
			return { ok: false, error: `Not sent: ${await this.capacityText()}`, reason: res.reason };
		if (res.state === "blocked")
			return { ok: false, error: `Not sent: ${blockedText(res.reason)}`, reason: res.reason };
		if (res.state === "unknown")
			return {
				ok: false,
				error: `Not sent yet: its outcome is unknown (${res.reason}); don't resend, check again later.`,
				reason: "unknown",
			};
		return { ok: false, error: "Not sent." };
	}

	/** message_role approval {action request|status|decide}. */
	async approval(
		sender: RoleMessageSender,
		input: RoleMessageApprovalInput,
		toolCallId: string,
	): Promise<{ ok: boolean; text: string; details?: Record<string, unknown> }> {
		try {
			return await this.approvalNow(sender, input, toolCallId);
		} catch (err) {
			// Ops #257 (N2): approvals turned off while it ran, and a step threw for it: the plain answer, not the raw error.
			if (this.offNow()) return this.offAnswer("It may not have finished.");
			throw err;
		} finally {
			if (this.status_ === "ready") await this.afterChange();
		}
	}

	private async approvalNow(
		sender: RoleMessageSender,
		input: RoleMessageApprovalInput,
		toolCallId: string,
	): Promise<{ ok: boolean; text: string; details?: Record<string, unknown> }> {
		if (this.status_ !== "ready" || !this.adapters)
			return {
				ok: false,
				text: "Approvals are unavailable right now (the ladder is off); messages 7 and above can't be sent. Ask the owner how to go on.",
			};
		const actor = this.senderActor(sender);
		if (!actor) return { ok: false, text: "This chat can't ask for approvals." };
		const ref = this.invocation(actor, toolCallId);
		this.lastUser.set(sender.file, sender.guard?.lastUserText ?? "");
		const action = typeof input.action === "string" ? input.action.trim().toLowerCase() : "";
		const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
		const strs = (v: unknown) =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : [];
		if (action === "status") {
			const r = await this.adapters.agent.status(ref, str(input.requestId), str(input.generation) || "1");
			if (r.state !== "found")
				return { ok: false, text: `No such request visible to this chat (${"reason" in r ? r.reason : r.state}).` };
			return {
				ok: true,
				text: requestText(r.request, await this.state_()),
				details: { requestId: r.request.binding.requestId, state: r.request.state },
			};
		}
		if (action === "decide") {
			const choice = str(input.choice);
			const requestId = str(input.requestId);
			const generation = str(input.generation) || "1";
			const res = await this.ctx.run({ sender, guard: { requestId, generation, phase: "decision" } }, () =>
				this.adapters!.agent.roleDecision(ref, {
					requestId,
					generation,
					choice: choice as never,
					reason: str(input.reason),
				}),
			);
			if (!("state" in res) || (res.state !== "recorded" && res.state !== "accepted"))
				return this.offNow()
					? this.offAnswer(`Your answer to ${requestId} may not have been recorded; the requester wasn't told.`)
					: { ok: false, text: `Not recorded: ${outcomeText(res)}` };
			// Ops #257 (N2): approvals can turn off during each await below; never a raw error, and never that the
			// owner's dialog or the requester's notice went when that isn't known.
			const done = `Your ${choice} for ${requestId} was recorded, but`;
			const state = await this.state_();
			if (choice === "escalate_owner") {
				const esc = state?.requests.find(
					(x) => x.binding.requestId === requestId && x.binding.generation.startsWith("owner-escalation-"),
				);
				if (this.offNow()) return this.offAnswer(`${done} the owner wasn't shown his dialog.`);
				if (esc) await this.adapters!.native.presentOwnerQuestion(esc);
				if (this.offNow()) return this.offAnswer(`${done} the owner may not have been shown his dialog.`);
				return {
					ok: true,
					text: `Passed ${requestId} to the owner: he gets a dialog; the requester hears his answer.`,
				};
			}
			const r = state?.requests.find((x) => x.binding.requestId === requestId && x.binding.generation === generation);
			if (this.offNow()) return this.offAnswer(`${done} the requester wasn't told.`);
			const notice = await this.ctx.run(
				{ sender, causal: r?.binding.causal, guard: { requestId, generation, phase: "decision" } },
				() => this.adapters!.agent.notify(ref, requestId, generation, "decision"),
			);
			if (this.offNow()) return this.offAnswer(`${done} the requester may not have been told.`);
			await this.afterAccepted(notice);
			return { ok: true, text: `Recorded: ${choice} for ${requestId}. The requester gets your answer as a reply.` };
		}
		if (action !== "request") return { ok: false, text: 'approval.action must be "request", "status" or "decide".' };
		const state = await this.state_();
		if (this.offNow()) return this.offAnswer("Nothing was asked or recorded."); // Ops #257 (N2)
		const causal = this.causalOf(sender.file, sender.guard?.lastUserText ?? "", state ?? undefined);
		if (causal.kind === "unknown")
			return {
				ok: false,
				text: `This chat's place in its chain can't be proved (${causal.reason}); ask the owner how to go on.`,
			};
		const hop = causal.nextHop;
		if (hop <= GUARD_POLICY.depth.unapprovedThrough)
			return {
				ok: false,
				text: `No approval needed: your next message is number ${hop} in its chain (1 to 6 go without approval).`,
			};
		const recipients = strs(input.recipients);
		if (!recipients.length) return { ok: false, text: "approval.recipients: the role ids you need to message." };
		const ownerTier = hop >= GUARD_POLICY.depth.ownerFrom || actor.role === "coo" || !this.homeActor("coo");
		const max = ownerTier
			? Math.min(5, GUARD_POLICY.depth.ownerFrom + 5 - Math.max(hop, GUARD_POLICY.depth.ownerFrom))
			: Math.min(5, GUARD_POLICY.depth.lowerThrough + 1 - hop);
		// An explicit quantity must fit exactly (no silent clamping): 1 to what is left of this tier.
		if (
			input.quantity !== undefined &&
			!(
				typeof input.quantity === "number" &&
				Number.isInteger(input.quantity) &&
				input.quantity >= 1 &&
				input.quantity <= max
			)
		)
			return {
				ok: false,
				text: `Not asked: quantity must be a whole number from 1 to ${max} here (message ${hop}; ${ownerTier ? "owner grants end at 16" : "COO grants end at 11"}).`,
				details: { reason: "invalid_input", maximum: max },
			};
		const quantity = quantityOf(input.quantity === undefined ? max : (input.quantity as number));
		const requestId = `cr-${short({ file: sender.file, toolCallId }).slice(0, 8)}`;
		const c = (input.context && typeof input.context === "object" ? input.context : {}) as Record<string, unknown>;
		// Ops rm-efd6df89: an oversized context is refused whole, with its size (never cut down to fit).
		const contextBytes = Buffer.byteLength(JSON.stringify(c));
		if (contextBytes > GUARD_RETENTION.maximumContextBytes)
			return {
				ok: false,
				text: `Not asked: the context is ${contextBytes} bytes; at most ${GUARD_RETENTION.maximumContextBytes} (16 KB). Shorten it and ask again; nothing was recorded.`,
				details: { reason: "context_too_large", bytes: contextBytes, maximum: GUARD_RETENTION.maximumContextBytes },
			};
		const proof: GuardProofReference[] = causal.incomingRecordId
			? [
					{
						sourceId: "pi-web-ui/role-messages",
						sourceVersion: "1",
						sourceIncarnation: "native",
						eventId: causal.incomingRecordId,
						revision: causal.incomingHash.slice(0, 16),
						digest: causal.incomingHash,
						observedAt: this.now(),
					},
				]
			: [];
		const context: GuardApprovalContext = {
			goal: str(c.goal),
			progressAndChanges: str(c.progressAndChanges),
			priorDecisions: strs(c.priorDecisions),
			whyNeeded: str(c.whyNeeded),
			nextStepAndOutcome: str(c.nextStepAndOutcome),
			outstandingQuestions: strs(c.outstandingQuestions),
			optionsAndTradeoffs: strs(c.optionsAndTradeoffs),
			timeCostRisk: str(c.timeCostRisk),
			exactCommunicationAuthority: str(c.exactCommunicationAuthority),
			nativeFacts: proof,
			declaredClaims: strs(c.declaredClaims),
			safetyScopeAndHolds: strs(c.safetyScopeAndHolds),
		};
		// The grant covers messages among the named roles (the requester included, so the answer can come back);
		// E still binds it to the requester's task, so a participant in another task chat asks for its own.
		const participants = [...new Set([actor.role, ...strs(input.participants), ...recipients])];
		const scope = {
			scopeId: str(input.scopeId) || `scope-${requestId}`,
			operation: str(input.operation) || "role_message_continuation",
			participants,
			recipients: participants,
			task: actor.task,
		};
		const res = await this.adapters!.agent.request(ref, {
			binding: { requestId, generation: "1", scope },
			context,
			quantity,
		});
		if ((res as { reason?: string }).reason === "retention_capacity")
			return { ok: false, text: `Not asked: ${await this.capacityText()}`, details: { reason: "retention_capacity" } };
		if (!("state" in res) || res.state !== "recorded")
			return this.offNow()
				? this.offAnswer("Nothing was asked.")
				: { ok: false, text: `Not asked: ${outcomeText(res)}` };
		const r = res.request;
		// Ops #257 (N2): never that the approver was asked when that isn't known.
		const approver = r.binding.tier === "owner" ? "the owner" : "the COO";
		if (this.offNow()) return this.offAnswer(`Request ${requestId} was recorded, but ${approver} wasn't asked.`);
		const notice = await this.ctx.run(
			{ sender, causal: r.binding.causal, guard: { requestId, generation: "1", phase: "initial" } },
			() => this.adapters!.agent.notify(ref, requestId, "1", "initial"),
		);
		if (this.offNow())
			return this.offAnswer(`Request ${requestId} was recorded, but ${approver} may not have been asked.`);
		await this.afterAccepted(notice);
		const who =
			r.binding.tier === "owner" ? "the owner (a dialog in the app and on Telegram)" : `the COO (${outcomeId(notice)})`;
		return {
			ok: true,
			text:
				`Asked ${who} for up to ${r.binding.quantity} send(s) through message ${r.binding.upperHop} (request ${requestId}). ` +
				"The answer comes back to this chat as a new message: don't wait for it. Once granted, send again; the grant is used by itself.",
			details: {
				requestId,
				generation: "1",
				tier: r.binding.tier,
				quantity: r.binding.quantity,
				upperHop: r.binding.upperHop,
			},
		};
	}
}

/** E's own maintenance identity (never a role; never accepted as a sender). */
const HOST_ACTOR: GuardActor = {
	role: "pi-web-ui",
	sessionFile: "/pi-web-ui/role-message-guard/host",
	sessionId: "host",
	runtimeIncarnation: "host",
	task: { kind: "other", bindingId: "host" },
	currentHome: false,
	identityRevision: "host",
};

function outcomeId(res: unknown): string {
	const r = res as GuardResult;
	return r && typeof r === "object" && r.state === "accepted" ? r.receipt.messageId : "notice pending";
}
function outcomeText(res: unknown): string {
	const r = res as { state?: string; reason?: string };
	if (r?.state === "blocked") return blockedText((res as { reason: string }).reason);
	if (r?.state === "context_needed")
		return "every context field is needed (goal, progressAndChanges, whyNeeded, nextStepAndOutcome, timeCostRisk, exactCommunicationAuthority, and at least one outstandingQuestions and optionsAndTradeoffs line), at most 16 KB.";
	return r?.reason ?? r?.state ?? "unknown";
}
function blockedText(reason: string): string {
	const texts: Record<string, string> = {
		ordinary_hourly:
			"this role has sent 20 role messages in the last hour (the limit is 20). Ask the owner before sending more.",
		causality_unknown: "this chat's place in its chain can't be proved. Ask the owner how to go on.",
		scope_mismatch: "outside the grant's roles or task.",
		grant_denied: "the approval was denied.",
		grant_expired: "the grant (or request) has expired; ask again.",
		grant_exhausted: "the grant's sends are used up; ask again.",
		grant_revoked: "the grant was revoked.",
		request_capacity: "too many open approval requests from this role (20).",
		duplicate_slot: "that notice was already sent.",
		held: "held by a pause.",
		clock_untrusted: "the server's clock can't be trusted right now.",
		retention_capacity: "the ladder's storage is full; tell Ops.",
		identity_conflict: "a different request with the same id exists.",
		rollback_depth: "the ladder is rolled back to the native 6-message limit.",
		persistence_unavailable: "the ladder's storage is unavailable; tell Ops.",
		authority_unavailable: "this chat isn't bound to its role right now.",
		invalid_input: "the request isn't valid.",
	};
	return texts[reason] ?? reason;
}
function requestText(r: GuardRequest, state: GuardStoreState | null): string {
	const g = r.grantId ? state?.grants.find((x) => x.id === r.grantId) : undefined;
	const grant = g
		? ` Grant ${g.id}: ${g.state}, ${g.acceptedUses} of ${g.maximumUses} used, until ${new Date(g.expiresAt).toISOString()}.`
		: "";
	return `Request ${r.binding.requestId} (generation ${r.binding.generation}): ${r.state}; ${r.binding.tier === "owner" ? "the owner" : "the COO"} decides; up to ${r.binding.quantity} send(s), messages ${r.binding.causal.nextHop} to ${r.binding.upperHop}.${grant}`;
}
