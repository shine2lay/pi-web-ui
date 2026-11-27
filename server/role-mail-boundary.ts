/** role-mail-busy: one ordered batch at the next completed run, never steering.
 * Ordinary follow-ups keep their SDK mode. Only message_role's stamped follow-ups
 * and no-turn notes use this server adapter; SDK prompt/input/receipt handling stays intact.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { roleMessageIdOf } from "./role-messages.js";

type Session = Pick<AgentSession, "agent" | "subscribe" | "sendCustomMessage">;
type Note = Parameters<AgentSession["sendCustomMessage"]>[0];
type Pending = { id: string; message: AgentMessage; note?: Note };
export interface RoleMailHooks {
	legacy?: () => boolean;
	select?: (rows: readonly { id: string; passive: boolean }[]) => Promise<string[]>;
	landed?: (id: string | undefined, message: AgentMessage) => Promise<void>;
	ended?: (outcome: "turn_completed" | "aborted") => Promise<void>;
}
const installed = new WeakMap<
	Session,
	{ note: (message: Note) => Promise<void>; beforeResume: (admit: () => Promise<void>) => Promise<() => void> }
>();

function idOf(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "custom") return undefined;
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: content
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("\n");
	return roleMessageIdOf(text);
}

/** Install before the first run (and on replacement runtimes): a running loop
 * captures finishTurn. These are public SDK boundary hooks, not SDK edits.
 */
