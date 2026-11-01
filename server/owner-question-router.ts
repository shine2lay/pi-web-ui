// ---------------------------------------------------------------------------
// owner-question-router.ts — owner-question routing, wired (Ops #685; docs/owner-question-routing.md)
// ---------------------------------------------------------------------------
// While the ownerQuestionsViaCoo setting is on, every owner ask (ask_user_question, an extension's
// dialog, a tool approval, a queued task's card) is routed at the moment it is asked, by the rule in
// owner-question-route.ts, from the asking chat's own records: its turn record, when the owner last
// wrote there (owner-input-time.ts) and the identity whose home chat it is. A direct one is shown at
// once with its line; one routed to COO is held in AskHub, and its record kept in the hold store
// (owner-question-holds.ts) until COO lets it through or hands it back (#686), or the safety net
// lets it through. Grant asks are never routed here. With the setting off, no ask gets a route and
// every one is shown as before; anything still held goes through at the next sweep.
//
// The router hears AskHub as a bookkeeper (AskHub.observe, before any listener): whatever lets a
// held ask through, hands it back or settles it, its record follows. A queued task's card that goes
// away (its chat closed, a restart) keeps its record, so the card that comes back follows it: still
// held from its first time, or shown with COO's words. No model and no words decide anything here.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import {
	type Ask,
	type AskEvent,
	type AskHub,
	type AskKind,
	type AskReleasedBy,
	type AskResult,
	type AskRouteInput,
	isAskHeld,
	NOT_HELD,
	NOT_WAITING,
} from "./asks.js";
import {
	boundedHoldText,
	HOLD_SAFETY_NET_MS,
	holdDue,
	holdKeyOfAsk,
	holdKeyOfStuck,
	type OwnerQuestionHold,
	type OwnerQuestionHolds,
} from "./owner-question-holds.js";
import { type OwnerInputTimes, ownerLastWroteOf } from "./owner-input-time.js";
import { directRouteLabel, ownerQuestionRoute } from "./owner-question-route.js";
import type { RequesterTurn } from "./queue-requester.js";

/** How often the safety net looks for held asks that are due (at most a minute). */
export const SAFETY_NET_SWEEP_MS = 30_000;

/** What the host knows about the asking chat when an ask is made, from its own records only. */
export interface OwnerAskFacts {
	/** The asking chat's turn record (conv.turnRecord, or the pending one before its run starts). */
	turn?: RequesterTurn;
	/** owner-input-time.ts ownerLastWroteOf: when he last wrote in the asking chat. */
	ownerLastWroteAt?: number;
	/** The turn record itself, as an identity: COO handing a question back marks this turn, so
	 *  the chat's next question in the same turn goes straight to him. */
	turnKey?: object;
	/** The identity whose home chat asks (identities.ts homeChatOf). */
	homeRole?: string;
}

/** The asking chat as the host keeps it (agent-service Conversation): its running turn, the one about
 *  to start, and when the owner last wrote there. */
export interface OwnerAskChat extends OwnerInputTimes {
	turnRecord?: RequesterTurn;
	turnPending?: RequesterTurn;
}

/** The asking chat's facts, from its own records only (nothing is read from words). */
export function ownerAskFactsOf(chat: OwnerAskChat | undefined, homeRole?: string): OwnerAskFacts {
	const turn = chat?.turnRecord ?? chat?.turnPending;
	const wrote = chat ? ownerLastWroteOf(chat, turn) : undefined;
	return {
		...(turn ? { turn, turnKey: turn } : {}),
		...(wrote !== undefined ? { ownerLastWroteAt: wrote } : {}),
		...(homeRole ? { homeRole } : {}),
	};
}

/** A queued task's card: its ask key and signature (stuck-asks.ts stuckKey, stuckSig). */
export interface StuckAskKey {
	key: string;
	sig: string;
}

export interface OwnerQuestionRouterOptions {
	/** The ownerQuestionsViaCoo setting, read at each ask and each sweep. */
	enabled: () => boolean;
	hub: AskHub;
	/** The hold store, opened the first time something is held. */
	holds: () => OwnerQuestionHolds;
	now?: () => number;
	log?: (line: string) => void;
}

/** A held ask, and when the safety net lets it through at the latest (COO may let it through sooner). */
export interface HeldOwnerAsk {
	ask: Ask;
	until: number;
}

interface Routed {
	holdKey: string;
	stuck: boolean;
	turnKey?: object;
}

/** What ask_user_question gets back when COO hands its question back (its tool result says so). */
export interface QuestionReturned {
	returned: string;
}

export function isQuestionReturned(v: unknown): v is QuestionReturned {
	return (
		!!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { returned?: unknown }).returned === "string"
	);
}

/** The tool result of a question COO handed back: never the owner's answer. */
export function questionReturnedText(note: string): string {
	const n = note.trim();
	const end = /[.!?…]$/.test(n) ? "" : ".";
	return `Not the owner's answer. COO handed this back as your own call: ${n}${end} If only the owner can give it, ask again: it goes straight to him.`;
}

