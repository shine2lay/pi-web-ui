// ---------------------------------------------------------------------------
// owner-question-holds.ts — owner-question routing: the durable record of each question held for COO
// (docs/owner-question-routing.md), and the safety-net clock that lets it through.
// ---------------------------------------------------------------------------
// A question routed to COO (owner-question-route.ts) is held: kept from the owner until COO lets it
// through with a note, hands it back to the chat that asked it (questions only), or the safety net
// lets it through bare. This store remembers each held one across restarts, so a queued task's card
// is never delivered to COO twice and one COO let through is shown at once with its line.
//
// The safety net (holdDue, pure) lets a held one through when:
//  1. the COO turn that got it ends without COO acting;
//  2. HOLD_SAFETY_NET_MS (30 minutes) have passed since it was held, unless COO holds it;
//  3. COO's hold has run out (each hold at most COO_HOLD_MAX_MS, 2 hours, renewable);
//  4. the store can't be read or written: it fails open, nothing more is held and every held one
//     goes to the owner as before (also a clock set back before the hold, or one that isn't a real
//     time).
// A store that fails stays failed until the app restarts, and never writes again (a file it couldn't
// read is left as it was).
//
// The file holds no words of any question: a stuck card's key is a hash of its ask key and
// signature; a question's, dialog's or approval's is its ask id. Only COO's own note and
// recommendation are kept, bounded. Mode 0600, written whole, at most HOLDS_MAX records; finished
// ones go after HOLD_FINISHED_KEEP_MS, or oldest first when it is full.
//
// Inert groundwork (Ops #684): nothing creates a store yet. #685/#686 wire it, #687 switches it on.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { AskKind } from "./asks.js";
import { OWNER_QUESTION_COO_REASONS, type OwnerQuestionCooReason } from "./owner-question-route.js";
import { writeWhole } from "./write-whole.js";

/** The store's file name, in the app's data folder. */
export const OWNER_QUESTION_HOLDS_FILE = "owner-question-holds.json";
/** COO hasn't acted this long after it was held: through. */
export const HOLD_SAFETY_NET_MS = 30 * 60_000;
/** The longest one COO hold lasts (COO may renew it). */
export const COO_HOLD_MAX_MS = 2 * 60 * 60_000;
/** A finished record (released, returned, gone) is kept this long, then pruned at the next write. */
export const HOLD_FINISHED_KEEP_MS = 14 * 24 * 60 * 60_000;
/** The most characters of COO's note, or of its recommendation, a record keeps. */
export const HOLD_TEXT_MAX = 600;
/** The most records the store keeps. */
export const HOLDS_MAX = 400;
/** A file bigger than this isn't read (the store fails open). */
export const HOLDS_READ_MAX = 4 * 1024 * 1024;
/** The longest key the store takes. */
const HOLD_KEY_MAX = 300;
/** An ask id longer than this is hashed into its key. */
const ASK_ID_KEY_MAX = 200;

export type HoldState = "held" | "released" | "returned" | "gone";
export type HoldReleasedBy = "coo" | "safety-net" | "owner-answered";
/** Why the safety net lets a held one through now. */
export type HoldDueReason =
	"coo-turn-ended" | "no-coo-action" | "hold-ended" | "clock-moved-back" | "clock-unusable" | "store-failed";

export interface OwnerQuestionHold {
	/** holdKeyOfStuck / holdKeyOfAsk. */
	key: string;
	kind: AskKind;
	/** Why the rule routed it to COO. */
	reason: OwnerQuestionCooReason;
	/** When it was held (ms). */
	createdAt: number;
	state: HoldState;
	/** When it went to COO, and when that COO turn ended. */
	deliveredToCoo?: { at: number; turnEndedAt?: number };
	releasedBy?: HoldReleasedBy;
	/** When it was released, returned or gone. */
	finishedAt?: number;
	/** COO's note (released) or what the asking chat should do instead (returned). */
	note?: string;
	recommendation?: string;
	/** COO holds it until then (at most COO_HOLD_MAX_MS ahead). */
	holdUntil?: number;
}

