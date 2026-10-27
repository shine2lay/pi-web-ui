/** Actual socket/target bridge for the document recovery owner. No React state,
 * live transport, store or lease is created merely by importing this module. */
import { recoveryUsesSessionTarget } from "../../server/recovery-scope";
import { captureRecoveryMessage, type AdmissionBinding, type AdmissionContext } from "./recovery-admission";
import { nativeRecoveryClient, recoveryIdentityKey } from "./recovery-client";
import { isRecoveryEligible } from "./recovery-policy";
import type { PreparedIdentity, PreparedRecoveryWork } from "./pending-recovery-coordinator";
import { newPromptId, type PendingSend } from "./pending-sends";
import { sameSwitchTarget } from "./switch-pending";
import type {
	ClientMessage,
	CommandDispositionMsg,
	PromptAttachment,
	ServerMessage,
	SwitchTarget,
	UiState,
} from "./types";
import type { TaskQueueAnswerBinding, TaskQueueAnswerRequest } from "./components/TaskQueuePanel";

export interface ReferenceVerifierDeps {
	clientId(): string;
	conversations(): readonly { id: string }[];
	activeSessionId(): string | undefined;
	fetchUrl(url: string): Promise<{ ok: boolean; arrayBuffer(): Promise<ArrayBuffer> }>;
	withToken?(url: string): string;
	isPageGranted?(originOrUrl: string, sessionId: string): boolean;
}

export function createReferenceVerifier(deps: ReferenceVerifierDeps) {
	const wrap = (url: string) => (deps.withToken ? deps.withToken(url) : url);
	return async (attachment: PromptAttachment, pending: PendingSend): Promise<boolean> => {
		if (!pending?.sessionId || typeof pending.sessionId !== "string") return false;
		if ([attachment.path, attachment.uploadPath, attachment.imageUrl].some((x) => x?.startsWith("blob:"))) {
			return false;
		}
		if (attachment.imageData !== undefined || attachment.fileData !== undefined) return true;
		if (!isRecoveryEligible({ type: "prompt", text: "verify", attachments: [attachment] })) return false;
		try {
			if (attachment.imageUrl !== undefined) {
				const res = await deps.fetchUrl(wrap(attachment.imageUrl));
				if (!res.ok) return false;
				const bytes = await res.arrayBuffer();
				if (bytes.byteLength <= 0) return false;
				if (Number.isFinite(attachment.size) && attachment.size! >= 0 && bytes.byteLength !== attachment.size) {
					return false;
				}
				return true;
			}
			if (attachment.uploadPath !== undefined) {
				if (!attachment.uploadPath.trim() || attachment.uploadPath.split(/[\\/]+/).includes("..")) return false;
				const url = `/api/file?download=1&clientId=${encodeURIComponent(deps.clientId())}&path=${encodeURIComponent(attachment.uploadPath)}`;
				const res = await deps.fetchUrl(wrap(url));
				if (!res.ok) return false;
				const bytes = await res.arrayBuffer();
				if (bytes.byteLength <= 0) return false;
				if (Number.isFinite(attachment.size) && attachment.size! >= 0 && bytes.byteLength !== attachment.size) {
					return false;
				}
				return true;
			}
			if (attachment.mode === "conversation") {
				if (deps.activeSessionId() !== pending.sessionId) return false;
				if (typeof attachment.conversationId === "string" && attachment.conversationId.trim()) {
					const targetId = attachment.conversationId.trim();
					return deps.conversations().some((c) => c.id === targetId);
				}
				if (typeof attachment.sessionPath === "string" && attachment.sessionPath.trim()) {
					const sp = attachment.sessionPath.trim();
					if (sp.split(/[\\/]+/).includes("..")) return false;
					const url = `/api/file?download=1&clientId=${encodeURIComponent(deps.clientId())}&path=${encodeURIComponent(sp)}`;
					const res = await deps.fetchUrl(wrap(url));
					if (!res.ok) return false;
					const bytes = await res.arrayBuffer();
					return bytes.byteLength > 0;
				}
				return false;
			}
			if (attachment.mode === "page") {
				if (deps.activeSessionId() !== pending.sessionId) return false;
				return deps.isPageGranted?.(attachment.path, pending.sessionId) === true;
			}
			if (typeof attachment.path !== "string" || !attachment.path.trim()) return false;
			if (attachment.path.split(/[\\/]+/).includes("..")) return false;
			const url = `/api/file?download=1&clientId=${encodeURIComponent(deps.clientId())}&path=${encodeURIComponent(attachment.path)}`;
			const res = await deps.fetchUrl(wrap(url));
			if (!res.ok) return false;
			const bytes = await res.arrayBuffer();
			if (Number.isFinite(attachment.size) && attachment.size! >= 0 && bytes.byteLength !== attachment.size) {
				return false;
			}
			if (attachment.mode === "lines") {
				if (
					!attachment.lines ||
					!Number.isFinite(attachment.lines.start) ||
					!Number.isFinite(attachment.lines.end) ||
					attachment.lines.start < 1 ||
					attachment.lines.end < attachment.lines.start
				) {
					return false;
				}
				const text = new TextDecoder().decode(bytes);
				const lineCount = text.split(/\r?\n/).length;
				if (lineCount < attachment.lines.start) return false;
			}
			return true;
		} catch {
			return false;
		}
	};
}

