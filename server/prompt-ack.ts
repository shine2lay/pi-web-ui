/**
 * optimistic-send: receipts for prompts that carry a window-made id (`prompt_ack` in protocol.ts).
 *
 * The window draws a message the moment you press Send (faded, "Sending…") and keeps that copy
 * until the server answers with one `prompt_ack` carrying the same id: ok once the snapshot that
 * holds the message has gone out, not ok (with a short reason) when the message never reached
 * the chat. Two small pieces, shared by both engines:
 *
 *  - PromptReceipt: one send's answer. The first answer wins and later ones do nothing, so every
 *    exit of prompt() can simply answer without checking whether an earlier step already did.
 *  - PromptIdLedger: what the server remembers about ids (one per server, ids are random). A Retry
 *    that sends an id again never adds the message twice: an id that is still being handled waits
 *    for its first answer (and the window that sent it again gets that answer too), an id that
 *    already reached the chat is acknowledged again at once, and only a refused or unknown id runs.
 */

/** The reason given for an id the server has no record of. */
export const NOT_RECEIVED_REASON =
	"The server didn't get this message (the connection dropped or the server restarted).";

export interface PromptAckMsg {
	type: "prompt_ack";
	id: string;
	conversationId: string;
	ok: boolean;
	reason?: string;
	/** ok only: the rev of the window's latest snapshot, which shows the message (see protocol.ts). */
	rev?: number;
}

/** Sends one ack to one window (its own sockets only). */
export type PromptAckDeliver = (msg: PromptAckMsg) => void;

export class PromptReceipt {
	private answeredWith: boolean | undefined;

	constructor(
		/** undefined = the prompt carried no id (plugins, old pages): answering does nothing. */
		readonly id: string | undefined,
		readonly conversationId: string,
		private readonly deliver: PromptAckDeliver,
		private readonly onAnswer?: (msg: PromptAckMsg) => void,
	) {}

	/** A receipt for a prompt without an id: every answer is a no-op. */
	static none(conversationId = ""): PromptReceipt {
		return new PromptReceipt(undefined, conversationId, () => {});
	}

	get answered(): boolean {
		return this.answeredWith !== undefined;
	}

	/** The message is in the chat (or in its waiting queue), or the server handled it on purpose. */
	ok(): void {
		this.answer(true);
	}

	/** The message did not reach the chat. `reason` is a short English explanation. */
	fail(reason: string): void {
		this.answer(false, reason);
	}

	private answer(ok: boolean, reason?: string): void {
		if (this.answeredWith !== undefined) return;
		this.answeredWith = ok;
		if (this.id === undefined) return;
		const msg: PromptAckMsg = {
			type: "prompt_ack",
			id: this.id,
			conversationId: this.conversationId,
			ok,
			...(!ok && reason ? { reason } : {}),
		};
		try {
			this.deliver(msg);
		} catch {
			// A window that went away can't take its ack; the ledger below still records the outcome.
		}
		this.onAnswer?.(msg);
	}
}

interface LedgerEntry {
	state: "pending" | "ok";
	conversationId: string;
	/** Windows that sent the id again while it was still being handled. */
	waiters: PromptAckDeliver[];
}

export class PromptIdLedger {
	private readonly ids = new Map<string, LedgerEntry>();

	constructor(private readonly cap = 500) {}

	/**
	 * A prompt arrived. Returns the receipt to answer it with, or null when it must NOT run because
	 * the same id was already sent: still being handled (this window will get the first answer too)
	 * or already in the chat (acknowledged again right here).
	 */
	begin(id: string | undefined, conversationId: string, deliver: PromptAckDeliver): PromptReceipt | null {
		if (!id) return new PromptReceipt(undefined, conversationId, deliver);
		const known = this.ids.get(id);
		if (known?.state === "pending") {
			known.waiters.push(deliver);
			return null;
		}
		if (known?.state === "ok") {
			try {
				deliver({ type: "prompt_ack", id, conversationId: known.conversationId, ok: true });
			} catch {
				// see PromptReceipt.answer
			}
			return null;
		}
		const entry: LedgerEntry = { state: "pending", conversationId, waiters: [] };
		this.ids.set(id, entry);
		this.trim();
		return new PromptReceipt(id, conversationId, deliver, (msg) => {
			const waiters = entry.waiters.splice(0);
			if (msg.ok) entry.state = "ok";
			// A refused id is forgotten, so a Retry with the same id runs again.
			else if (this.ids.get(id) === entry) this.ids.delete(id);
			for (const w of waiters) {
				try {
					w(msg);
				} catch {
					// see PromptReceipt.answer
				}
			}
		});
	}