/**
 * What to do with an ask the rule routed to COO:
 *  - hold: keep it from the owner; `deliver` = it hasn't gone to COO yet (false after a restart that
 *    found it already delivered);
 *  - show: show it to the owner now. With a record: COO let it through ("released", with the note
 *    and recommendation), handed it back ("returned"), or its time ran out (a HoldDueReason, now
 *    released by the safety net). Without one: the store failed, is full, or the key isn't usable.
 */
export type HoldAdmission =
	| { action: "hold"; deliver: boolean; hold: OwnerQuestionHold }
	| { action: "show"; why: "released" | "returned" | HoldDueReason | "full" | "bad-key"; hold?: OwnerQuestionHold };

/** A queued task's card: its ask key (stuck-asks.ts stuckKey) and signature (stuckSig), hashed. */
export function holdKeyOfStuck(stuckKey: string, stuckSig: string): string {
	return `stuck:${sha256(`${stuckKey}\n${stuckSig}`).slice(0, 32)}`;
}

/** A question, dialog or approval: its ask id. */
export function holdKeyOfAsk(askId: string): string {
	return askId.length <= ASK_ID_KEY_MAX ? `ask:${askId}` : `ask:#${sha256(askId).slice(0, 32)}`;
}

/** The safety-net clock: why a held one goes through at `now`, or null while it may stay held. */
export function holdDue(h: OwnerQuestionHold, now: number, storeOk = true): HoldDueReason | null {
	if (h.state !== "held") return null;
	if (!storeOk) return "store-failed";
	// A time that isn't a real one can't run the clock: through, never held for good.
	if (!Number.isFinite(now)) return "clock-unusable";
	if (now < h.createdAt) return "clock-moved-back";
	if (h.holdUntil !== undefined) {
		// A hold further ahead than any hold can be (a bad record, a clock set back) doesn't count.
		return now >= h.holdUntil || h.holdUntil - now > COO_HOLD_MAX_MS ? "hold-ended" : null;
	}
	if (h.deliveredToCoo?.turnEndedAt !== undefined) return "coo-turn-ended";
	return now - h.createdAt >= HOLD_SAFETY_NET_MS ? "no-coo-action" : null;
}

/** Every held one due at `now`, in the store's order. Changes nothing. */
export function dueReleases(
	holds: readonly OwnerQuestionHold[],
	now: number,
	storeOk = true,
): Array<{ key: string; why: HoldDueReason }> {
	const due: Array<{ key: string; why: HoldDueReason }> = [];
	for (const h of holds) {
		const why = holdDue(h, now, storeOk);
		if (why) due.push({ key: h.key, why });
	}
	return due;
}

export interface OwnerQuestionHoldsOptions {
	now?: () => number;
	/** The most records kept (default HOLDS_MAX). */
	max?: number;
}

/** The hold records in one file (OWNER_QUESTION_HOLDS_FILE in the data folder). */
export class OwnerQuestionHolds {
	private holds: OwnerQuestionHold[] = [];
	private storeOk = true;
	private readonly now: () => number;
	private readonly max: number;

	constructor(
		private readonly path: string,
		options: OwnerQuestionHoldsOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.max = Math.max(1, options.max ?? HOLDS_MAX);
		try {
			const text = readBounded(path, HOLDS_READ_MAX);
			this.holds = text === null ? [] : parseHolds(text);
		} catch (err) {
			this.fail(err, "read");
			return;
		}
		// A question, dialog or approval lives only in the process that asked it: held ones died with it.
		const at = this.now();
		const died = this.holds.map((h) =>
			h.state === "held" && h.kind !== "stuck" ? { ...h, state: "gone" as const, finishedAt: at } : h,
		);
		if (died.some((h, i) => h !== this.holds[i])) this.save(died, true);
	}

	/** False once the file couldn't be read or written: nothing more is held, every held one is due. */
	get ok(): boolean {
		return this.storeOk;
	}

	get(key: string): OwnerQuestionHold | undefined {
		const h = this.holds.find((x) => x.key === key);
		return h ? copyHold(h) : undefined;
	}

