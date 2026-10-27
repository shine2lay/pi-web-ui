/** W2 socket integration: window before backpressure, and flush ready before session initialization. */
import type { ClientMessage, TerminalInfo, TerminalViewReply } from "./protocol.js";
import {
	historyWindowAt,
	MAX_CACHED_CONVERSATIONS,
	MessageWindowTap,
	readMessageWindowConfig,
	type MessageWindowConfig,
} from "./message-window.js";

export interface EarlierPageRequest {
	conversationId?: string;
	beforeIndex?: number;
	limit?: number;
	count?: number;
	all?: boolean;
}

interface HistoryFrame {
	type: string;
	conversationId?: string;
	sessionId?: string;
	start?: number;
	historyStart?: number;
	messages?: unknown[];
	appended?: unknown[];
	reuse?: { count?: number };
	state?: {
		conversationId?: string;
		sessionId?: string;
		messagesStart?: number;
		messages?: unknown[];
	};
}

/** Keep the existing sender's completion callback even when the tap clones a frame. Session UUIDs
 * are not conversation slots: both identities must match before a request can use a cached page.
 * A requested engine fallback is normalized back into the request-bound client protocol. */
export function createHistoryTransport<M extends { type: string }>(
	sendRaw: (msg: M, onSent?: () => void) => void,
	config: MessageWindowConfig = readMessageWindowConfig(),
) {
	let completion: (() => void) | undefined;
	let conversationId = "";
	let historyStart = 0;
	let servingTap = false;
	const bindings = new Map<string, { sessionId: string; total: number }>();
	let fallback: { conversationId: string; sessionId: string; before: number } | undefined;

	const output = (msg: M) => {
		const m = msg as unknown as HistoryFrame;
		let outgoing = msg;
		if (m.type === "snapshot" && m.state?.conversationId) {
			historyStart = m.state.messagesStart ?? 0;
		} else if (m.type === "earlier_messages" && servingTap) {
			// Only the synchronous cache read may borrow its snapshot's UUID. Never relabel a delayed
			// engine response with the session that happens to occupy the slot when it arrives.
			const binding = bindings.get(m.conversationId ?? "");
			if (binding) outgoing = { ...msg, sessionId: binding.sessionId };
		} else if (
			m.type === "older_messages" &&
			fallback &&
			m.conversationId === fallback.conversationId &&
			m.sessionId === fallback.sessionId &&
			typeof m.start === "number" &&
			Array.isArray(m.messages) &&
			m.start + m.messages.length === fallback.before
		) {
			const binding = bindings.get(fallback.conversationId);
			outgoing = {
				...msg,
				type: "earlier_messages",
				historyStart: m.start,
				historyTotal: binding?.total ?? fallback.before,
				historyWindow: historyWindowAt(m.start),
			};
			fallback = undefined;
		}
		const sent = outgoing as unknown as HistoryFrame;
		if (
			(sent.type === "older_messages" || sent.type === "earlier_messages") &&
			sent.conversationId === conversationId
		) {
			historyStart = sent.start ?? sent.historyStart ?? historyStart;
		}
		sendRaw(outgoing, completion);
	};
	const makeTap = () => new MessageWindowTap<M>(output, config);
	let tap = makeTap();

	return {
		send(msg: M, onSent?: () => void): void {
			const m = msg as unknown as HistoryFrame;
			if (m.type === "snapshot" && m.state?.conversationId && Array.isArray(m.state.messages)) {
				const id = m.state.conversationId;
				const sessionId = m.state.sessionId ?? "";
				const previous = bindings.get(id);
				if (previous && previous.sessionId !== sessionId) {
					// A rewritten slot must not inherit old cached messages or its previous window cursor.
					tap = makeTap();
					bindings.clear();
				}
				if (conversationId !== id || previous?.sessionId !== sessionId) fallback = undefined;
				conversationId = id;
				const base = m.state.messagesStart ?? 0;
				const reused = m.reuse?.count ?? 0;
				bindings.delete(id);
				bindings.set(id, { sessionId, total: base + reused + m.state.messages.length });
				while (bindings.size > MAX_CACHED_CONVERSATIONS) bindings.delete(bindings.keys().next().value!);
			} else if (m.type === "snapshot_delta") {
				const binding = bindings.get(m.conversationId ?? "");
				if (binding && m.state?.sessionId !== undefined && m.state.sessionId !== binding.sessionId) return;
				if (binding && Array.isArray(m.appended)) binding.total += m.appended.length;
			} else if (m.type === "older_messages" && m.sessionId !== undefined) {
				const binding = bindings.get(m.conversationId ?? "");
				if (binding && binding.sessionId !== m.sessionId) return;
			}
			const previous = completion;
			completion = onSent;
			try {
				tap.accept(msg);
			} finally {
				completion = previous;
			}
		},
		loadEarlier(
			req: EarlierPageRequest,
			loadOlder: (before: number, count?: number) => void,
			activeSessionId?: string,
		): void {
			const binding = bindings.get(conversationId);
			if (!binding || (req.conversationId && req.conversationId !== conversationId)) return;
			if (activeSessionId !== undefined && activeSessionId !== binding.sessionId) return;
			if (fallback) return;
			servingTap = true;
			try {
				if (tap.handleRequest({ ...req, conversationId })) return;
			} finally {
				servingTap = false;
			}
			const before =
				typeof req.beforeIndex === "number" && Number.isFinite(req.beforeIndex)
					? Math.max(0, Math.floor(req.beforeIndex))
					: historyStart;
			if (before <= 0) return;
			const requested = req.limit ?? req.count;
			const count = req.all
				? before
				: typeof requested === "number" && Number.isFinite(requested)
					? Math.max(1, Math.floor(requested))
					: undefined;
			fallback = { conversationId, sessionId: binding.sessionId, before };
			try {
				loadOlder(before, count);
			} catch (error) {
				fallback = undefined;
				throw error;
			}
		},
	};
}

