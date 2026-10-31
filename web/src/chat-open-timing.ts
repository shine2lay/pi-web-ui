/**
 * chat-open-timing (Ops #690): the page's marks for one chat open, sent to the server as one
 * `chat_open` report (server/chat-open-timing.ts joins it with the server's marks into a row of the
 * connection log). Numbers, flags and fixed words only: never a title, path or message.
 *
 * Marks, in ms from the input that started the open (its event time, so a busy page counts too):
 *   startToRequestMs  the switch request was sent;
 *   toFirstFrameMs    the first frame carrying the chat (the server's preview or the chat's snapshot);
 *   toPaintMs         the frame after the list first showed what the server sent (the owner's "open");
 *   toCachePaintMs    the frame after the list showed the page's own cached copy (may be out of date);
 *   toDoneMs          switch_done / switch_failed arrived.
 * A report goes once the server said done and the list painted; at once when the open failed, another
 * open replaced it ("left") or the tab went hidden ("hidden"). A closed socket drops the open (the
 * server writes its own half).
 *
 * ChatOpenTimer is pure: the clock, the paint wait, visibility and the device come in as hooks, so
 * tests drive it with fake ones (tests/unit/chat-open-timing.test.ts).
 */
import { isTouchFirstDevice, type TouchEnv } from "./touch-device";
import { sameSwitchTarget, switchTargetReached } from "./switch-pending";
import type { ChatOpenReport, SwitchTarget } from "./types";

/** Which kind of screen the open happened on: phones and tablets (touch-first) vs the rest. */
export function deviceClass(env: TouchEnv): ChatOpenReport["device"] {
	return isTouchFirstDevice(env) ? "phone" : "desktop";
}

/** A test browser, not a person: its opens stay out of the owner's numbers. */
export function automatedBrowser(env: { webdriver?: boolean; userAgent?: string }): boolean {
	return env.webdriver === true || /HeadlessChrome/i.test(env.userAgent ?? "");
}

const INPUT_EVENTS: Record<string, ChatOpenReport["via"]> = {
	click: "click",
	pointerup: "click",
	pointerdown: "click",
	mouseup: "click",
	mousedown: "click",
	touchend: "click",
	keydown: "key",
	keyup: "key",
	submit: "key",
	popstate: "nav",
	hashchange: "nav",
};
/** An input older than this didn't start the open (a long-held event, or a stale global). */
const MAX_INPUT_AGE_MS = 10_000;

/** When the open started: the input event being handled (`window.event`), else now ("auto"). */
export function openStartOf(
	ev: { type?: string; timeStamp?: number } | null | undefined,
	now: number,
): { start: number; via: ChatOpenReport["via"] } {
	const via = ev?.type ? INPUT_EVENTS[ev.type] : undefined;
	const ts = ev?.timeStamp;
	if (via && typeof ts === "number" && Number.isFinite(ts) && ts > 0 && ts <= now && now - ts < MAX_INPUT_AGE_MS)
		return { start: ts, via };
	return { start: now, via: "auto" };
}

export interface ChatOpenHooks {
	/** Same clock as input event times (performance.now() in a browser). */
	now(): number;
	/** Run after the next frame has been painted. */
	afterPaint(fn: () => void): void;
	visible(): boolean;
	device(): ChatOpenReport["device"];
	automated(): boolean;
	/** The input being handled right now, if any (window.event). */
	currentEvent(): { type?: string; timeStamp?: number } | null | undefined;
	/** A fresh random id (hex). */
	newId(): string;
}

interface OpenMarks {
	id: string;
	target: SwitchTarget;
	start: number;
	via: ChatOpenReport["via"];
	cached: boolean;
	visible: boolean;
	requestAt: number | null;
	firstFrameAt: number | null;
	/** A server frame of the chat arrived: the next list commit shows it. */
	fresh: boolean;
	paintWaiting: boolean;
	paintAt: number | null;
	cachePaintWaiting: boolean;
	cachePaintAt: number | null;
	doneAt: number | null;
	ok: boolean | null;
}

export class ChatOpenTimer {
	private readonly hooks: ChatOpenHooks;
	private cur: OpenMarks | null = null;
	private report: ((r: ChatOpenReport) => void) | null = null;

	constructor(hooks: ChatOpenHooks) {
		this.hooks = hooks;
	}

	/** Where reports go (use-chat: the socket, when the server takes them). */
	setReporter(fn: ((r: ChatOpenReport) => void) | null): void {
		this.report = fn;
	}

	/** A switch request is about to go: returns the id to send with it. */
	begin(target: SwitchTarget, cached: boolean): string {
		if (this.cur) this.finish("left");
		const now = this.hooks.now();
		const { start, via } = openStartOf(this.hooks.currentEvent(), now);
		const id = this.hooks.newId();
		this.cur = {
			id,
			target,
			start,
			via,
			cached,
			visible: this.hooks.visible(),
			requestAt: null,
			firstFrameAt: null,
			fresh: false,
			paintWaiting: false,
			paintAt: null,
			cachePaintWaiting: false,
			cachePaintAt: null,
			doneAt: null,
			ok: null,
		};
		return id;
	}

