/**
 * owner-question-routing (Ops #686): a COO desk on a real AskHub and a real hold store (in `dir`),
 * with a port that does what the app's router does (the hub first, the store follows) and a
 * delivery that records each card instead of sending it. No chat, no model.
 */
import { join } from "node:path";
import { vi } from "vitest";
import { type Ask, type AskEvent, AskHub, questionAsk } from "../../server/asks.js";
import { cardHandleOf } from "../../server/owner-question-card.js";
import { type CardDelivery, CooOwnerQuestionDesk, type CooDeskPort } from "../../server/owner-question-coo.js";
import { HOLD_SAFETY_NET_MS, holdKeyOfAsk, OwnerQuestionHolds } from "../../server/owner-question-holds.js";

export const T0 = Date.UTC(2026, 10, 1, 9, 0);
export const MIN = 60_000;

export function deskFixture(dir: string) {
	const s = {
		now: T0,
		on: true,
		delivery: { ok: true } as CardDelivery,
		sent: [] as Array<{ sendId: string; text: string }>,
		events: [] as AskEvent[],
		answered: vi.fn(() => ({ ok: true })),
		gate: undefined as Promise<void> | undefined,
	};
	const hub = new AskHub(() => s.now);
	const holds = new OwnerQuestionHolds(join(dir, "holds.json"), { now: () => s.now });
	const keys = new Map<string, string>();
	hub.on((ev) => s.events.push(ev));
	const port: CooDeskPort = {
		routingOn: () => s.on,
		hear: (fn) => hub.on(fn),
		heldAsks: () => hub.heldList(),
		holdKeyOf: (id) => keys.get(id),
		holds: () => holds,
		heldUntil: (id) => {
			const r = keys.get(id) ? holds.get(keys.get(id)!) : undefined;
			return r?.state === "held" ? (r.holdUntil ?? r.createdAt + HOLD_SAFETY_NET_MS) : undefined;
		},
		release: (id, by, note, rec) => {
			const r = hub.release(id, by, note, rec);
			if (r.ok) holds.release(keys.get(id)!, by, note, rec);
			return r;
		},
		returnToAsker: (id, note) => {
			const r = hub.returnToAsker(id, note);
			if (r.ok) holds.returned(keys.get(id)!, note);
			return r;
		},
		askerOf: () => ({ role: { id: "design", title: "Design" }, chat: "home" }),
		deliver: async (compose, sendId) => {
			if (!s.delivery.ok && s.delivery.final) return s.delivery;
			// Written when it goes, then on its way until COO's chat takes it.
			const text = compose();
			if (s.gate) await s.gate;
			if (s.delivery.ok && text !== undefined) s.sent.push({ sendId, text });
			return s.delivery;
		},
		now: () => s.now,
		log: () => {},
		tz: "UTC",
	};
	const desk = new CooOwnerQuestionDesk(port);
	desk.start();
	/** Holds `ask` for COO as the router would; returns its tag ("oq-…"). */
	const hold = (ask: Ask, reason: "owner-away" | "queued-work" = "owner-away"): string => {
		const key = holdKeyOfAsk(ask.id);
		holds.admit(key, ask.kind, reason);
		keys.set(ask.id, key);
		hub.add(ask, s.answered, { to: "coo", reason });
		return cardHandleOf(key);
	};
	return { s, hub, holds, keys, desk, hold };
}

export const portQuestion = (id: string, text = "Which port?") =>
	questionAsk(id, [{ id: "a", question: text, options: [{ label: "8080" }, { label: "8090" }] }], {}, T0);
