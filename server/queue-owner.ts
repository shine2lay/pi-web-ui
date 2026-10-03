/** queue-autonomy: short-lived, one-use capabilities for Queue panel settings.
 * Only the authenticated browser dispatch issues these. No model-facing tool can mint one.
 * A ticket never enters the transcript: the extension consumes it inside an immediate command.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UiProfilePatch } from "./protocol.js";
import { checkPatch } from "./queue-profile.js";

export type QueueSetting = "autoApprove" | "autoStart";
export type OwnerSetting =
	{ setting: QueueSetting; value: boolean } | { setting: "profile"; id?: number; patch: UiProfilePatch };
interface Ticket {
	queueId: string;
	change: OwnerSetting;
	until: number;
	current: () => boolean;
}
const tickets = new Map<string, Ticket>();

/** The SDK normally waits for the first assistant message before creating a transcript.
 * An owner's empty-queue opt-in must survive too. Create only a NEW file, synchronously, through
 * the owning session's state (never rewrite an existing/open transcript or invent a model turn).
 * Like persistConversation, the SDK's flushed bit makes all subsequent entries append normally.
 */
export function persistEmptyQueue(sm: SessionManager): void {
	const file = sm.getSessionFile();
	if (!sm.isPersisted() || !file || existsSync(file)) return;
	const header = sm.getHeader();
	if (!header) throw new Error("Queue session header missing");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, [header, ...sm.getEntries()].map((e) => JSON.stringify(e)).join("\n") + "\n", {
		flag: "wx",
		mode: 0o600,
	});
	(sm as unknown as { flushed: boolean }).flushed = true;
}

/** A queue may be meaningful before its first chat message. New Chat must not reuse it. */
export function hasQueueEntries(entries: readonly { type: string; customType?: string }[]): boolean {
	return entries.some((entry) => entry.type === "custom" && entry.customType === "queue");
}

export function parseOwnerSetting(
	action: unknown,
	value: unknown,
	profile?: unknown,
	id?: unknown,
): OwnerSetting | undefined {
	if (action === "defaults" || action === "taskProfile") {
		const { patch, problems } = checkPatch(profile);
		if (problems.length || !Object.keys(patch).length) return undefined;
		if (action === "taskProfile" && (typeof id !== "number" || !Number.isInteger(id) || id <= 0)) return undefined;
		return { setting: "profile", ...(action === "taskProfile" ? { id: id as number } : {}), patch };
	}
	if ((action !== "autoApprove" && action !== "autoStart") || typeof value !== "boolean") return undefined;
	return { setting: action, value };
}

/** Both fences are mandatory: a conversation can switch session without changing its conversation id. */
export function ownerQueueMatches(
	conversationId: unknown,
	queueId: unknown,
	activeId: string,
	sessionId: string,
): boolean {
	return (
		typeof conversationId === "string" &&
		!!conversationId &&
		conversationId === activeId &&
		typeof queueId === "string" &&
		!!queueId &&
		queueId === sessionId
	);
}

export function issueOwnerSetting(
	queueId: string,
	change: OwnerSetting,
	current: () => boolean,
): { token: string; dispose: () => void } {
	for (const [key, ticket] of tickets) if (ticket.until < Date.now()) tickets.delete(key);
	const token = randomBytes(32).toString("hex");
	tickets.set(token, { queueId, change, current, until: Date.now() + 5000 });
	return {
		token,
		dispose: () => {
			tickets.delete(token);
		},
	};
}

export function consumeOwnerSetting(token: string, queueId: string): OwnerSetting | undefined {
	const ticket = tickets.get(token);
	tickets.delete(token);
	if (!ticket || ticket.queueId !== queueId || ticket.until < Date.now() || !ticket.current()) return undefined;
	return ticket.change;
}
