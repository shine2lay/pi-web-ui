/** Persisted queue facts and custom-message delivery for department peer notes. */
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { validateRawToolInvocation } from "./specialist-raw-runtime.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { identityRegistry, samePath } from "./identities.js";
import { ownTaskOf } from "./own-task.js";
import { taskQueueAll, taskQueueBackOwed, taskQueueHeld } from "./task-queue.js";
import { makePeerNoteTool, sendPeerNote, PEER_NOTE_CUSTOM_TYPE, type PeerTask } from "./peer-notes.js";
import type { RoleMessages, RoleMessageSender } from "./role-messages.js";
import { noteAtRoleMailBoundary } from "./role-mail-boundary.js";
import type { RoleMessageGuardHost } from "./role-message-guard-host.js";

export function peerQueueTasks(queue: string): PeerTask[] {
	const entries = readFileSync(queue, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
	const state = taskQueueAll(entries);
	return state.tasks.map((task) => ({
		id: task.id,
		status: task.status,
		queue,
		...(task.chat ? { chat: task.chat.file, chatGone: !existsSync(task.chat.file) } : {}),
		...(task.startedAt ? { startedAt: task.startedAt } : {}),
		...(task.specialist ? { specialist: task.specialist } : {}),
		held: !!taskQueueHeld(task, state),
		backOwed: taskQueueBackOwed(task),
	}));
}

export function readPeerTask(queue: string, id: number): PeerTask | null {
	try {
		return peerQueueTasks(queue).find((task) => task.id === id) ?? null;
	} catch {
		return null;
	}
}

export function makeRuntimePeerNoteTool(host: {
	session: () => AgentSession | undefined;
	store: () => RoleMessages | undefined;
	sender: () => RoleMessageSender | string;
	guard: () => RoleMessageGuardHost | undefined;
}) {
	return makePeerNoteTool({
		send: async (args, callId) => {
			const refuse = (code: string) => ({ result: "refuse" as const, code, records_added: 0 });
			const session = host.session();
			const store = host.store();
			const sender = host.sender();
			if (!session || !store || typeof sender === "string") return refuse("E_PEER_SENDER");
			const original = validateRawToolInvocation(session.sessionManager.getSessionId(), callId, "peer_note");
			if (original.status !== "valid")
				return refuse(original.status === "invalid" ? "E_PEER_ARGS" : "E_SPEC_UNAVAILABLE");
			// Never admit stripped/coerced SDK arguments or a different prepared payload.
			if (!isDeepStrictEqual(args, original.args)) return refuse("E_PEER_ARGS");
			const file = session.sessionFile;
			const entries = session.sessionManager.getBranch();
			const own = ownTaskOf(entries);
			const home = identityRegistry().identities.find((identity) => identity.id === sender.role)?.homeChat;
			if (
				!file ||
				!home ||
				!own?.queueChat ||
				own.id === undefined ||
				!samePath(home, own.queueChat) ||
				!samePath(file, sender.file)
			)
				return refuse("E_PEER_SENDER");
			try {
				// Only the latest triggering user/peer message establishes this turn's chain. A board
				// note or a tool result cannot reset it, and a forged peer header fails closed.
				const trigger = [...session.messages]
					.reverse()
					.find(
						(message) =>
							message.role === "user" || (message.role === "custom" && message.customType === PEER_NOTE_CUSTOM_TYPE),
					);
				const content = trigger && "content" in trigger ? trigger.content : undefined;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n")
							: "";
				const cause = store.causalityOf(file, text);
				if (cause.kind === "unknown" || (cause.kind === "record" && !cause.exactTarget)) return refuse("E_ROLE_CHAIN");
				const chain = cause.kind === "record" ? cause.record.chain + 1 : sender.handling + 1;
				const stampedSender = {
					...sender,
					handling: chain - 1,
					...(sender.guard ? { guard: { ...sender.guard, lastUserText: text } } : {}),
				};
				const input = {
					sender: {
						entries,
						file,
						assigned: { queue: home, task: own.id },
						is_home: samePath(home, file),
						tools: session.getActiveToolNames(),
					},
					home_chat: home,
					home_dept: sender.role,
					tasks: peerQueueTasks(home),
					args: original.args,
					call_id: callId,
					chain,
					...(cause.kind === "record" ? { root: cause.record.root ?? cause.record.id, parent: cause.record.id } : {}),
				};
				const allowed = (tools: unknown, name: string) => Array.isArray(tools) && tools.includes(name);
				const guard = host.guard();
				return guard
					? await guard.sendPeer(stampedSender, input, callId, allowed)
					: sendPeerNote(store, stampedSender, input, allowed);
			} catch {
				return refuse("E_PEER_SENDER");
			}
		},
	});
}

/** Never turn teammate information into a user message. Streaming questions queue a follow-up;
 * passive notes use the existing boundary adapter and cannot wake the recipient. */
export async function deliverPeerCustomMessage(
	session: AgentSession,
	text: string,
	opts: { turn: boolean; followUp?: boolean },
	onError: (error: unknown) => void,
): Promise<boolean> {
	const message = { customType: PEER_NOTE_CUSTOM_TYPE, content: [{ type: "text" as const, text }], display: true };
	if (!opts.followUp) {
		const persisted = () =>
			session.messages.some(
				(row) =>
					row.role === "custom" &&
					row.customType === PEER_NOTE_CUSTOM_TYPE &&
					(typeof row.content === "string"
						? row.content
						: row.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")) === text,
			);
		if (persisted()) return true;
		await noteAtRoleMailBoundary(session, message);
		return persisted();
	}
	// An idle follow-up starts asynchronously; waiting for its whole model turn would lock mail delivery.
	const streaming = session.isStreaming;
	// SDK triggerTurn:false means passive append EVEN with deliverAs:followUp. A real
	// follow-up therefore needs true; streaming SDK sessions queue it, never steer it.
	const delivery = session.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true });
	if (!streaming) void delivery.catch(onError);
	else await delivery;
	return true;
}
