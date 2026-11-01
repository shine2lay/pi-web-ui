// ---------------------------------------------------------------------------------------------------------------
// owner-question-coo.ts — COO's desk for owner questions held for it (Ops #686, H-OWNER-COO-CARD)
// ---------------------------------------------------------------------------------------------------------------
//
// When owner-question routing holds an ask for COO (AskHub "held", #684/#685), the desk puts a card
// into COO's home chat (owner-question-card.ts) by the same delivery role messages use: after COO's
// current turn, as an extension input, never as the owner's. Held questions waiting at delivery time
// share one card, and the card is written at the moment it goes, so an ask that is answered or gone
// by then never gets one. When the COO turn that got a card settles, every question in it that is
// still held with no action from COO (no release, hold or return) is let through to the owner at
// once: the safety net on COO's side. A card that can't reach COO at all lets its questions through
// too (fail open). The owner_question tool (owner-question-tool.ts) acts through the desk.
//
// With the ownerQuestionsViaCoo switch off nothing is delivered. The desk never answers an ask.

import { randomUUID } from "node:crypto";
import type { Ask, AskEvent, AskReleasedBy, AskResult } from "./asks.js";
import {
	type CardQuestion,
	cardHandleOf,
	type OwnerQuestionAsker,
	ownerQuestionCardText,
} from "./owner-question-card.js";
import {
	HOLD_SAFETY_NET_MS,
	holdDue,
	type OwnerQuestionHold,
	type OwnerQuestionHolds,
} from "./owner-question-holds.js";

/** Held questions arriving this close together share a card. */
export const CARD_BATCH_MS = 2_000;
/** A card that couldn't be delivered for now is tried again after this. */
export const CARD_RETRY_MS = 60_000;
const FATES_KEPT = 400;

/** What delivering a card did: final = it can never reach COO's chat (no COO role, home chat or file). */
export type CardDelivery = { ok: true } | { ok: false; error: string; final?: boolean };

/** What the desk needs from the app (agent-service.ts wires it to AskHub, the router and role delivery). */
export interface CooDeskPort {
	/** The ownerQuestionsViaCoo switch. */
	routingOn(): boolean;
	/** Hear AskHub as a bookkeeper (AskHub.observe). Returns the way to stop. */
	hear(fn: (ev: AskEvent) => void): () => void;
	/** Everything held for COO now, oldest first (AskHub.heldList). */
	heldAsks(): Ask[];
	/** The hold record's key of a held ask (the router's), or undefined when it has none. */
	holdKeyOf(askId: string): string | undefined;
	/** The hold store, or undefined when it couldn't be opened. */
	holds(): OwnerQuestionHolds | undefined;
	/** When the safety net lets a held ask through at the latest (router.heldUntil). */
	heldUntil(askId: string): number | undefined;
	/** Let a held ask through (router.release: the store follows). */
	release(askId: string, by: AskReleasedBy, note?: string, recommendation?: string): AskResult;
	/** Hand a held question back to the chat that asked (router.returnToAsker). */
	returnToAsker(askId: string, note: string): AskResult;
	/** Who asks, from the app's own records. */
	askerOf(ask: Ask): OwnerQuestionAsker;
	/** When the owner last wrote in the asking chat, if known. */
	ownerLastWroteAt?(ask: Ask): number | undefined;
	/** Deliver a card to COO's home chat. `compose` runs when it goes; undefined = nothing to send. */
	deliver(compose: () => string | undefined, sendId: string, current: () => boolean): Promise<CardDelivery>;
	now?(): number;
	log?(line: string): void;
	/** The owner's time zone, for the card's deadline. */
	tz?: string;
}

/** A held question as the desk lists it. */
export interface HeldQuestionView {
	handle: string;
	ask: Ask;
	asker: OwnerQuestionAsker;
	goesAt: number;
	/** When its card reached COO (undefined: not yet). */
	cardAt?: number;
	/** COO's hold, and why. */
	holdUntil?: number;
	holdWhy?: string;
}

/** Where a handle stands now. */
export type QuestionWhere =
	| { at: "held"; handle: string; ask: Ask; key: string; record?: OwnerQuestionHold }
	| { at: "owner"; handle: string; ask?: Ask; by: AskReleasedBy | "owner-answered" }
	| { at: "answered"; handle: string }
	| { at: "returned"; handle: string }
	| { at: "gone"; handle: string }
	| { at: "unknown"; handle: string };

