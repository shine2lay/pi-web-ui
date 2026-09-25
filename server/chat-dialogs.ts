/**
 * per-chat-dialogs: an extension's pop-ups (ctx.ui.select / confirm / input) belong to the chat
 * that opened them, not to the browser window that happened to open the chat.
 *
 * Before, every chat a window had opened was bound to that window's single WebUIContext. So:
 *  - a chat working in the background (pi-queue asking to approve a plan, say) popped its dialog
 *    up over whatever chat the window showed, and nothing said which chat it came from;
 *  - the page has one dialog slot, so a second dialog replaced the first on screen, and answering
 *    it closed the first too; the first agent then waited forever;
 *  - a refresh lost a waiting dialog;
 *  - a chat kept sending its dialogs to the window that first opened it, even after that window
 *    moved on or closed.
 *
 * Now each chat keeps its own waiting pop-ups here, oldest first:
 *  - The page shows a chat's oldest one only while it shows that chat. It rides in the chat's
 *    snapshot as UiState.dialog, so switching back and refreshing bring it back.
 *  - Any window showing the chat can answer it. Answers are matched by id.
 *  - The left list marks the chat "needs you" meanwhile (ConversationSummary.needsYou).
 * Everything else an extension does with ctx.ui (notify, widgets, status…) still goes to the
 * window's WebUIContext, as before.
 */
import type { UiDialog } from "./protocol.js";
import { nextDialogId } from "./webui-context.js";

/** What a page answers: the chosen option / typed text, true / false for a confirm, null = cancelled. */
export type DialogValue = string | boolean | null;

/** pi's ExtensionUIDialogOptions. */
export interface DialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

interface Waiting {
	ui: UiDialog;
	/** The session that asked. A chat can move to a new session (/new, /resume, a force reset);
	 *  what the old one asked is then moot (see cancelExcept). */
	owner: unknown;
	settle: (value: DialogValue) => void;
}

/** One chat's waiting pop-ups, oldest first. */
export class ChatDialogs {
	private readonly waiting: Waiting[] = [];

	/** onChange runs whenever a pop-up is added or goes away: push the chat's viewers a snapshot
	 *  and every window a new chat list. */
	constructor(private readonly onChange: () => void = () => {}) {}

	/** What the page shows: the oldest waiting pop-up (the same object until it goes away, so a
	 *  snapshot delta can compare by reference), or null. */
	get current(): UiDialog | null {
		return this.waiting[0]?.ui ?? null;
	}

	get size(): number {
		return this.waiting.length;
	}

	/** Ask. Resolves with the page's raw answer; null when it was cancelled, timed out or aborted. */
	open(
		kind: UiDialog["kind"],
		title: string,
		args: unknown[],
		owner: unknown,
		opts?: DialogOptions,
	): Promise<DialogValue> {
		if (opts?.signal?.aborted) return Promise.resolve(null);
		return new Promise((resolve) => {
			const ui: UiDialog = { id: nextDialogId(), kind, title, args };
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => this.answer(ui.id, null);
			this.waiting.push({
				ui,
				owner,
				settle: (value) => {
					if (timer) clearTimeout(timer);
					opts?.signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
			});
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (typeof opts?.timeout === "number" && opts.timeout > 0) {
				timer = setTimeout(() => this.answer(ui.id, null), opts.timeout);
			}
			this.changed();
		});
	}

	/** Answer one of this chat's pop-ups. False when the id isn't one of them (anymore). */
	answer(id: number, value: DialogValue): boolean {
		const at = this.waiting.findIndex((w) => w.ui.id === id);
		if (at < 0) return false;
		const [w] = this.waiting.splice(at, 1);
		w.settle(value);
		this.changed();
		return true;
	}

	/** The chat moved to a new session: cancel what any other session asked. */
	cancelExcept(owner: unknown): void {
		this.cancelWhere((w) => w.owner !== owner);
	}

	/** The chat is closing: cancel everything. */
	cancelAll(): void {
		this.cancelWhere(() => true);
	}

	private cancelWhere(pred: (w: Waiting) => boolean): void {
		const gone = this.waiting.filter(pred);
		if (gone.length === 0) return;
		for (const w of gone) this.waiting.splice(this.waiting.indexOf(w), 1);
		for (const w of gone) w.settle(null);
		this.changed();
	}

	private changed(): void {
		try {
			this.onChange();
		} catch {
			// a failed push must not break the extension's dialog
		}
	}
}

/**
 * The ctx.ui a chat's extensions get: `base` (the window's WebUIContext), except that select /
 * confirm / input are asked through the chat's own ChatDialogs. Answers come back typed the way
 * pi declares them: select gives one of the options or undefined; confirm is true only for an
 * explicit yes; input gives the text or undefined.
 */
export function chatUiContext<T extends object>(base: T, dialogs: ChatDialogs, owner: unknown): T {
	const own: Record<string, unknown> = {
		select: async (title: string, options: string[], opts?: DialogOptions) => {
			const list = Array.isArray(options) ? options.map(String) : [];
			const v = await dialogs.open("select", String(title ?? ""), [list], owner, opts);
			return typeof v === "string" && list.includes(v) ? v : undefined;
		},
		confirm: async (title: string, message: string, opts?: DialogOptions) =>
			(await dialogs.open("confirm", String(title ?? ""), [String(message ?? "")], owner, opts)) === true,
		input: async (title: string, placeholder?: string, opts?: DialogOptions) => {
			const v = await dialogs.open("input", String(title ?? ""), [placeholder ?? ""], owner, opts);
			return typeof v === "string" ? v : undefined;
		},
	};
	return new Proxy(base, {
		get(target, prop) {
			if (typeof prop === "string" && Object.prototype.hasOwnProperty.call(own, prop)) return own[prop];
			const v: unknown = Reflect.get(target, prop, target);
			return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
		},
	});
}