export function installRoleMailBoundary(session: Session, hooks: RoleMailHooks = {}): void {
	if (installed.has(session)) return;
	const agent = session.agent;
	let pending: Pending[] = [];
	let ready = false;
	let resuming = false;
	let packet: Pending[] = [];
	let landing: Promise<void> = Promise.resolve();
	const legacy = () => hooks.legacy?.() === true;
	const select = async (): Promise<Pending[]> => {
		if (legacy()) {
			const batch = pending;
			pending = [];
			return batch;
		}
		if (packet.length) return packet;
		const ids = hooks.select ? await hooks.select(pending.map((p) => ({ id: p.id, passive: !!p.note }))) : undefined;
		const ordered = ids ? ids.map((id) => pending.find((p) => p.id === id)).filter((p): p is Pending => !!p) : pending;
		const action = ordered.find((p) => !p.note);
		packet = [...(action ? [action] : []), ...ordered.filter((p) => p.note).slice(0, 20)];
		return packet;
	};
	const followUp = agent.followUp.bind(agent);
	const clear = agent.clearFollowUpQueue.bind(agent);
	const finish = agent.finishTurn;
	const prepare = agent.prepareNextTurnWithContext;
	const prepareLegacy = agent.prepareNextTurn;
	const add = (row: Pending): void => {
		const previous = pending.findIndex((p) => p.id === row.id);
		if (previous < 0) pending.push(row);
		else if (row.note) pending[previous] = row; // a paused-task retry is a note, not a turn
	};

	agent.followUp = (message) => {
		const id = idOf(message);
		if (!id) return followUp(message);
		add({ id, message });
	};
	agent.clearFollowUpQueue = () => {
		pending = pending.filter((p) => p.note); // SDK follow-up cancellation does not cancel no-turn notes
		packet = packet.filter((p) => p.note);
		ready = false;
		clear();
	};
	// A retry can arrive through an idle prompt after a failed/aborted run.
	// Its native message event consumes the old pending copy, not a second delivery.
	session.subscribe((event) => {
		if (event.type === "message_start") {
			const id = idOf(event.message);
			if (id) {
				pending = pending.filter((p) => p.id !== id);
				packet = packet.filter((p) => p.id !== id);
			}
		}
		if (event.type === "message_end" && event.message.role === "user" && !legacy() && hooks.landed) {
			const message = event.message;
			// SDK persistence and owner-input marks happen after the synchronous event listeners.
			// Chain before yielding so finishTurn cannot overtake the durable landing.
			landing = landing
				.then(() => new Promise<void>((resolve) => queueMicrotask(resolve)))
				.then(() => hooks.landed!(idOf(message), message));
		}
	});
	agent.finishTurn = async (turn, signal) => {
		const decision = (await finish?.(turn, signal)) || undefined;
		ready = false;
		const continuation = turn.message.content.some((c) => c.type === "toolCall");
		if (!legacy() && !continuation) {
			await landing;
			await hooks.ended?.(
				signal?.aborted || turn.message.stopReason === "error" || turn.message.stopReason === "aborted"
					? "aborted"
					: "turn_completed",
			);
		}
		if (
			!pending.length ||
			decision?.action === "end" ||
			signal?.aborted ||
			turn.message.stopReason === "error" ||
			turn.message.stopReason === "aborted"
		)
			return decision;
		// A tool-result continuation is still part of the current run. Follow-ups
		// wait until it would finish, exactly like the ordinary SDK follow-up path.
		if (turn.message.content.some((c) => c.type === "toolCall")) return decision;
		if (pending.some((p) => !p.note)) {
			ready = true;
			return { action: "continue" };
		}
		// Notes alone must not request another response. SDK buffers these until
		// turn_end, after tool results and before the next independent prompt.
		const notes = legacy() ? pending : pending.filter((p) => p.note).slice(0, 20);
		for (const row of notes) {
			await session.sendCustomMessage(row.note!, { triggerTurn: false });
			pending = pending.filter((p) => p.id !== row.id);
		}
		return decision;
	};
	agent.prepareNextTurnWithContext = async (turn, signal) => {
		const update = prepare ? await prepare(turn, signal) : await prepareLegacy?.(signal);
		if (!ready || !pending.length) return update;
		const batch = await select();
		ready = false;
		// The SDK emits/persists these with its normal message lifecycle. Include
		// notes in the same FIFO, so they cannot overtake an older request.
		return { ...update, messages: [...(update?.messages ?? []), ...batch.map((p) => p.message)] };
	};
	installed.set(session, {
		// Restart only: the chat has reopened but its carry-on prompt has not begun.
		// Reuse the exact boundary FIFO, letting the SDK persist it with that prompt.
		beforeResume: async (admit) => {
			if (agent.state.isStreaming) {
				await admit(); // still only buffered for the ordinary completed-run boundary
				return () => {};
			}
			const original = agent.prompt;
			const prompt = original.bind(agent);
			resuming = true;
			let armed = true;
			const restore = (): void => {
				if (!armed) return;
				armed = false;
				resuming = false;
				if (agent.prompt === atResume) agent.prompt = original;
			};
			const atResume: typeof agent.prompt = async (
				input: AgentMessage | AgentMessage[] | string,
				images?: Parameters<AgentSession["followUp"]>[1],
			) => {
				restore(); // one-shot; ordinary prompts and follow-ups remain untouched
				if (agent.state.isStreaming || !Array.isArray(input) || !pending.length)
					return typeof input === "string" ? prompt(input, images) : prompt(input);
				const batch = await select();
				ready = false;
				return prompt([...batch.map((row) => row.message), ...input]);
			};
			agent.prompt = atResume;
			try {
				await admit();
				return restore;
			} catch (error) {
				restore();
				throw error;
			}
		},
		note: async (note) => {
			const message: AgentMessage = { role: "custom", ...note, timestamp: Date.now() };
			const id = idOf(message);
			if (!id || (!resuming && !agent.state.isStreaming && !pending.some((p) => !p.note))) {
				// An idle retry after an aborted run consumes its buffered note copy.
				if (id) pending = pending.filter((p) => p.id !== id);
				await session.sendCustomMessage(note, { triggerTurn: false });
				return;
			}
			add({ id, message, note });
		},
	});
}

/** Arm only the imminent restart resume, and return its cleanup for failed/deferred prompts. */
export async function admitRoleMailAtResume(session: Session, admit: () => Promise<void>): Promise<() => void> {
	installRoleMailBoundary(session);
	return installed.get(session)!.beforeResume(admit);
}

export async function noteAtRoleMailBoundary(session: Session, note: Note): Promise<void> {
	installRoleMailBoundary(session);
	await installed.get(session)!.note(note);
}