export class OwnerQuestionRouter {
	private store: OwnerQuestionHolds | undefined;
	private storeOpenFailed = false;
	/** Asks with a hold record, by ask id. */
	private readonly routed = new Map<string, Routed>();
	/** Turns in which COO handed a question back. */
	private readonly returnedTurns = new WeakSet<object>();
	/** A question's, dialog's or approval's id starts again after a restart: its hold key carries this process's own id. */
	private readonly epoch = randomUUID();
	private timer: ReturnType<typeof setInterval> | undefined;
	private readonly stopHearing: () => void;
	private readonly now: () => number;
	private readonly log: (line: string) => void;

	constructor(private readonly options: OwnerQuestionRouterOptions) {
		this.now = options.now ?? Date.now;
		this.log = options.log ?? ((line) => console.log(line));
		this.stopHearing = options.hub.observe((ev) => this.heard(ev));
	}

	/** The switch. A setting that can't be read is off: every ask is shown as before. */
	get enabled(): boolean {
		try {
			return this.options.enabled() === true;
		} catch {
			return false;
		}
	}

	/**
	 * Where an ask goes, as it is asked: the route to hand AskHub.add, or undefined (the switch is off,
	 * or the store can't hold it: shown as before, with no line). A COO route is held, unless its record
	 * from before a restart says it was let through already (a queued task's card).
	 */
	routeAsk(ask: Pick<Ask, "id" | "kind">, facts: OwnerAskFacts, stuck?: StuckAskKey): AskRouteInput | undefined {
		if (!this.enabled) return undefined;
		const now = this.now();
		const askedAgainAfterReturn =
			ask.kind === "question" && facts.turnKey !== undefined && this.returnedTurns.has(facts.turnKey);
		const route = ownerQuestionRoute({
			kind: ask.kind,
			turn: facts.turn,
			ownerLastWroteAt: facts.ownerLastWroteAt,
			now,
			homeRole: facts.homeRole,
			askedAgainAfterReturn,
		});
		if (route.to === "direct") {
			const wrote = facts.ownerLastWroteAt;
			const label = directRouteLabel(
				route.reason,
				wrote !== undefined && Number.isFinite(wrote) ? now - wrote : undefined,
			);
			return { to: "direct", reason: route.reason, ...(label ? { label } : {}) };
		}
		const store = this.holdStore();
		if (!store) return undefined;
		const holdKey = stuck ? holdKeyOfStuck(stuck.key, stuck.sig) : holdKeyOfAsk(`${this.epoch}:${ask.id}`);
		const admitted = store.admit(holdKey, ask.kind as AskKind, route.reason);
		const routed: Routed = {
			holdKey,
			stuck: stuck !== undefined,
			...(facts.turnKey ? { turnKey: facts.turnKey } : {}),
		};
		if (admitted.action === "hold") {
			this.routed.set(ask.id, routed);
			return { to: "coo", reason: admitted.hold.reason, heldAt: admitted.hold.createdAt };
		}
		const shown = letThroughBefore(admitted.hold);
		if (!shown) return undefined;
		this.routed.set(ask.id, routed);
		return shown;
	}

	/**
	 * routeAsk for an ask made in `chat` (the host's call): undefined while the switch is off, without
	 * looking at the chat; never throws, so routing can't lose an ask (a failure shows it as before).
	 */
	routeAskIn(
		ask: Pick<Ask, "id" | "kind">,
		chat: OwnerAskChat | undefined,
		homeRole: () => string | undefined,
		stuck?: StuckAskKey,
	): AskRouteInput | undefined {
		if (!this.enabled) return undefined;
		try {
			return this.routeAsk(ask, ownerAskFactsOf(chat, homeRole()), stuck);
		} catch (err) {
			this.log(`[owner-question-routing] route: ${(err as Error)?.message ?? String(err)}`);
			return undefined;
		}
	}

	/** COO (#686) lets a held ask through, with its note and recommendation (bounded as its record keeps them). */
	release(askId: string, by: AskReleasedBy, note?: string, recommendation?: string): AskResult {
		return this.options.hub.release(askId, by, boundedHoldText(note), boundedHoldText(recommendation));
	}

	/** COO (#686) hands a held question back to the chat that asked it; ask_user_question returns `note`. */
	returnToAsker(askId: string, note: string): AskResult {
		return this.options.hub.returnToAsker(askId, boundedHoldText(note));
	}

	/**
	 * The safety net: lets through every held ask that is due (owner-question-holds.ts holdDue), and
	 * every one when the switch is off or the store failed. Returns the ids it let through.
	 */
	sweep(): string[] {
		const hub = this.options.hub;
		const held = hub.heldList();
		const released: string[] = [];
		const on = this.enabled;
		const now = this.now();
		const store = this.store;
		const live = new Set<string>();
		for (const ask of held) {
			const r = this.routed.get(ask.id);
			if (r) live.add(r.holdKey);
			if (on && !this.dueNow(ask, r, now)) continue;
			if (hub.release(ask.id, "safety-net").ok) released.push(ask.id);
		}
		// Held records whose ask isn't here (a card whose chat closed): through too, so it shows when it comes back.
		if (store) for (const d of store.due(now)) if (!live.has(d.key)) store.release(d.key, "safety-net");
		return released;
	}

