// ---------------------------------------------------------------------------
// owner-asks-push.ts — the waiting-questions bell's live list in every window (Ops #1090, Shine 2026-11-25 m104486 +
// m104524: "We need a way to see questions waiting for us tho" / "Top bar maybe a notification icon ?").
// ---------------------------------------------------------------------------
// ClientSession hands this its windows; this keeps each one's bell current: the window owner's whole list
// (owner-asks-feed.ts projectOwnerAsksForViewer) at connect, and again after every change to the list of asks (one
// push per window per tick, none when its list didn't change), and the "?" on its saved-chat rows. It also answers
// the bell's open / answer commands as the window's owner. Never another owner's ask, nor one held for COO: the feed
// module filters every list, open and answer by the window's viewer.
// ---------------------------------------------------------------------------

import type { Ask, AskHub } from "./asks.js";
import {
	answerOwnerAskForViewer,
	openOwnerAskForViewer,
	projectOwnerAsksForViewer,
	sessionsWithQuestionsFor,
} from "./owner-asks-feed.js";
import type { OwnerViewer } from "./owner-requester.js";
import type { ServerMessage, SessionSummary } from "./protocol.js";

/** What the bell needs from the host (ClientSession) about its windows `W` and the asks. */
export interface OwnerAsksHost<W extends object> {
	hub: AskHub;
	/** Every window of this process (closed ones too: `live` says which can take a push now). */
	windows(): Iterable<W>;
	live(w: W): boolean;
	viewerOf(w: W): OwnerViewer;
	/** To this window only (never fanned out to another window). */
	send(w: W, msg: ServerMessage): void;
	/** The saved-chat rows the window was last sent, when it asked for them; its "?" marks follow the asks. */
	savedRows(w: W): readonly SessionSummary[] | undefined;
	/** Kept for later on its card (Later / ✕ / Esc). */
	later(askId: string): boolean;
	/** The department whose home or task chat asked, when one did. */
	roleOf(ask: Ask): { id: string; title: string } | undefined;
}

/** The marks a window's saved rows carry, as one string (the files with a "?"). */
const marksOf = (rows: readonly SessionSummary[]): string =>
	rows
		.filter((r) => r.hasQuestion)
		.map((r) => r.path)
		.join("\u0001");

export class OwnerAsksPush<W extends object> {
	/** Per window: the list it was last sent, and its saved rows' marks. */
	private readonly sentList = new WeakMap<W, string>();
	private readonly sentMarks = new WeakMap<W, string>();
	private scheduled = false;

	constructor(private readonly host: OwnerAsksHost<W>) {}

	/** Hear the list of asks (as a bookkeeper: it doesn't count as someone who can answer). Returns the way to stop. */
	start(): () => void {
		return this.host.hub.observe((ev) => {
			if (ev.type !== "held") this.schedule(); // held: on no bell until COO lets it through ("released")
		});
	}

	/** Every live window's bell once this tick's changes are done (an ask settles, then its card ends, ...). */
	schedule(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		setImmediate(() => {
			this.scheduled = false;
			this.pushAll();
		}).unref?.();
	}

	private pushAll(): void {
		const asks = this.host.hub.list();
		for (const w of this.host.windows()) {
			try {
				if (this.host.live(w)) this.push(w, asks, false);
			} catch (err) {
				console.warn(`[owner-asks] a window's bell wasn't updated: ${(err as Error).message}`);
			}
		}
	}

	/** One window's bell now, sent even when unchanged (a window that just connected has none). */
	pushTo(w: W): void {
		this.push(w, this.host.hub.list(), true);
	}

	private push(w: W, asks: readonly Ask[], force: boolean): void {
		const viewer = this.host.viewerOf(w);
		const list = projectOwnerAsksForViewer(asks, viewer, {
			later: (ask) => this.host.later(ask.id),
			roleOf: (_file, ask) => this.host.roleOf(ask),
		});
		const sig = JSON.stringify(list);
		if (force || this.sentList.get(w) !== sig) {
			this.sentList.set(w, sig);
			this.host.send(w, { type: "owner_asks", asks: list });
		}
		const rows = this.host.savedRows(w);
		if (!rows?.length) return;
		const marked = sessionsWithQuestionsFor(rows, asks, viewer);
		if (this.sentMarks.get(w) === marksOf(marked)) return;
		this.sentMarks.set(w, marksOf(marked));
		this.host.send(w, { type: "sessions", sessions: marked });
	}

	/** The saved-chat rows for window `w`, each marked whether a question waits on its owner there. */
	sessionsMessage(w: W, rows: readonly SessionSummary[]): ServerMessage {
		const marked = sessionsWithQuestionsFor(rows, this.host.hub.list(), this.host.viewerOf(w));
		this.sentMarks.set(w, marksOf(marked));
		return { type: "sessions", sessions: marked };
	}

	/** The bell's Answer dialog opens `askId` (-> owner_ask). */
	open(w: W, reqId: unknown, askId: unknown): ServerMessage {
		const id = reqIdOf(reqId);
		const res = openOwnerAskForViewer(this.host.hub, askId, this.host.viewerOf(w));
		return res.ok
			? { type: "owner_ask", reqId: id, ok: true, ask: res.ask }
			: { type: "owner_ask", reqId: id, ok: false, error: res.error };
	}

	/** The bell's Answer dialog sends (-> owner_ask_result), answered as the window's owner. */
	async answer(w: W, reqId: unknown, askId: unknown, revision: unknown, answers: unknown): Promise<ServerMessage> {
		const id = reqIdOf(reqId);
		try {
			const res = await answerOwnerAskForViewer(this.host.hub, askId, revision, answers, this.host.viewerOf(w));
			return res.ok
				? { type: "owner_ask_result", reqId: id, ok: true }
				: { type: "owner_ask_result", reqId: id, ok: false, error: res.error ?? "not sent" };
		} catch (err) {
			return { type: "owner_ask_result", reqId: id, ok: false, error: (err as Error).message || "not sent" };
		}
	}
}

const reqIdOf = (reqId: unknown): string => (typeof reqId === "string" ? reqId.slice(0, 120) : "");
