/**
 * nonblocking-ask (Ops #1086; Shine 2026-11-24, decision dr-36efc6499afe: "Non-blocking everywhere"): the durable list
 * of ask_user_question cards still waiting on an owner, and the texts the asking chat gets.
 *
 * ask_user_question no longer holds its chat's turn: the tool posts one card per owner and returns at once
 * (formatPostedQuestionsResult); the owner's answer, a cancel in the browser or COO's hand-back arrives later as a new
 * message in that chat (formatQuestionWakeMessage, questionWakeOf). Each card's life, kept in
 * `<dataDir>/pending-questions.json` (0600, written whole to a temp file and renamed over):
 * - "waiting": posted, nobody answered yet. A restart puts it back on every surface.
 * - "delivering": settled (answered / cancelled / returned), recorded BEFORE the wake goes into the chat and dropped
 *   only once the chat admitted it, so a restart mid-delivery replays the answer once instead of losing it.
 * Rule 30: a card is keyed by its tool call id (per owner for a split call, ask-question-owners.ts sliceToolCallId)
 * with a hash of what it asks: the same id and hash again is a no-op that hands back the card already kept, the same
 * id with another hash is refused loudly (PendingQuestionConflictError) and nothing changes.
 * Task 2 wires it into ClientSession (agent-service.ts); this file has no ClientSession, socket or model in it.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { questionReturnedText } from "./owner-question-router.js";
import { DEFAULT_REQUESTER } from "./owner-requester.js";
import type { QuestionAnswer, UiQuestion, UiTaskRequesterInput } from "./protocol.js";
import type { OwnerChannel } from "./role-replies.js";
import type { SentBy } from "./sent-by.js";

export const PENDING_QUESTIONS_FILE = "pending-questions.json";
const FILE_VERSION = 1;

/** What a card asks, as the tool posts it (the store adds `state` and `contentHash`). */
export interface NewPendingQuestion {
	/** The card's tool call id: the transcript's id, or `<id>#<owner>` for one owner's card of a split call. */
	id: string;
	/** Its id in the list of asks and the windows' pending questions (asks.ts). */
	askId: string;
	/** The tool call id its decision record is keyed by (decision-records.ts answerRef: `ask:<toolCallId>`). */
	toolCallId: string;
	conversationId?: string;
	sessionFile?: string;
	conversationTitle?: string;
	/** Whose card it is ("Shine", "Wai"): the people.json name. */
	owner: string;
	/** The ask's requester (owner-requester.ts): absent for the default owner, whose card also reaches Telegram. */
	requester?: string;
	questions: UiQuestion[];
	createdAt: number;
}

export interface PendingQuestionWaiting extends NewPendingQuestion {
	state: "waiting";
	contentHash: string;
	/** Kept for later (Shine m104353): the owner tucked the card away; it stays open everywhere but no longer pops
	 *  up over a chat. Not part of what it asks (contentHash). */
	later?: boolean;
}

/** How a card ended. `from` = where (FROM_BROWSER, "telegram"), `by` = who answered when known, `sentBy` = that
 *  person as the chat records a sender (Ops #1088, rule 37: the wake is his message, `[From: <name>]`). */
export type QuestionResolution =
	| {
			kind: "answered";
			answers: QuestionAnswer[];
			summary: string;
			from: string;
			by?: string;
			sentBy?: SentBy;
			decisionRef?: string;
	  }
	| { kind: "cancelled"; from: string; by?: string; sentBy?: SentBy }
	| { kind: "returned"; note: string };

export interface PendingQuestionDelivering extends Omit<PendingQuestionWaiting, "state"> {
	state: "delivering";
	resolution: QuestionResolution;
	settledAt: number;
}

export type PendingQuestionRecord = PendingQuestionWaiting | PendingQuestionDelivering;

/** The same card id posted again with different content: refused, nothing written. */
export class PendingQuestionConflictError extends Error {
	constructor(
		readonly id: string,
		readonly keptHash: string,
		readonly newHash: string,
	) {
		super(`pending question ${id} is already kept with other content (kept ${keptHash}, new ${newHash}); refused`);
		this.name = "PendingQuestionConflictError";
	}
}

/** The file can't be read as this store's list: refused loudly, never overwritten with an empty one. */
export class PendingQuestionsFileError extends Error {
	constructor(
		readonly file: string,
		why: string,
	) {
		super(`${file}: ${why}; fix or move it aside, the waiting questions in it are not overwritten`);
		this.name = "PendingQuestionsFileError";
	}
}

/** The hash of what a card asks: never its process-local ask id, its time or the chat's (renameable) title. */
export function pendingQuestionHash(q: NewPendingQuestion): string {
	const what = {
		id: q.id,
		toolCallId: q.toolCallId,
		sessionFile: q.sessionFile ?? null,
		owner: q.owner,
		requester: q.requester ?? null,
		questions: q.questions,
	};
	return createHash("sha256").update(canonicalJson(what)).digest("hex");
}