	/** Every record, oldest first. */
	list(): OwnerQuestionHold[] {
		return this.holds.map(copyHold);
	}

	/** The held ones due now (holdDue). */
	due(now = this.now()): Array<{ key: string; why: HoldDueReason }> {
		return dueReleases(this.holds, now, this.storeOk);
	}

	/** An ask the rule routed to COO: hold it (a new record, or the one kept from before a restart), or show it. */
	admit(key: string, kind: AskKind, reason: OwnerQuestionCooReason): HoldAdmission {
		if (!validKey(key)) return { action: "show", why: "bad-key" };
		if (!this.storeOk) return { action: "show", why: "store-failed" };
		const now = this.now();
		// No clock, no safety net: nothing is held without one.
		if (!Number.isFinite(now)) return { action: "show", why: "clock-unusable" };
		const i = this.holds.findIndex((h) => h.key === key);
		const old = i >= 0 ? this.holds[i] : undefined;
		if (old?.state === "held") {
			const why = holdDue(old, now);
			if (!why) return { action: "hold", deliver: old.deliveredToCoo === undefined, hold: copyHold(old) };
			// Its time ran out (while the app was down, say): through now, never held again.
			const released: OwnerQuestionHold = { ...old, state: "released", releasedBy: "safety-net", finishedAt: now };
			this.save(replaceAt(this.holds, i, released), true);
			return { action: "show", why, hold: copyHold(released) };
		}
		if (old?.state === "released" || old?.state === "returned") {
			return { action: "show", why: old.state, hold: copyHold(old) };
		}
		// New, or asked again after it ended: held afresh.
		const fresh: OwnerQuestionHold = { key, kind, reason, createdAt: now, state: "held" };
		const roomy = old ? this.holds : this.withRoom(this.holds, now);
		if (!roomy) return { action: "show", why: "full" };
		const next = old ? replaceAt(roomy, i, fresh) : [...roomy, fresh];
		if (!this.save(next, false)) return { action: "show", why: "store-failed" };
		return { action: "hold", deliver: true, hold: copyHold(fresh) };
	}

	/** It went to COO. False when it isn't held or already went (never deliver it twice), or the store failed. */
	delivered(key: string): boolean {
		if (!this.storeOk) return false;
		const i = this.holds.findIndex((h) => h.key === key);
		const h = this.holds[i];
		if (!h || h.state !== "held" || h.deliveredToCoo) return false;
		return this.save(replaceAt(this.holds, i, { ...h, deliveredToCoo: { at: this.now() } }), false);
	}

	/** The COO turn that got it ended (COO may have acted in it, or not). True when that's news. */
	cooTurnEnded(key: string): boolean {
		const i = this.holds.findIndex((h) => h.key === key);
		const h = this.holds[i];
		if (!h || h.state !== "held" || !h.deliveredToCoo || h.deliveredToCoo.turnEndedAt !== undefined) return false;
		const deliveredToCoo = { ...h.deliveredToCoo, turnEndedAt: this.now() };
		this.save(replaceAt(this.holds, i, { ...h, deliveredToCoo }), true);
		return true;
	}

	/**
	 * COO holds it until `until`, at most COO_HOLD_MAX_MS from now (renewable while it is still held
	 * and not yet due). Returns the time it is held until, or null (not held, already due, a time not
	 * ahead, or the store failed).
	 */
	cooHold(key: string, until: number): number | null {
		if (!this.storeOk || !Number.isFinite(until)) return null;
		const now = this.now();
		const i = this.holds.findIndex((h) => h.key === key);
		const h = this.holds[i];
		if (!h || h.state !== "held" || until <= now || holdDue(h, now) !== null) return null;
		const holdUntil = Math.min(Math.floor(until), now + COO_HOLD_MAX_MS);
		return this.save(replaceAt(this.holds, i, { ...h, holdUntil }), false) ? holdUntil : null;
	}