export type DeskResult = { ok: true; where: QuestionWhere } | { ok: false; error: string; where?: QuestionWhere };
export type HoldResult = { ok: true; until: number } | { ok: false; error: string; where?: QuestionWhere };

interface CardItem {
	askId: string;
	key: string;
}

type Fate = { type: "answered" | "gone" | "returned" } | { type: "released"; by: AskReleasedBy };

export class CooOwnerQuestionDesk {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing = false;
	private again = false;
	private stopped = false;
	private stopHearing: (() => void) | undefined;
	/** Cards sent or on their way, by send id. */
	private readonly cards = new Map<string, CardItem[]>();
	/** Hold keys in a card on its way. */
	private readonly inFlight = new Set<string>();
	/** What happened to asks that left the held list, by ask id. */
	private readonly fates = new Map<string, Fate>();
	/** Hold key and ask id of every handle seen. */
	private readonly handles = new Map<string, CardItem>();

	constructor(
		private readonly port: CooDeskPort,
		private readonly opts: { batchMs?: number; retryMs?: number } = {},
	) {}

	start(): void {
		if (this.stopHearing) return;
		this.stopped = false;
		this.stopHearing = this.port.hear((ev) => this.heard(ev));
		// Held before the desk started (a restart): their cards go now.
		if (this.port.routingOn() && this.port.heldAsks().length) this.schedule(this.batchMs);
	}