/** JSON with object keys sorted, so the same content always hashes the same. */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		const keys = Object.keys(o)
			.filter((k) => o[k] !== undefined)
			.sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export type PostOutcome =
	{ created: true; record: PendingQuestionWaiting } | { created: false; record: PendingQuestionRecord };
export type SettleOutcome =
	| { ok: true; record: PendingQuestionDelivering }
	| { ok: false; reason: "not kept" | "already settled"; record?: PendingQuestionDelivering };

/** The durable list. One instance per data folder (the server's, or a test's temporary one). */
export class PendingQuestionsStore {
	private records: Map<string, PendingQuestionRecord> | null = null;

	constructor(
		readonly file: string,
		private readonly now: () => number = Date.now,
	) {}

	static inDataDir(dataDir: string, now?: () => number): PendingQuestionsStore {
		return new PendingQuestionsStore(join(dataDir, PENDING_QUESTIONS_FILE), now);
	}

	/** Every kept card, oldest first. */
	list(): PendingQuestionRecord[] {
		return [...this.load().values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	get(id: string): PendingQuestionRecord | undefined {
		return this.load().get(id);
	}

	waiting(): PendingQuestionWaiting[] {
		return this.list().filter((r): r is PendingQuestionWaiting => r.state === "waiting");
	}

	delivering(): PendingQuestionDelivering[] {
		return this.list().filter((r): r is PendingQuestionDelivering => r.state === "delivering");
	}

	/** Keep a newly posted card. The same id and content again: nothing written, the kept card handed back. */
	post(input: NewPendingQuestion): PostOutcome {
		const fresh = checkNew(input);
		const contentHash = pendingQuestionHash(fresh);
		const records = this.load();
		const kept = records.get(fresh.id);
		if (kept) {
			if (kept.contentHash !== contentHash)
				throw new PendingQuestionConflictError(fresh.id, kept.contentHash, contentHash);
			return { created: false, record: kept };
		}
		const record: PendingQuestionWaiting = { ...fresh, state: "waiting", contentHash };
		this.save(new Map(records).set(record.id, record));
		return { created: true, record };
	}

	/** The card was answered, cancelled or handed back: recorded as delivering before the wake is sent. The first
	 *  settle wins; a second one changes nothing. */
	settle(id: string, resolution: QuestionResolution): SettleOutcome {
		const records = this.load();
		const kept = records.get(id);
		if (!kept) return { ok: false, reason: "not kept" };
		if (kept.state === "delivering") return { ok: false, reason: "already settled", record: kept };
		const { state: _waiting, ...fields } = kept;
		const record: PendingQuestionDelivering = {
			...fields,
			state: "delivering",
			resolution: checkResolution(resolution),
			settledAt: this.now(),
		};
		this.save(new Map(records).set(id, record));
		return { ok: true, record };
	}

	/** Keep a waiting card for later, or bring it back (`later` false). False when no waiting card has this id. */
	setLater(id: string, later: boolean): boolean {
		const records = this.load();
		const kept = records.get(id);
		if (kept?.state !== "waiting") return false;
		if ((kept.later === true) === later) return true;
		const { later: _was, ...rest } = kept;
		this.save(new Map(records).set(id, later ? { ...rest, later: true } : rest));
		return true;
	}

	/** The chat admitted the card's wake: it is done and leaves the list. False when it isn't being delivered. */
	admitted(id: string): boolean {
		const records = this.load();
		if (records.get(id)?.state !== "delivering") return false;
		const next = new Map(records);
		next.delete(id);
		this.save(next);
		return true;
	}

	/** A waiting card ends with no wake (its chat closed or was force-reset). A card being delivered stays: its
	 *  answer still reaches the chat. False when no waiting card has this id. */
	drop(id: string): boolean {
		const records = this.load();
		if (records.get(id)?.state !== "waiting") return false;
		const next = new Map(records);
		next.delete(id);
		this.save(next);
		return true;
	}

	/** The card with this ask id (a restored ask is found by it). */
	byAskId(askId: string): PendingQuestionRecord | undefined {
		return this.list().find((r) => r.askId === askId);
	}

	private load(): Map<string, PendingQuestionRecord> {
		if (this.records) return this.records;
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			this.records = new Map();
			return this.records;
		}
		this.records = parseFile(this.file, text);
		return this.records;
	}

	/** Write the whole list to a 0600 temp file, flush it, rename it over the file; only then is it the list. */
	private save(next: Map<string, PendingQuestionRecord>): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		const body = `${JSON.stringify({ v: FILE_VERSION, records: [...next.values()] }, null, "\t")}\n`;
		try {
			const fd = openSync(tmp, "w", 0o600);
			try {
				writeSync(fd, body);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			renameSync(tmp, this.file);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
		this.records = next;
	}
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optStr = (v: unknown) => v === undefined || typeof v === "string";

function checkNew(q: NewPendingQuestion): NewPendingQuestion {
	const bad = newQuestionProblem(q);
	if (bad) throw new TypeError(`pending question refused: ${bad}`);
	return q;
}

function newQuestionProblem(q: unknown): string | null {
	if (!isObj(q)) return "not an object";
	for (const k of ["id", "askId", "toolCallId", "owner"] as const) if (!isStr(q[k])) return `${k} missing`;
	for (const k of ["conversationId", "sessionFile", "conversationTitle", "requester"] as const)
		if (!optStr(q[k])) return `${k} is not text`;
	if (!Array.isArray(q.questions) || q.questions.length === 0) return "no questions";
	if (!q.questions.every((x) => isObj(x) && isStr(x.id) && typeof x.question === "string"))
		return "a question is malformed";
	if (typeof q.createdAt !== "number" || !Number.isFinite(q.createdAt)) return "createdAt is not a time";
	return null;
}

const sentByOk = (s: unknown) =>
	s === undefined || (isObj(s) && isStr(s.login) && isStr(s.name) && typeof s.owner === "boolean");

function resolutionProblem(r: unknown): string | null {
	if (!isObj(r)) return "resolution is not an object";
	if (r.kind !== "returned" && !sentByOk(r.sentBy)) return "sentBy is malformed";
	if (r.kind === "answered") {
		if (!Array.isArray(r.answers)) return "answers missing";
		if (!r.answers.every((a) => isObj(a) && isStr(a.id) && Array.isArray(a.selected))) return "an answer is malformed";
		if (typeof r.summary !== "string" || !isStr(r.from)) return "summary or from missing";
		return optStr(r.by) && optStr(r.decisionRef) ? null : "by or decisionRef is not text";
	}
	if (r.kind === "cancelled") return isStr(r.from) && optStr(r.by) ? null : "from missing";
	if (r.kind === "returned") return typeof r.note === "string" && r.note.trim() ? null : "note missing";
	return `unknown resolution ${JSON.stringify(r.kind)}`;
}

function checkResolution(r: QuestionResolution): QuestionResolution {
	const bad = resolutionProblem(r);
	if (bad) throw new TypeError(`pending question resolution refused: ${bad}`);
	return r;
}

function parseFile(file: string, text: string): Map<string, PendingQuestionRecord> {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new PendingQuestionsFileError(file, `not JSON (${(err as Error).message})`);
	}
	if (!isObj(raw) || raw.v !== FILE_VERSION || !Array.isArray(raw.records))
		throw new PendingQuestionsFileError(file, `not a version ${FILE_VERSION} list`);
	const records = new Map<string, PendingQuestionRecord>();
	raw.records.forEach((r, i) => {
		const bad =
			newQuestionProblem(r) ??
			(isObj(r) && isStr(r.contentHash) ? null : "contentHash missing") ??
			(isObj(r) && (r.later === undefined || typeof r.later === "boolean") ? null : "later is not true/false") ??
			(isObj(r) && r.state === "waiting"
				? null
				: isObj(r) && r.state === "delivering"
					? (resolutionProblem(r.resolution) ?? (typeof r.settledAt === "number" ? null : "settledAt missing"))
					: "state is neither waiting nor delivering");
		if (bad) throw new PendingQuestionsFileError(file, `record ${i}: ${bad}`);
		const rec = r as unknown as PendingQuestionRecord;
		if (records.has(rec.id)) throw new PendingQuestionsFileError(file, `record ${i}: id ${rec.id} twice`);
		records.set(rec.id, rec);
	});
	return records;
}

// ---------------------------------------------------------------------------------------------------------------
// What the model reads
// ---------------------------------------------------------------------------------------------------------------

/** One posted card, as the tool's result names it. */
export interface PostedQuestionCard {
	owner: string;
	toolCallId: string;
	questions: UiQuestion[];
}

/** The tool result handed back to the model: what was posted, never answers. */
export interface PostedQuestionsResult {
	content: { type: "text"; text: string }[];
	details: { posted: { owner: string; toolCallId: string; questionIds: string[] }[] };
}

const titleOf = (q: UiQuestion | undefined) => (q?.header?.trim() || q?.question?.trim() || q?.id) ?? "question";
const cardTitle = (questions: readonly UiQuestion[]) => titleOf(questions[0]);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The tool's immediate result: the cards are up and nothing is answered yet. It carries no `details.answers`, so
 * decision-records.ts backfill never writes an answer record from it (the answer's own record comes when it arrives).
 */
export function formatPostedQuestionsResult(posted: readonly PostedQuestionCard[]): PostedQuestionsResult {
	if (posted.length === 0) throw new Error("formatPostedQuestionsResult needs at least one posted card");
	const lines = [
		`Posted ${plural(posted.length, "question card")} without waiting (non-blocking); nothing is answered yet.`,
		...posted.flatMap((card) => [
			`For ${card.owner} (decision ref ask:${card.toolCallId}):`,
			...card.questions.map((q) => `- ${titleOf(q)}`),
		]),
		"Do NOT ask these again and do NOT wait for them. Finish any work that doesn't depend on the answers, then " +
			"end your turn now. Each owner's answer will arrive later as a new message in this chat.",
	];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			posted: posted.map((c) => ({
				owner: c.owner,
				toolCallId: c.toolCallId,
				questionIds: c.questions.map((q) => q.id),
			})),
		},
	};
}

const answeredIn = (from: string) => (from === "browser" ? "in the browser" : `on ${from}`);

function answerLine(q: UiQuestion | undefined, a: QuestionAnswer): string {
	const picked = a.selected.length ? a.selected.join(", ") : "(no selection)";
	const wrote = a.custom?.trim() ? ` (wrote: ${a.custom.trim()})` : "";
	return `- ${q?.header?.trim() || q?.question?.trim() || a.id}: ${picked}${wrote}`;
}

/** The message a settled card puts into its chat: the answer, the cancel, or COO's hand-back. */
export function formatQuestionWakeMessage(record: PendingQuestionDelivering): string {
	const r = record.resolution;
	const title = cardTitle(record.questions);
	if (r.kind === "returned")
		return `About your question "${title}" for ${record.owner}: ${questionReturnedText(r.note)}`;
	if (r.kind === "cancelled")
		return `Cancelled prompt "${title}" — continue without re-asking immediately (${r.by ?? record.owner} cancelled it ${answeredIn(r.from)}).`;
	const ref = r.decisionRef ?? `ask:${record.toolCallId}`;
	return [
		`${r.by ?? record.owner} answered your question "${title}" ${answeredIn(r.from)} (decision ref ${ref}):`,
		...r.answers.map((a) =>
			answerLine(
				record.questions.find((q) => q.id === a.id),
				a,
			),
		),
	].join("\n");
}

/** A settled card's wake, as the chat gets it: who it is from and how it is marked. */
export interface QuestionWake {
	/** The card's id (the store's key): admitted(id) once the chat took it. */
	id: string;
	conversationId?: string;
	sessionFile?: string;
	text: string;
	/** The turn's cause and owner channel: the owner's own channel, the way his typed message is marked. */
	cause: OwnerChannel;
	ownerChannel: OwnerChannel;
	/** The owner's input: the turn is his (turnOwnersOf = [owner]). */
	requester: Extract<UiTaskRequesterInput, { kind: "owner" }>;
	/** Who answered or cancelled (not on COO's hand-back): the transcript's sender and the model's `[From: <name>]`. */
	sentBy?: SentBy;
}

/** How a wake reaches its chat (Task 2: role delivery, which opens a closed chat and queues behind a busy turn).
 *  `admitted` (Ops #1088): settles once the wake is in the chat's transcript; none = it is already. */
export type QuestionWakeDeliver = (wake: QuestionWake) => Promise<ChatDeliveryResult>;
/** Role delivery's answer (agent-service sendRoleMessage), which a wake goes through. */
export type ChatDeliveryResult = { ok: true; admitted?: Promise<void> } | { ok: false; busy?: boolean; error: string };

/** What ClientSession is handed (Task 2 sets it in AgentService): the store and the way wakes go in. */
export interface PendingQuestionsHost {
	store: PendingQuestionsStore;
	deliver: QuestionWakeDeliver;
}

/** A stable owner input id for a card's wake (queue-requester.ts: `ri-`/`rs-` + hex): a replay carries the same. */
export function wakeInputId(id: string, channel: OwnerChannel): string {
	const hex = createHash("sha256").update(`question-wake:${id}`).digest("hex").slice(0, 32);
	return `${channel === "telegram" ? "rs" : "ri"}-${hex}`;
}

/** A settled card's wake: its text, and the card's owner it comes from (on the channel he answered on; else the
 *  browser). */
export function questionWakeOf(record: PendingQuestionDelivering): QuestionWake {
	const r = record.resolution;
	const channel: OwnerChannel = r.kind !== "returned" && r.from === "telegram" ? "telegram" : "browser";
	return {
		id: record.id,
		...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
		...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
		text: formatQuestionWakeMessage(record),
		cause: channel,
		ownerChannel: channel,
		requester: {
			kind: "owner",
			channel,
			id: wakeInputId(record.id, channel),
			person: record.owner || DEFAULT_REQUESTER,
		},
		...(r.kind !== "returned" && r.sentBy ? { sentBy: r.sentBy } : {}),
	};
}