	/**
	 * A window that reconnected or reloaded asks about an id it still shows as "Sending" (the
	 * `prompt_status` message). It gets one answer: ok at once when the id reached the chat, the
	 * first answer later when the id is still being handled, and not ok when the server has no
	 * record of it (never arrived, refused, or the server restarted since).
	 */
	status(id: string, deliver: PromptAckDeliver): void {
		const known = this.ids.get(id);
		if (known?.state === "pending") {
			known.waiters.push(deliver);
			return;
		}
		try {
			deliver(
				known?.state === "ok"
					? { type: "prompt_ack", id, conversationId: known.conversationId, ok: true }
					: { type: "prompt_ack", id, conversationId: "", ok: false, reason: NOT_RECEIVED_REASON },
			);
		} catch {
			// see PromptReceipt.answer
		}
	}

	/** For tests and diagnostics: what the ledger knows about an id. */
	stateOf(id: string): "pending" | "ok" | undefined {
		return this.ids.get(id)?.state;
	}

	get size(): number {
		return this.ids.size;
	}

	/** Keeps the ledger small: drops the oldest answered ids first, and a pending one only if all are pending. */
	private trim(): void {
		while (this.ids.size > this.cap) {
			let victim: string | undefined;
			for (const [key, value] of this.ids) {
				if (value.state === "ok") {
					victim = key;
					break;
				}
			}
			victim ??= this.ids.keys().next().value;
			if (victim === undefined) return;
			this.ids.delete(victim);
		}
	}
}

/** The server's one ledger (both engines, every window). */
export const promptIds = new PromptIdLedger();

/** One prompt's place in a chat's line (the pi engine's Conversation.promptAdmission). */
export interface PromptAdmission {
	/** Resolves once every earlier prompt to the chat has been admitted, or after the safety limit so a
	 *  lost release can't hold the chat up for good. */
	ready: Promise<void>;
	/** This prompt has been admitted (started, queued or refused): the next one may go. Calling it
	 *  again does nothing. */
	release(): void;
}

/**
 * Takes the next place in a chat's line. Call it before the first await of prompt(), so the places
 * follow the order the messages arrived in; await `ready` just before handing the text to pi.
 *
 * Why a line: pi only marks a chat as running once the add-ons' "before the AI starts" step is done
 * (that can take seconds). A second message sent during that step used to take the "start a run"
 * path too and fail with "Agent is already processing". Waiting for the first one's admission makes
 * it see the running chat and join the queue (steer / follow-up) as it would a moment later.
 *
 * Until its release the message is on its way: `holder.sendsInFlight` counts it, so the chat counts
 * as busy (switching away keeps it open; see AgentService.displaceActive).
 */
export function takePromptAdmission(
	holder: { promptAdmission?: Promise<void>; sendsInFlight?: number },
	maxWaitMs = 5 * 60_000,
): PromptAdmission {
	const prev = holder.promptAdmission ?? Promise.resolve();
	let released = false;
	let releaseMine!: () => void;
	const mine = new Promise<void>((resolve) => {
		releaseMine = () => {
			if (released) return;
			released = true;
			holder.sendsInFlight = Math.max(0, (holder.sendsInFlight ?? 1) - 1);
			resolve();
		};
	});
	holder.sendsInFlight = (holder.sendsInFlight ?? 0) + 1;
	holder.promptAdmission = prev.then(() => mine);
	const ready = new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, maxWaitMs);
		timer.unref?.();
		void prev.then(() => {
			clearTimeout(timer);
			resolve();
		});
	});
	return { ready, release: () => releaseMine() };
}