const IDENTITY_OPERATION_REPLIES = new Set([
	"identity_file",
	"identity_file_saved",
	"identity_draft",
	"identity_draft_done",
	"identity_note",
	"identity_note_saved",
]);

/** Correlation only: no execution/persistence assertion and no inferred/current operation ID.
 * Inherited/accessor fields are not parsed-JSON request metadata. Legacy replies stay untouched. */
export function correlateIdentityReply<T extends { type: string }>(request: object, reply: T): T & { reqId?: string } {
	const reqId: unknown = Object.getOwnPropertyDescriptor(request, "reqId")?.value;
	return typeof reqId === "string" && IDENTITY_OPERATION_REPLIES.has(reply.type) ? { ...reply, reqId } : reply;
}

interface TerminalAttachHost {
	sessionIdForConversation?(conversationId: string): string;
	getTerminalManager(conversationId: string):
		| {
				attachExistingView?(
					id: string,
					cols: number,
					rows: number,
				): { terminal: TerminalInfo; data: string; offset: number } | null;
		  }
		| undefined;
}

/** Capture only an already-existing original target; never use openView/create
 * as an attach fallback. The returned replay is for the requesting view only. */
export function terminalViewReply(
	host: TerminalAttachHost,
	request: Extract<ClientMessage, { type: "terminal_attach" }>,
): TerminalViewReply {
	const text = (value: unknown) => (typeof value === "string" ? value : "");
	const base = {
		type: "terminal_view" as const,
		reqId: text(request.reqId),
		viewId: text(request.viewId),
		conversationId: text(request.conversationId),
		sessionId: text(request.sessionId),
		terminalId: text(request.terminalId),
	};
	const unavailable = (reason: Extract<TerminalViewReply, { available: false }>["reason"]): TerminalViewReply => ({
		...base,
		available: false,
		reason,
	});
	if (
		![base.reqId, base.viewId, base.conversationId, base.sessionId, base.terminalId].every((value) => value.trim()) ||
		!Number.isFinite(request.cols) ||
		!Number.isFinite(request.rows)
	)
		return unavailable("invalid");
	try {
		if (!host.sessionIdForConversation) return unavailable("unsupported");
		const sessionId = host.sessionIdForConversation(base.conversationId);
		if (!sessionId || sessionId !== base.sessionId) return unavailable("target-changed");
		const manager = host.getTerminalManager(base.conversationId);
		if (!manager?.attachExistingView) return unavailable("unsupported");
		const snapshot = manager.attachExistingView(base.terminalId, request.cols, request.rows);
		if (
			host.sessionIdForConversation(base.conversationId) !== sessionId ||
			host.getTerminalManager(base.conversationId) !== manager
		)
			return unavailable("target-changed");
		if (!snapshot) return unavailable("missing");
		if (
			snapshot.terminal.id !== base.terminalId ||
			typeof snapshot.data !== "string" ||
			!Number.isSafeInteger(snapshot.offset) ||
			snapshot.offset < 0
		)
			return unavailable("failed");
		return { ...base, available: true, terminal: snapshot.terminal, data: snapshot.data, offset: snapshot.offset };
	} catch {
		return unavailable("failed");
	}
}

/** A queued ready frame isn't a completed handshake: synchronous SDK scans in attach can still hold
 * its bytes on the server thread. Start attach only once the frame has left, then yield one I/O turn.
 * Closing during that gap must not create a session or leak a send sink. */
export function attachAfterReady<T>(
	sendReady: (onSent: () => void) => void,
	attach: () => Promise<T>,
	isClosed: () => boolean,
): Promise<T | undefined> {
	return new Promise<void>((resolve) => sendReady(resolve))
		.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
		.then(() => (isClosed() ? undefined : attach()));
}
