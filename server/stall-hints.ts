/**
 * The hints under the app's watch messages to a role (stall-wake, Ops #284; dead-end, Ops #483; silence-watch,
 * Ops #1059), and the refusal of a reply to one. Split out of role-messages.ts (its roleMessageHint and reply
 * check call these). turn-status (Ops #688): a turn they start ends with one status line.
 */
import { deadEndWaysOut } from "./dead-end.js";
import type { RoleStallInfo } from "./role-messages.js";
import { statusHint } from "./turn-status.js";

type StallItems = RoleStallInfo["items"];

/** stall-wake (Ops #284): what a work-check message tells the lead to do (its hint without the status). */
const STALL_ACTION =
	"(The work check found work you lead that isn't moving. Act with your tools: queue the next task under it (queue_add with its project or initiative), close it (work_project or work_initiative change, status done or dropped), or record a wait with its end (work_project or work_initiative wait). Nothing starts by itself. No reply is needed: the check sees what you do.";
/** dead-end (Ops #483, rule 30): what a work-check message about a project with nothing moving tells its
 *  lead (its hint without the status). */
const STALL_DEAD_END_ACTION =
	"(The work check found a project you lead with nothing moving (rule 30): no task at work or ready, none linked to another queue's task, no question with the owner. Take one of the ways out its item names: queue the fix task, link the other queue's task it really waits on, or ask the owner with the full package; if its work is finished, close it. A reply doesn't clear it, and nothing starts by itself: the check sees what you do.";
/** stall-wake: the work check's hint to a lead. */
export const STALL_HINT = `${STALL_ACTION} ${statusHint("poke")})`;
/** dead-end: the work check's hint to a lead about a project with nothing moving, status line as above. */
export const STALL_DEAD_END_HINT = `${STALL_DEAD_END_ACTION} ${statusHint("poke")})`;
/** A batch with dead ends and other stalls: both actions, the status line once. */
export const STALL_MIXED_HINT = `${STALL_ACTION}) ${STALL_DEAD_END_HINT}`;
/** stall-wake: the owner's step, sent to COO. */
export const STALL_OWNER_HINT =
	"(The work check found work that stayed stalled after its leads were woken. Put each item to the owner as one dialog with the full package (rule 21). Nothing starts by itself. No reply is needed: the check sees what changes.)";

/** silence-watch (Ops #1059, Q-STALL-1 B+): the lead's wake about a queued task waiting on its chat. */
export const SILENCE_HINT = `(The silence watch found a queued task waiting on you with no turn in this chat since. Decide it with your tools: answer its question (queue_reply), deliver or decide what its block owes, or tell it who should. Nothing starts by itself. No reply is needed: the watch sees what you do. ${statusHint("poke")})`;
/** silence-watch: COO's wake, an hour after the lead's, still no turn in the lead's chat. */
export const SILENCE_COO_HINT = `(The silence watch woke a lead about a waiting task an hour ago and that lead's chat has not had a turn since. Get it decided: wake that lead, decide it within your authority, or put it to the owner with the full package (rule 15). No reply is needed: the watch sees what changes. ${statusHint("poke")})`;

/** A silence-watch batch: its items are queued tasks (stall-wake's are projects and initiatives). */
export const isSilenceBatch = (items: StallItems): boolean => items.length > 0 && items.every((i) => i.kind === "task");

/** The hint under a watch message (role-messages.ts roleMessageHint). */
export function stallHint(items: StallItems): string {
	if (isSilenceBatch(items)) return items.some((i) => i.step > 1) ? SILENCE_COO_HINT : SILENCE_HINT;
	const owner = items.some((i) => i.owner);
	const leads = items.filter((i) => !i.owner);
	// dead-end (Ops #483): its own hint, beside the usual one when the batch has other stalls too.
	const dead = leads.some((i) => i.rule === "dead-end");
	const leadHint = !dead
		? STALL_HINT
		: leads.every((i) => i.rule === "dead-end")
			? STALL_DEAD_END_HINT
			: STALL_MIXED_HINT;
	if (!owner) return leadHint;
	return leads.length
		? `(This batch has both lead-action and owner-step items. Apply the lead-action hint only to items saying "To clear it", and the owner-dialog hint only to items saying "Put it to the owner".) ${leadHint} ${STALL_OWNER_HINT}`
		: STALL_OWNER_HINT;
}

/** Why a reply to a watch message is refused: no reply clears it, only acting does. */
export function stallReplyRefusal(replyTo: string, items: StallItems): string {
	if (isSilenceBatch(items))
		return `${replyTo} is the silence watch's wake about a waiting task: no reply is needed. Act with your tools (answer its question with queue_reply, deliver what its block owes, or tell it who should); the watch sees what you do.`;
	// dead-end (Ops #483): a reply never clears it; only a way out does.
	const dead = items.filter((i) => i.rule === "dead-end" && !i.owner);
	return dead.length
		? `${replyTo} is the work check's wake about ${dead.map((i) => `project ${i.id}`).join(", ")} with nothing moving: a reply doesn't clear it. Take a way out with your tools: ${deadEndWaysOut(dead[0].id)} The check sees what you do.`
		: `${replyTo} is the work check's wake about stalled work: no reply is needed. Act with your tools (queue_add under it, work_project or work_initiative change or wait); the check sees what you do.`;
}

/** The header's topic for a watch message. */
export const stallTopic = (items: StallItems): string => (isSilenceBatch(items) ? "silent wait" : "stalled work");