	stop(): void {
		this.stopped = true;
		this.stopHearing?.();
		this.stopHearing = undefined;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	routingOn(): boolean {
		try {
			return this.port.routingOn() === true;
		} catch {
			return false;
		}
	}

	private get now(): number {
		return this.port.now?.() ?? Date.now();
	}

	private get batchMs(): number {
		return this.opts.batchMs ?? CARD_BATCH_MS;
	}

	private log(line: string): void {
		(this.port.log ?? ((l: string) => console.log(l)))(`[owner-question-coo] ${line}`);
	}

	private heard(ev: AskEvent): void {
		if (ev.type === "held") {
			if (this.routingOn()) this.schedule(this.batchMs);
			return;
		}
		if (ev.type === "appeared") return;
		const fate: Fate | undefined =
			ev.type === "released"
				? { type: "released", by: ev.by }
				: ev.type === "answered" || ev.type === "gone" || ev.type === "returned"
					? { type: ev.type }
					: undefined;
		if (!fate) return;
		this.fates.set(ev.ask.id, fate);
		if (this.fates.size > FATES_KEPT) this.fates.delete(this.fates.keys().next().value as string);
	}

	private schedule(ms: number): void {
		if (this.stopped) return;
		if (this.flushing) {
			this.again = true;
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, ms);
		this.timer.unref?.();
	}

	/** Held questions with no card yet: still held, with a record that hasn't gone to COO. */
	private waiting(): Array<{ ask: Ask; key: string; record: OwnerQuestionHold }> {
		const holds = this.port.holds();
		if (!holds?.ok) return [];
		const out: Array<{ ask: Ask; key: string; record: OwnerQuestionHold }> = [];
		for (const ask of this.port.heldAsks()) {
			const key = this.port.holdKeyOf(ask.id);
			if (!key || this.inFlight.has(key)) continue;
			const record = holds.get(key);
			if (record?.state !== "held" || record.deliveredToCoo) continue;
			out.push({ ask, key, record });
		}
		return out;
	}

	private cardQuestion(ask: Ask, key: string, record: OwnerQuestionHold | undefined): CardQuestion {
		const handle = cardHandleOf(key);
		this.handles.set(handle, { askId: ask.id, key });
		const now = this.now;
		const wrote = this.port.ownerLastWroteAt?.(ask);
		const route = ask.route?.to === "coo" ? ask.route : undefined;
		const goesAt =
			this.port.heldUntil(ask.id) ?? (record ? record.createdAt : (route?.heldAt ?? now)) + HOLD_SAFETY_NET_MS;
		return {
			handle,
			ask,
			asker: this.port.askerOf(ask),
			reason: record?.reason ?? route?.reason ?? "owner-away",
			...(wrote !== undefined && Number.isFinite(wrote) && now >= wrote ? { lastWroteAgoMs: now - wrote } : {}),
			goesAt,
		};
	}

	/** Send one card with every held question waiting for one; more held meanwhile get the next card. */
	async flush(): Promise<void> {
		if (this.flushing || this.stopped || !this.routingOn()) return;
		this.flushing = true;
		this.again = false;
		const sendId = `oqc-${randomUUID()}`;
		let items: CardItem[] = [];
		let retryLater = false;
		try {
			const compose = (): string | undefined => {
				if (this.stopped || !this.routingOn()) return undefined;
				const waiting = this.waiting();
				if (!waiting.length) return undefined;
				items = waiting.map((w) => ({ askId: w.ask.id, key: w.key }));
				for (const it of items) this.inFlight.add(it.key);
				this.cards.set(sendId, items);
				return ownerQuestionCardText(
					waiting.map((w) => this.cardQuestion(w.ask, w.key, w.record)),
					{ ...(this.port.tz ? { tz: this.port.tz } : {}) },
				);
			};
			// SDK input hooks/auth can await after composition. Refuse stale content at its final
			// preflight (before the run); the next delivery composes afresh, including new asks.
			const current = (): boolean => {
				if (this.stopped || !this.routingOn() || this.waiting().length > 0) return false;
				const held = this.port.heldAsks();
				return (
					items.length > 0 &&
					items.every((it) => held.some((ask) => ask.id === it.askId && this.port.holdKeyOf(ask.id) === it.key))
				);
			};
			let result: CardDelivery;
			try {
				result = await this.port.deliver(compose, sendId, current);
			} catch (err) {
				result = { ok: false, error: (err as Error)?.message ?? String(err) };
			}
			if (!result.ok && result.final) {
				// It can never reach COO: through to the owner now (fail open), whether or not a card was written.
				this.cards.delete(sendId);
				const targets = items.length ? items : this.waiting().map((w) => ({ askId: w.ask.id, key: w.key }));
				if (targets.length)
					this.log(`card can't reach COO (${result.error}): ${targets.length} question(s) go to the owner`);
				for (const it of targets) this.releaseIfHeld(it.askId);
				return;
			}
			if (!items.length && result.ok) return;
			if (result.ok) {
				const holds = this.port.holds();
				for (const it of items) holds?.delivered(it.key, sendId);
				return;
			}
			this.cards.delete(sendId);
			if (this.routingOn() && (items.length > 0 || this.waiting().length > 0)) {
				this.log(`card not delivered (${result.error}): trying again`);
				retryLater = true;
			}
		} finally {
			for (const it of items) this.inFlight.delete(it.key);
			this.flushing = false;
			if (retryLater) this.schedule(this.opts.retryMs ?? CARD_RETRY_MS);
			else if (this.again && this.routingOn()) this.schedule(this.batchMs);
		}
	}

	private isHeld(askId: string): boolean {
		return this.port.heldAsks().some((a) => a.id === askId);
	}

	private releaseIfHeld(askId: string): boolean {
		if (!this.isHeld(askId)) return false;
		return this.port.release(askId, "safety-net").ok;
	}

	/**
	 * A turn settled with these inputs (role-replies.ts RoleTurnRecord ids). For each card among them:
	 * the COO turn that got it ended, and every question in it still held with no hold from COO goes
	 * to the owner now. Returns the ask ids let through.
	 */
	turnSettled(ids: readonly string[]): string[] {
		const released: string[] = [];
		const holds = this.port.holds();
		for (const id of ids) {
			// A stuck card survives both process restart and a changed AskHub id. The receipt's
			// durable hold key, not the old ask id, binds it to the receiving turn.
			const keys = new Set((this.cards.get(id) ?? []).map((it) => it.key));
			for (const h of holds?.list() ?? []) if (h.deliveredToCoo?.sendId === id) keys.add(h.key);
			this.cards.delete(id);
			for (const key of keys) {
				const ask = this.port.heldAsks().find((a) => this.port.holdKeyOf(a.id) === key);
				if (holds) {
					// The turn can settle before delivery's receipt returns.
					if (holds.get(key)?.deliveredToCoo === undefined) holds.delivered(key, id);
					holds.cooTurnEnded(key);
					const rec = holds.get(key);
					if (rec?.state !== "held" || holdDue(rec, this.now, holds.ok) === null) continue;
				}
				if (ask) {
					if (this.port.release(ask.id, "safety-net").ok) released.push(ask.id);
				} else {
					// Its task chat is closed: admission will show the card immediately when it returns.
					holds?.release(key, "safety-net");
				}
			}
		}
		if (released.length) this.log(`COO's turn ended with no action: ${released.length} question(s) go to the owner`);
		return released;
	}

	// -----------------------------------------------------------------------------------------------------------
	// What owner_question does

	/** Everything held for COO now, oldest first. */
	list(): HeldQuestionView[] {
		const holds = this.port.holds();
		const out: HeldQuestionView[] = [];
		for (const ask of this.port.heldAsks()) {
			const key = this.port.holdKeyOf(ask.id);
			if (!key) continue;
			const record = holds?.get(key);
			const q = this.cardQuestion(ask, key, record);
			const why = record?.holdWhy;
			out.push({
				handle: q.handle,
				ask,
				asker: q.asker,
				goesAt: q.goesAt,
				...(record?.deliveredToCoo ? { cardAt: record.deliveredToCoo.at } : {}),
				...(record?.holdUntil !== undefined ? { holdUntil: record.holdUntil } : {}),
				...(record?.holdUntil !== undefined && why ? { holdWhy: why } : {}),
			});
		}
		return out;
	}

	/** Where a handle ("oq-…") stands now. */
	where(handle: string): QuestionWhere {
		const h = handle.trim();
		for (const ask of this.port.heldAsks()) {
			const key = this.port.holdKeyOf(ask.id);
			if (key && cardHandleOf(key) === h) {
				this.handles.set(h, { askId: ask.id, key });
				const record = this.port.holds()?.get(key);
				return { at: "held", handle: h, ask, key, ...(record ? { record } : {}) };
			}
		}
		const seen = this.handles.get(h);
		const fate = seen ? this.fates.get(seen.askId) : undefined;
		if (fate?.type === "released") return { at: "owner", handle: h, by: fate.by };
		if (fate) return { at: fate.type, handle: h };
		const record = this.port
			.holds()
			?.list()
			.find((r) => cardHandleOf(r.key) === h);
		if (record?.state === "released") return { at: "owner", handle: h, by: record.releasedBy ?? "safety-net" };
		if (record?.state === "returned") return { at: "returned", handle: h };
		if (record?.state === "gone") return { at: "gone", handle: h };
		return { at: "unknown", handle: h };
	}

	/** COO lets it through to the owner, its note first. */
	release(handle: string, note: string, recommendation?: string): DeskResult {
		const where = this.where(handle);
		if (where.at !== "held") return { ok: false, error: "not held", where };
		const r = this.port.release(where.ask.id, "coo", note, recommendation);
		if (!r.ok) return { ok: false, error: r.error ?? "not let through", where: this.where(handle) };
		return { ok: true, where: this.where(handle) };
	}

	/** COO keeps it until `until` (the store caps it, renewable while still held). */
	hold(handle: string, until: number, why: string): HoldResult {
		const where = this.where(handle);
		if (where.at !== "held") return { ok: false, error: "not held", where };
		const holds = this.port.holds();
		if (!holds) return { ok: false, error: "the hold store can't be opened", where };
		const kept = holds.cooHold(where.key, until, why);
		if (kept === null) return { ok: false, error: "it is due to go to the owner now", where };
		return { ok: true, until: kept };
	}

	/** COO hands a question back to the chat that asked: its own call, not the owner's answer. */
	returnToAsker(handle: string, note: string): DeskResult {
		const where = this.where(handle);
		if (where.at !== "held") return { ok: false, error: "not held", where };
		if (where.ask.kind !== "question") return { ok: false, error: "only a question can go back", where };
		const r = this.port.returnToAsker(where.ask.id, note);
		if (!r.ok) return { ok: false, error: r.error ?? "not handed back", where: this.where(handle) };
		return { ok: true, where: this.where(handle) };
	}
}