	/** Let it through: by COO (with its note and recommendation), the safety net, or his own answer. */
	release(key: string, by: HoldReleasedBy, note?: string, recommendation?: string): boolean {
		const i = this.holds.findIndex((h) => h.key === key);
		const h = this.holds[i];
		if (!h || h.state !== "held") return false;
		const n = boundedHoldText(note);
		const r = boundedHoldText(recommendation);
		const released: OwnerQuestionHold = {
			...h,
			state: "released",
			releasedBy: by,
			finishedAt: this.now(),
			...(n ? { note: n } : {}),
			...(r ? { recommendation: r } : {}),
		};
		this.save(replaceAt(this.holds, i, released), true);
		return true;
	}

	/** COO handed a held question back to the chat that asked it, saying what to do instead. Questions only. */
	returned(key: string, note: string): boolean {
		const i = this.holds.findIndex((h) => h.key === key);
		const h = this.holds[i];
		const n = boundedHoldText(note);
		if (!h || h.state !== "held" || h.kind !== "question" || !n) return false;
		this.save(replaceAt(this.holds, i, { ...h, state: "returned", finishedAt: this.now(), note: n }), true);
		return true;
	}

	/** The ask ended (answered, cancelled, the chat closed) while held or after it was let through. */
	gone(key: string): boolean {
		const i = this.holds.findIndex((h) => h.key === key);
		const h = this.holds[i];
		if (!h || (h.state !== "held" && h.state !== "released")) return false;
		this.save(replaceAt(this.holds, i, { ...h, state: "gone", finishedAt: this.now() }), true);
		return true;
	}

	/**
	 * Writes `next` (pruned) whole. On success it is the store's list. On failure the store fails
	 * open, and the list becomes `next` only when `keepOnFailure` (a change that lets something go,
	 * never one that holds more).
	 */
	private save(next: OwnerQuestionHold[], keepOnFailure: boolean): boolean {
		const pruned = this.pruned(next, this.now());
		if (this.storeOk) {
			try {
				writeWhole(this.path, `${JSON.stringify({ v: 1, holds: pruned })}\n`, { mode: 0o600 });
				this.holds = pruned;
				return true;
			} catch (err) {
				this.fail(err, "write");
			}
		}
		if (keepOnFailure) this.holds = pruned;
		return false;
	}

	/** Without finished records older than HOLD_FINISHED_KEEP_MS. */
	private pruned(list: OwnerQuestionHold[], now: number): OwnerQuestionHold[] {
		return list.filter((h) => h.state === "held" || now - (h.finishedAt ?? now) < HOLD_FINISHED_KEEP_MS);
	}

	/** The list with room for one more: old finished records pruned, then the oldest finished ones; null if all are held. */
	private withRoom(list: OwnerQuestionHold[], now: number): OwnerQuestionHold[] | null {
		let next = this.pruned(list, now);
		while (next.length >= this.max) {
			let oldest = -1;
			next.forEach((h, j) => {
				if (h.state !== "held" && (oldest < 0 || (h.finishedAt ?? 0) < (next[oldest]?.finishedAt ?? 0))) oldest = j;
			});
			if (oldest < 0) return null;
			next = next.filter((_, j) => j !== oldest);
		}
		return next;
	}