	/** The request has been handed to the socket. */
	requested(): void {
		if (this.cur && this.cur.requestAt === null) this.cur.requestAt = this.hooks.now();
	}

	/** switch_preview arrived. */
	preview(target: SwitchTarget): void {
		const o = this.cur;
		if (!o || !sameSwitchTarget(o.target, target)) return;
		this.freshFrame(o);
	}

	/** A snapshot arrived (any: only one showing the chat being opened counts). */
	snapshot(state: { sessionFile?: string; conversationId: string }): void {
		const o = this.cur;
		if (!o || o.doneAt !== null || !switchTargetReached(o.target, state)) return;
		this.freshFrame(o);
	}

	/** switch_done (ok) or switch_failed arrived. */
	done(target: SwitchTarget, ok: boolean): void {
		const o = this.cur;
		if (!o || o.doneAt !== null || !sameSwitchTarget(o.target, target)) return;
		o.doneAt = this.hooks.now();
		o.ok = ok;
		if (!ok) {
			this.finish("failed");
			return;
		}
		// The list now shows the server's chat; if no commit follows (nothing changed on screen), the next
		// painted frame is when it showed.
		o.fresh = true;
		this.hooks.afterPaint(() => {
			if (this.cur !== o) return;
			if (o.paintAt === null && !o.paintWaiting) o.paintAt = this.hooks.now();
			this.maybeFinish(o);
		});
	}

	/** The message list committed what it shows (App: a layout effect on the list's state). */
	listCommitted(): void {
		const o = this.cur;
		if (!o) return;
		if (o.fresh && o.paintAt === null && !o.paintWaiting) {
			o.paintWaiting = true;
			this.hooks.afterPaint(() => {
				if (this.cur !== o) return;
				o.paintWaiting = false;
				o.paintAt = this.hooks.now();
				this.maybeFinish(o);
			});
		} else if (!o.fresh && o.cached && o.cachePaintAt === null && !o.cachePaintWaiting) {
			o.cachePaintWaiting = true;
			this.hooks.afterPaint(() => {
				if (this.cur !== o) return;
				o.cachePaintWaiting = false;
				o.cachePaintAt = this.hooks.now();
			});
		}
	}

	/** The tab went hidden: what follows would count hidden time. */
	hidden(): void {
		if (this.cur) {
			this.cur.visible = false;
			this.finish("hidden");
		}
	}

	/** The socket closed: the open is dropped (the server writes its half as "noreport"). */
	reset(): void {
		this.cur = null;
	}

	private freshFrame(o: OpenMarks): void {
		if (o.firstFrameAt === null) o.firstFrameAt = this.hooks.now();
		o.fresh = true;
	}

	private maybeFinish(o: OpenMarks): void {
		if (o.doneAt !== null && o.paintAt !== null) this.finish("done");
	}

	private finish(outcome: ChatOpenReport["outcome"]): void {
		const o = this.cur;
		if (!o) return;
		this.cur = null;
		const since = (t: number | null): number | undefined =>
			t === null ? undefined : Math.max(0, Math.round(t - o.start));
		const r: ChatOpenReport = {
			type: "chat_open",
			open: o.id,
			outcome,
			via: o.via,
			device: this.hooks.device(),
			visible: o.visible && this.hooks.visible(),
			cached: o.cached,
			automated: this.hooks.automated(),
		};
		const marks: [keyof ChatOpenReport, number | undefined][] = [
			["startToRequestMs", since(o.requestAt)],
			["toFirstFrameMs", since(o.firstFrameAt)],
			["toPaintMs", since(o.paintAt)],
			["toCachePaintMs", since(o.cachePaintAt)],
			["toDoneMs", since(o.doneAt)],
		];
		for (const [k, v] of marks) if (v !== undefined) (r as unknown as Record<string, number>)[k] = v;
		this.report?.(r);
	}
}

function browserHooks(): ChatOpenHooks {
	return {
		now: () => performance.now(),
		afterPaint: (fn) => requestAnimationFrame(() => setTimeout(fn, 0)),
		visible: () => typeof document === "undefined" || document.visibilityState === "visible",
		device: () =>
			typeof window === "undefined" || typeof window.matchMedia !== "function"
				? "desktop"
				: deviceClass({
						query: (media) => window.matchMedia(media).matches,
						userAgent: navigator.userAgent,
						maxTouchPoints: navigator.maxTouchPoints,
					}),
		automated: () =>
			typeof navigator !== "undefined" &&
			automatedBrowser({ webdriver: navigator.webdriver, userAgent: navigator.userAgent }),
		currentEvent: () => (typeof window === "undefined" ? null : (window.event as Event | undefined)),
		newId: () => {
			const b = new Uint8Array(8);
			crypto.getRandomValues(b);
			return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
		},
	};
}

/** The page's one timer (use-chat feeds it frames, App feeds it list commits). */
export const chatOpenTimer = new ChatOpenTimer(browserHooks());