	/** When the safety net lets a held ask through at the latest (undefined when it isn't held). */
	heldUntil(askId: string): number | undefined {
		const ask = this.options.hub.get(askId);
		if (!ask || !isAskHeld(ask) || ask.route?.to !== "coo") return undefined;
		const r = this.routed.get(askId);
		const rec = r ? this.store?.get(r.holdKey) : undefined;
		if (rec?.state === "held") {
			if (rec.holdUntil !== undefined) return rec.holdUntil;
			if (rec.deliveredToCoo?.turnEndedAt !== undefined) return rec.deliveredToCoo.turnEndedAt;
			return rec.createdAt + HOLD_SAFETY_NET_MS;
		}
		return ask.route.heldAt + HOLD_SAFETY_NET_MS;
	}

	/** COO's desk shares this router's record key and store; never opens a second store. */
	holdKeyOf(askId: string): string | undefined {
		return this.routed.get(askId)?.holdKey;
	}

	/**
	 * The one shared store. With routing on it opens it if needed: after a restart COO's turn can settle
	 * (its saved card receipt) before any ask has reopened the store. Off: the already-open store only,
	 * so looking at the desk while routing is off never opens or writes one.
	 */
	holds(): OwnerQuestionHolds | undefined {
		return this.enabled ? this.holdStore() : this.store;
	}

	/** Everything held for COO now, oldest first, with when the safety net lets each through. */
	heldAsks(): HeldOwnerAsk[] {
		const out: HeldOwnerAsk[] = [];
		for (const ask of this.options.hub.heldList()) {
			const until = this.heldUntil(ask.id);
			if (until !== undefined) out.push({ ask, until });
		}
		return out;
	}

	/** The safety net's interval (server start). */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			try {
				this.sweep();
			} catch (err) {
				this.log(`[owner-question-routing] safety net: ${(err as Error)?.message ?? String(err)}`);
			}
		}, SAFETY_NET_SWEEP_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	/** Stop the interval and stop hearing AskHub. */
	dispose(): void {
		this.stop();
		this.stopHearing();
	}

	private holdStore(): OwnerQuestionHolds | undefined {
		if (this.store || this.storeOpenFailed) return this.store;
		try {
			this.store = this.options.holds();
		} catch (err) {
			// No store, nothing held: every ask is shown as before.
			this.storeOpenFailed = true;
			this.log(`[owner-question-routing] hold store: ${(err as Error)?.message ?? String(err)}`);
		}
		return this.store;
	}

	/** A held ask is due now: its record says so, or it has none (then its own time counts). */
	private dueNow(ask: Ask, r: Routed | undefined, now: number): boolean {
		const store = this.store;
		const rec = r && store ? store.get(r.holdKey) : undefined;
		if (r && store) return !rec || rec.state !== "held" || holdDue(rec, now, store.ok) !== null;
		const heldAt = ask.route?.to === "coo" ? ask.route.heldAt : Number.NaN;
		return !Number.isFinite(now) || !(now >= heldAt) || now - heldAt >= HOLD_SAFETY_NET_MS;
	}

	/** AskHub changed: the hold record follows, whoever made the change. */
	private heard(ev: AskEvent): void {
		const r = this.routed.get(ev.ask.id);
		if (!r) return;
		const store = this.store;
		try {
			if (ev.type === "released") {
				const route = ev.ask.route;
				const note = route?.to === "coo" ? route.note : undefined;
				const recommendation = route?.to === "coo" ? route.recommendation : undefined;
				store?.release(r.holdKey, ev.by, note, recommendation);
			} else if (ev.type === "returned") {
				this.routed.delete(ev.ask.id);
				if (r.turnKey) this.returnedTurns.add(r.turnKey);
				store?.returned(r.holdKey, ev.note);
			} else if (ev.type === "answered" || ev.type === "gone") {
				this.routed.delete(ev.ask.id);
				// A queued task's card that goes away may come back (a restart, its chat reopened): its record decides then.
				if (ev.type === "gone" && r.stuck) return;
				store?.gone(r.holdKey);
			}
		} catch (err) {
			this.log(`[owner-question-routing] hold record: ${(err as Error)?.message ?? String(err)}`);
		}
	}
}

/** The route of an ask whose record says it was let through before (a card after a restart). */
function letThroughBefore(hold: OwnerQuestionHold | undefined): AskRouteInput | undefined {
	if (!hold || hold.state !== "released") return undefined;
	const by = hold.releasedBy;
	if (by !== "coo" && by !== "safety-net") return undefined;
	return {
		to: "coo",
		reason: hold.reason,
		heldAt: hold.createdAt,
		releasedBy: by,
		...(hold.finishedAt !== undefined ? { releasedAt: hold.finishedAt } : {}),
		...(hold.note ? { note: hold.note } : {}),
		...(hold.recommendation ? { recommendation: hold.recommendation } : {}),
	};
}

export { NOT_HELD, NOT_WAITING };