	private fail(err: unknown, doing: "read" | "write"): void {
		if (!this.storeOk) return;
		this.storeOk = false;
		console.error(
			`[owner-question-holds] can't ${doing} ${this.path} (${(err as Error)?.message ?? String(err)}): ` +
				"nothing more is held, and held questions reach you as before",
		);
	}
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

const KINDS: readonly AskKind[] = ["question", "dialog", "approval", "stuck"];
const STATES: readonly HoldState[] = ["held", "released", "returned", "gone"];
const RELEASED_BY: readonly HoldReleasedBy[] = ["coo", "safety-net", "owner-answered"];
const HOLD_FIELDS = new Set([
	"key",
	"kind",
	"reason",
	"createdAt",
	"state",
	"deliveredToCoo",
	"releasedBy",
	"finishedAt",
	"note",
	"recommendation",
	"holdUntil",
]);

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
/** A time the store wrote: any real, non-negative number (a clock may give fractions of a millisecond). */
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= HOLD_KEY_MAX;
const validText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= HOLD_TEXT_MAX;

const replaceAt = (list: OwnerQuestionHold[], i: number, h: OwnerQuestionHold): OwnerQuestionHold[] =>
	list.map((x, j) => (j === i ? h : x));

const copyHold = (h: OwnerQuestionHold): OwnerQuestionHold => ({
	...h,
	...(h.deliveredToCoo ? { deliveredToCoo: { ...h.deliveredToCoo } } : {}),
});

/** Trimmed, at most HOLD_TEXT_MAX characters; "" for nothing. COO's note and recommendation, wherever kept. */
export function boundedHoldText(s: string | undefined): string {
	const t = typeof s === "string" ? s.trim() : "";
	if (t.length <= HOLD_TEXT_MAX) return t;
	let cut = t.slice(0, HOLD_TEXT_MAX - 1);
	if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // never half a character
	return `${cut}…`;
}

/** The file's text; null when there is none. Never follows a link; only a plain file of at most `max` bytes. */
function readBounded(path: string, max: number): string | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new Error("not a plain file");
		if (st.size > max) throw new Error(`bigger than ${max} bytes`);
		const buf = Buffer.alloc(st.size + 1);
		let len = 0;
		while (len < buf.length) {
			const n = readSync(fd, buf, len, buf.length - len, null);
			if (n === 0) break;
			len += n;
		}
		if (len > st.size) throw new Error("it changed while being read");
		return buf.subarray(0, len).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** The records of a version-1 file; throws on anything else (a record it doesn't know, a key twice). */
function parseHolds(text: string): OwnerQuestionHold[] {
	const doc: unknown = JSON.parse(text);
	if (!isPlainObject(doc) || doc.v !== 1 || !Array.isArray(doc.holds) || Object.keys(doc).length !== 2) {
		throw new Error("not a version-1 holds file");
	}
	const seen = new Set<string>();
	return doc.holds.map((raw: unknown, i: number) => {
		const h = holdOf(raw);
		if (!h) throw new Error(`record ${i} isn't one it knows`);
		if (seen.has(h.key)) throw new Error(`record ${i} repeats a key`);
		seen.add(h.key);
		return h;
	});
}

function holdOf(raw: unknown): OwnerQuestionHold | null {
	if (!isPlainObject(raw) || Object.keys(raw).some((k) => !HOLD_FIELDS.has(k))) return null;
	const { key, kind, reason, createdAt, state, deliveredToCoo: d, releasedBy, finishedAt, note, recommendation } = raw;
	if (!validKey(key) || !oneOf(KINDS, kind) || !oneOf(OWNER_QUESTION_COO_REASONS, reason) || !isTime(createdAt))
		return null;
	if (!oneOf(STATES, state)) return null;
	const h: OwnerQuestionHold = { key, kind, reason, createdAt, state };
	if (d !== undefined) {
		if (!isPlainObject(d) || Object.keys(d).some((k) => k !== "at" && k !== "turnEndedAt")) return null;
		const { at, turnEndedAt } = d;
		if (!isTime(at) || (turnEndedAt !== undefined && !isTime(turnEndedAt))) return null;
		h.deliveredToCoo = { at, ...(turnEndedAt !== undefined ? { turnEndedAt } : {}) };
	}
	if (releasedBy !== undefined) {
		if (!oneOf(RELEASED_BY, releasedBy)) return null;
		h.releasedBy = releasedBy;
	}
	if (finishedAt !== undefined) {
		if (!isTime(finishedAt)) return null;
		h.finishedAt = finishedAt;
	}
	if (note !== undefined) {
		if (!validText(note)) return null;
		h.note = note;
	}
	if (recommendation !== undefined) {
		if (!validText(recommendation)) return null;
		h.recommendation = recommendation;
	}
	const { holdUntil } = raw;
	if (holdUntil !== undefined) {
		if (!isTime(holdUntil)) return null;
		h.holdUntil = holdUntil;
	}
	// A held one hasn't finished; a finished one says when.
	const finished = state !== "held";
	if (finished !== (h.finishedAt !== undefined) || (!finished && h.releasedBy !== undefined)) return null;
	return h;
}