type Socket = Pick<WebSocket, "readyState" | "send">;
type Client = ReturnType<typeof nativeRecoveryClient>;
type Frame = { conversationId: string; sessionId: string; workspace: string };
type PendingPhase = "saved" | "sending" | "restored" | "uncertain" | "unprocessed" | "blocked";
export interface CapturedAuthoredInput {
	message: ClientMessage;
	/** A typed source checkpoint, never a generic payload/secret journal. */
	beforeCheckpoint?: () => Promise<boolean>;
}
export interface RecoveryChatOptions {
	client?: Client;
	view(): { state: UiState | null; preview: UiState | null; engine?: string };
	/** Runs on the ORIGINAL object before cloning/awaiting (source WeakMaps). */
	captureOriginal(message: ClientMessage): CapturedAuthoredInput | null;
	pending(prepared: PreparedRecoveryWork, phase: PendingPhase, reason?: string): void;
	problem(message: string): void;
	verifyReference?: Parameters<Client["attach"]>[0]["verifyReference"];
}
interface Held {
	target: SwitchTarget;
	prepared: PreparedRecoveryWork;
}
interface Waiter {
	socket: Socket;
	binding: AdmissionBinding;
	message: CommandDispositionMsg["recovery"];
	commandType: string;
	resolve(value: boolean): void;
}
const effectiveSessionId = (state: Pick<UiState, "conversationId" | "sessionId" | "cwd">, engine?: string): string =>
	state.sessionId || (engine === "dsh" && state.conversationId ? `dsh:${state.conversationId}` : "");
const frame = (state: Pick<UiState, "conversationId" | "sessionId" | "cwd">, engine?: string): Frame => ({
	conversationId: state.conversationId,
	sessionId: effectiveSessionId(state, engine),
	workspace: state.cwd,
});
const sameFrame = (a: Frame | null, b: Frame | null) =>
	!!a && !!b && a.conversationId === b.conversationId && a.sessionId === b.sessionId && a.workspace === b.workspace;

