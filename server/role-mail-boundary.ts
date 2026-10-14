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
const installed = new WeakMap<Session, { note: (message: Note) => Promise<void> }>();

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
export function installRoleMailBoundary(session: Session): void {
	if (installed.has(session)) return;
	const agent = session.agent;
	let pending: Pending[] = [];
	let ready = false;
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
		ready = false;
		clear();
	};
	// A retry can arrive through an idle prompt after a failed/aborted run.
	// Its native message event consumes the old pending copy, not a second delivery.
	session.subscribe((event) => {
		if (event.type === "message_start") {
			const id = idOf(event.message);
			if (id) pending = pending.filter((p) => p.id !== id);
		}
	});
	agent.finishTurn = async (turn, signal) => {
		const decision = (await finish?.(turn, signal)) || undefined;
		ready = false;
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
		const notes = pending;
		pending = [];
		for (const row of notes) await session.sendCustomMessage(row.note!, { triggerTurn: false });
		return decision;
	};
	agent.prepareNextTurnWithContext = async (turn, signal) => {
		const update = prepare ? await prepare(turn, signal) : await prepareLegacy?.(signal);
		if (!ready || !pending.length) return update;
		const batch = pending;
		pending = [];
		ready = false;
		// The SDK emits/persists these with its normal message lifecycle. Include
		// notes in the same FIFO, so they cannot overtake an older request.
		return { ...update, messages: [...(update?.messages ?? []), ...batch.map((p) => p.message)] };
	};
	installed.set(session, {
		note: async (note) => {
			const message: AgentMessage = { role: "custom", ...note, timestamp: Date.now() };
			const id = idOf(message);
			if (!id || (!agent.state.isStreaming && !pending.some((p) => !p.note))) {
				// An idle retry after an aborted run consumes its buffered note copy.
				if (id) pending = pending.filter((p) => p.id !== id);
				await session.sendCustomMessage(note, { triggerTurn: false });
				return;
			}
			add({ id, message, note });
		},
	});
}

export async function noteAtRoleMailBoundary(session: Session, note: Note): Promise<void> {
	installRoleMailBoundary(session);
	await installed.get(session)!.note(note);
}