export function createRecoveryChatTransport(options: RecoveryChatOptions) {
	const client = options.client ?? nativeRecoveryClient();
	let socket: Socket | null = null;
	let generation = "";
	let initialized = false;
	let actual: Frame | null = null;
	let sessionLifetime: object = {};
	let workspaceLifetime: object = {};
	let detach: (() => void) | undefined;
	let opening: {
		target: SwitchTarget;
		lifetime: object;
		preview: Frame | null;
		complete: boolean;
	} | null = null;
	const held = new Map<string, Held>();
	const waiters = new Map<string, Waiter>();
	const statusLookups = new Map<
		string,
		{ socket: Socket; binding: AdmissionBinding; id: string; resolve(value: "negative" | "handled" | "unknown"): void }
	>();
	const queueAnswerWaiters = new Map<
		string,
		{
			socket: Socket;
			binding: AdmissionBinding;
			occ: TaskQueueAnswerBinding;
			resolve(value: boolean): void;
		}
	>();
	const lifetimeKeys = new WeakMap<object, string>();
	let lifetimeSequence = 0;
	const report = (text: string) => {
		try {
			options.problem(text);
		} catch {
			/* Reporting cannot change ownership. */
		}
	};
	function settleAll(): void {
		for (const waiter of waiters.values()) waiter.resolve(false);
		waiters.clear();
		for (const lookup of statusLookups.values()) lookup.resolve("unknown");
		statusLookups.clear();
		for (const qa of queueAnswerWaiters.values()) {
			qa.resolve(false);
		}
		queueAnswerWaiters.clear();
	}
	function current(binding: AdmissionBinding): boolean {
		if (
			!socket ||
			socket.readyState !== 1 ||
			!initialized ||
			!generation ||
			binding.transport !== socket ||
			binding.generation !== generation ||
			!actual
		)
			return false;
		if (binding.targetScope === "global")
			return binding.workspace === actual.workspace && binding.lifetime === workspaceLifetime;
		if (
			binding.heldTarget &&
			opening &&
			!opening.complete &&
			sameSwitchTarget(binding.heldTarget, opening.target) &&
			binding.lifetime === opening.lifetime &&
			opening.preview?.conversationId === binding.conversationId &&
			opening.preview.sessionId === binding.sessionId &&
			opening.preview.workspace === binding.workspace
		)
			return true;
		if (binding.workspace !== actual.workspace) return false;
		return (
			(!opening || opening.complete) &&
			binding.lifetime === sessionLifetime &&
			actual.conversationId === binding.conversationId &&
			actual.sessionId === binding.sessionId
		);
	}
	function capture(message?: ClientMessage): AdmissionContext | null {
		if (!socket || socket.readyState !== 1 || !initialized || !generation || !actual) return null;
		const view = options.view();
		const engine = view.engine;
		const scoped = message ? recoveryUsesSessionTarget(message.type) : true;
		let state = view.state;
		let lifetime = scoped ? sessionLifetime : workspaceLifetime;
		let heldTarget: SwitchTarget | undefined;
		if (scoped && opening && !opening.complete) {
			if (
				message?.type !== "prompt" ||
				!opening.preview ||
				!view.preview ||
				!sameFrame(frame(view.preview, engine), opening.preview)
			)
				return null;
			state = view.preview;
			lifetime = opening.lifetime;
			heldTarget = { ...opening.target };
		} else if (!state || !sameFrame(frame(state, engine), actual)) return null;
		const sessionId = state ? effectiveSessionId(state, engine) : "";
		if (!state || !sessionId) return null;
		const normalizedState = state.sessionId === sessionId ? state : { ...state, sessionId };
		const source: AdmissionContext = {
			transport: socket,
			generation,
			sessionId,
			conversationId: state.conversationId,
			workspace: state.cwd,
			lifetime,
			targetScope: scoped ? "session" : "global",
			state: normalizedState,
			...(heldTarget ? { heldTarget } : {}),
		};
		return current(source) ? source : null;
	}
	function cancelHolds(reason: string, target?: SwitchTarget): void {
		for (const [key, hold] of [...held]) {
			if (target && !sameSwitchTarget(hold.target, target)) continue;
			held.delete(key);
			client.cancelHeld(hold.prepared);
			options.pending(hold.prepared, "unprocessed", reason);
		}
	}
	const port: Parameters<Client["attach"]>[0] = {
		captureContext: capture,
		isCurrent: current,
		publish(message, prepared, binding, direct) {
			if (!current(binding) || !socket)
				return { kind: "not-published", reason: "The original target/connection changed; its complete copy remains." };
			if (binding.heldTarget && !direct) {
				held.set(recoveryIdentityKey(prepared), { target: { ...binding.heldTarget }, prepared });
				return { kind: "held" };
			}
			if (
				binding.heldTarget &&
				((opening && !opening.complete) ||
					actual?.conversationId !== binding.conversationId ||
					actual.sessionId !== binding.sessionId)
			)
				return { kind: "not-published", reason: "The original held target is not attached; its full copy remains." };
			if (!message.recovery)
				return { kind: "not-published", reason: "The owned transmission identity is missing; nothing was sent." };
			const owner = socket;
			const identity = message.recovery;
			const accepted = new Promise<boolean>((resolve) => {
				waiters.set(identity.attemptId, {
					socket: owner,
					binding,
					message: identity,
					commandType: message.type,
					resolve,
				});
			});
			options.pending(prepared, "sending", "Delivery is not confirmed. The complete recovery copy remains.");
			try {
				owner.send(JSON.stringify(message));
			} catch (error) {
				const waiter = waiters.get(identity.attemptId);
				waiters.delete(identity.attemptId);
				waiter?.resolve(false);
				throw error;
			}
			return { kind: "sent", accepted };
		},
		verifyReference: options.verifyReference,
		restored(snapshot) {
			for (const entry of snapshot.entries)
				options.pending(
					entry.prepared,
					entry.complete ? "restored" : "blocked",
					entry.complete
						? "Recovered original; delivery remains unknown until checked."
						: "Recovery is incomplete; keep and export the original source.",
				);
		},
		saved(prepared) {
			options.pending(prepared, "saved");
		},
		cancelHold(identity) {
			held.delete(recoveryIdentityKey(identity));
		},
		problem: report,
	};
	const api = {
		client,
		ownsTransport: (owner: Socket) => socket === owner,
		isCurrent: current,
		/** Binding only: no retained transcript/window in a parent callback. */
		captureBinding(): AdmissionBinding | null {
			const source = capture();
			if (!source) return null;
			const { state: _state, ...binding } = source;
			return binding;
		},
		bindingKey(): string {
			const binding = api.captureBinding();
			if (!binding?.lifetime) return "";
			let key = lifetimeKeys.get(binding.lifetime);
			if (!key) {
				key = `${binding.generation}/${++lifetimeSequence}/${binding.conversationId}/${binding.sessionId}`;
				lifetimeKeys.set(binding.lifetime, key);
			}
			return key;
		},
		async start(): Promise<void> {
			detach?.();
			detach = client.attach(port);
			// A React remount attaches a new port, not a second/replayed owner.
			for (const item of client.getSnapshot().items)
				options.pending(item.prepared, item.complete ? "restored" : "blocked");
			await client.start();
		},
		stop(): void {
			settleAll();
			cancelHolds("The view closed before its held original was transmitted.");
			detach?.();
			detach = undefined;
			initialized = false;
			sessionLifetime = {};
			workspaceLifetime = {};
			// Do NOT close the document's recovery coordinator or delete its records.
		},
		connect(next: Socket): void {
			settleAll();
			cancelHolds("The connection changed before this original was transmitted.");
			socket = next;
			generation = "";
			initialized = false;
			actual = null;
			opening = null;
			sessionLifetime = {};
			workspaceLifetime = {};
		},
		ready(owner: Socket, nextGeneration: string | undefined): void {
			if (socket !== owner) return;
			generation = typeof nextGeneration === "string" ? nextGeneration : "";
			initialized = false;
		},
		initialize(owner: Socket, value: string): boolean {
			if (socket !== owner || owner.readyState !== 1 || !generation || value !== generation || initialized)
				return false;
			initialized = true;
			return true;
		},
		bindSnapshot(owner: Socket, state: Pick<UiState, "conversationId" | "sessionId" | "cwd">): void {
			if (socket !== owner) return;
			const next = frame(state, options.view().engine);
			if (actual?.workspace !== next.workspace) workspaceLifetime = {};
			if (!sameFrame(actual, next)) sessionLifetime = {};
			actual = next;
			if (opening?.preview && sameFrame(opening.preview, next)) sessionLifetime = opening.lifetime;
		},
		beginSwitch(target: SwitchTarget): void {
			cancelHolds("You left the original opening target before it was transmitted.");
			sessionLifetime = {};
			opening = { target: { ...target }, lifetime: {}, preview: null, complete: false };
		},
		preview(owner: Socket, target: SwitchTarget, state: UiState): void {
			if (socket === owner && opening && sameSwitchTarget(opening.target, target))
				opening.preview = frame(state, options.view().engine);
		},
		async completeSwitch(target: SwitchTarget): Promise<void> {
			const original = opening;
			if (!original || !sameSwitchTarget(original.target, target)) return;
			original.complete = true;
			if (sameFrame(actual, original.preview)) sessionLifetime = original.lifetime;
			for (const [key, hold] of [...held]) {
				if (opening !== original || !sameSwitchTarget(hold.target, target)) continue;
				const ok = await client.flushHeld(hold.prepared);
				if (ok && held.get(key) === hold) held.delete(key);
			}
			if (opening === original) opening = null;
		},
		cancelSwitch(reason: string, target?: SwitchTarget): void {
			cancelHolds(reason, target);
			if (!target || (opening && sameSwitchTarget(opening.target, target))) {
				opening = null;
				sessionLifetime = {};
			}
		},
		invalidateTarget(): void {
			cancelHolds("The original target changed before its held work was transmitted.");
			opening = null;
			actual = null;
			sessionLifetime = {};
			workspaceLifetime = {};
		},
		disconnect(owner: Socket): void {
			if (socket !== owner) return;
			initialized = false;
			settleAll();
			cancelHolds("The connection closed before this original was transmitted.");
		},
		receiveDisposition(owner: Socket, message: CommandDispositionMsg): boolean {
			if (socket !== owner || generation !== message.connectionGeneration || !client.receiveDisposition(message, owner))
				return false;
			const waiter = waiters.get(message.recovery.attemptId);
			if (
				waiter &&
				waiter.socket === owner &&
				waiter.commandType === message.commandType &&
				waiter.message.id === message.recovery.id &&
				waiter.message.sessionId === message.recovery.sessionId &&
				waiter.message.contentDigest === message.recovery.contentDigest
			) {
				waiters.delete(message.recovery.attemptId);
				waiter.resolve(
					current(waiter.binding) && message.status === "uncertain" && message.reason === "dispatch-started",
				);
			}
			const item = client
				.getSnapshot()
				.items.find(
					(entry) =>
						entry.prepared.id === message.recovery.id &&
						entry.prepared.sessionId === message.recovery.sessionId &&
						entry.prepared.contentDigest === message.recovery.contentDigest,
				);
			if (item)
				options.pending(
					item.prepared,
					message.status === "uncertain" && message.reason === "dispatch-started" ? "sending" : message.status,
					message.status === "unprocessed"
						? "The host explicitly refused this exact transmission before dispatch."
						: "Owned by the host; execution and persistence are not confirmed.",
				);
			return true;
		},
		async admit(input: ClientMessage, expected?: AdmissionBinding): Promise<boolean> {
			let captured: CapturedAuthoredInput | null;
			let message: ClientMessage;
			try {
				// Real accessor MUST see the original packet, not its JSON clone.
				captured = options.captureOriginal(input);
				if (!captured) {
					report("This authored source is not ready for complete recovery. Keep the full original.");
					return false;
				}
				message = captureRecoveryMessage(captured.message);
			} catch {
				report("The full original could not be captured; keep every editable field.");
				return false;
			}
			if (expected && !current(expected)) {
				report("The original editor target changed; its complete input was kept.");
				return false;
			}
			const context = capture(message);
			if (!context) {
				report("The original chat/connection is still opening. Keep the complete draft.");
				return false;
			}
			if (message.type === "prompt" && !message.id) message = { ...message, id: newPromptId() };
			const ok = await client.admit(message, {
				context,
				...(captured.beforeCheckpoint ? { beforeCheckpoint: captured.beforeCheckpoint } : {}),
			});
			if (!ok && message.type === "prompt") {
				const item = client
					.getSnapshot()
					.items.find(
						(entry) =>
							entry.prepared.kind === "prompt" &&
							entry.prepared.id === message.id &&
							entry.prepared.sessionId === context.sessionId,
					);
				if (item)
					options.pending(
						item.prepared,
						item.delivery === "saved" || item.delivery === "unprocessed"
							? "unprocessed"
							: item.delivery === "blocked"
								? "blocked"
								: "uncertain",
						"The original remains saved; inspect its exact delivery state before any retry.",
					);
			}
			return ok;
		},
		/** A matching lookup is fresh context, NOT proof an unknown action never ran. */
		checkPromptStatus(identity: PreparedIdentity): Promise<"negative" | "handled" | "unknown"> {
			const binding = api.captureBinding();
			if (identity.kind !== "prompt" || !binding || binding.sessionId !== identity.sessionId || !socket)
				return Promise.resolve("unknown");
			const owner = socket;
			const reqId = `status-${newPromptId()}`;
			return new Promise((resolve) => {
				statusLookups.set(reqId, { socket: owner, binding, id: identity.id, resolve });
				try {
					owner.send(
						JSON.stringify({
							type: "prompt_status",
							ids: [identity.id],
							reqId,
							forSession: identity.sessionId,
						} satisfies ClientMessage),
					);
				} catch {
					statusLookups.delete(reqId);
					resolve("unknown");
				}
			});
		},
		receivePromptStatus(owner: Socket, message: Extract<ServerMessage, { type: "prompt_ack" }>): void {
			if (!message.statusReqId) return;
			const lookup = statusLookups.get(message.statusReqId);
			if (!lookup || lookup.socket !== owner || lookup.id !== message.id) return;
			statusLookups.delete(message.statusReqId);
			lookup.resolve(
				message.statusScopeValid === true &&
					message.statusSessionId === lookup.binding.sessionId &&
					current(lookup.binding)
					? message.ok
						? "handled"
						: "negative"
					: "unknown",
			);
		},
		answerQueueTask(req: TaskQueueAnswerRequest): Promise<boolean> {
			const occ = req?.binding;
			if (
				!req ||
				!occ ||
				typeof occ.conversationId !== "string" ||
				!occ.conversationId.trim() ||
				typeof occ.queueId !== "string" ||
				!occ.queueId.trim() ||
				!Number.isInteger(occ.taskId) ||
				occ.taskId <= 0 ||
				typeof occ.questionId !== "string" ||
				!occ.questionId.trim() ||
				typeof req.text !== "string" ||
				!req.text.trim() ||
				typeof occ.question !== "string" ||
				!Array.isArray(occ.choices) ||
				!occ.choices.every((c: unknown) => typeof c === "string") ||
				(occ.detail !== undefined && typeof occ.detail !== "string")
			) {
				return Promise.resolve(false);
			}
			const binding = api.captureBinding();
			const state = options.view().state;
			const queue = state?.taskQueue;
			const boundOccurrence = queue?.answerBindings?.find(
				(b) =>
					b.conversationId === occ.conversationId &&
					b.queueId === occ.queueId &&
					b.taskId === occ.taskId &&
					b.questionId === occ.questionId,
			);
			const task = queue?.tasks?.find((t) => t.id === occ.taskId);
			if (
				!socket ||
				socket.readyState !== 1 ||
				!binding ||
				binding.conversationId !== occ.conversationId ||
				state?.conversationId !== occ.conversationId ||
				!queue ||
				queue.queueId !== occ.queueId ||
				!boundOccurrence ||
				!task ||
				task.status !== "stuck" ||
				(task.question ?? "") !== occ.question ||
				JSON.stringify(task.choices ?? []) !== JSON.stringify(occ.choices) ||
				(task.detail ?? undefined) !== (occ.detail ?? undefined)
			) {
				return Promise.resolve(false);
			}
			const owner = socket;
			const reqId = `qa-${newPromptId()}`;
			const snapshotOcc: TaskQueueAnswerBinding = {
				conversationId: occ.conversationId,
				queueId: occ.queueId,
				taskId: occ.taskId,
				questionId: occ.questionId,
				question: occ.question,
				choices: [...occ.choices],
				...(occ.detail !== undefined ? { detail: occ.detail } : {}),
			};
			const textSnapshot = req.text;
			return new Promise((resolve) => {
				queueAnswerWaiters.set(reqId, { socket: owner, binding, occ: snapshotOcc, resolve });
				try {
					owner.send(
						JSON.stringify({
							type: "task_queue_answer",
							reqId,
							conversationId: snapshotOcc.conversationId,
							queueId: snapshotOcc.queueId,
							taskId: snapshotOcc.taskId,
							questionId: snapshotOcc.questionId,
							text: textSnapshot,
							question: snapshotOcc.question,
							choices: [...snapshotOcc.choices],
							...(snapshotOcc.detail !== undefined ? { detail: snapshotOcc.detail } : {}),
						} satisfies ClientMessage),
					);
				} catch {
					queueAnswerWaiters.delete(reqId);
					resolve(false);
				}
			});
		},
		receiveTaskQueueAnswerResult(
			owner: Socket,
			message: Extract<ServerMessage, { type: "task_queue_answer_result" }>,
		): void {
			if (!message.reqId) return;
			const waiter = queueAnswerWaiters.get(message.reqId);
			if (!waiter || waiter.socket !== owner) return;
			queueAnswerWaiters.delete(message.reqId);
			const matched =
				current(waiter.binding) &&
				message.applied === true &&
				message.conversationId === waiter.occ.conversationId &&
				message.queueId === waiter.occ.queueId &&
				message.taskId === waiter.occ.taskId &&
				message.questionId === waiter.occ.questionId;
			waiter.resolve(matched);
		},
		cancelWait(identity: PreparedIdentity): void {
			for (const [key, waiter] of waiters)
				if (
					waiter.message.id === identity.id &&
					waiter.message.sessionId === identity.sessionId &&
					waiter.message.contentDigest === identity.contentDigest
				) {
					waiters.delete(key);
					waiter.resolve(false);
				}
			// Cancellation does not claim the host stopped or authorize replay/deletion.
		},
	};
	return api;
}
