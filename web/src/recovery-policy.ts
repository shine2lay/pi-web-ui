/** Purpose/field-sensitive admission, not a generic ClientMessage journal.
 * Unknown/mixed forms retain their existing authorized live path; never infer new
 * persistence permission, action authority or replay permission from their type. */
import type { ClientMessage, PromptAttachment } from "./types";
import { matchesAuthoredCommand } from "../../server/command-intent";

type Fields = Record<string, unknown>;
const text = (value: unknown): value is string => typeof value === "string";
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const optionalText = (value: unknown) => value === undefined || text(value);
function keys(value: object, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function attachment(value: unknown): value is PromptAttachment {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const a = value as Fields;
	if (
		!keys(a, [
			"path",
			"mode",
			"conversationId",
			"sessionPath",
			"lines",
			"imageData",
			"imageUrl",
			"fileData",
			"uploadPath",
			"mimeType",
			"name",
			"size",
		])
	)
		return false;
	for (const field of [
		"path",
		"conversationId",
		"sessionPath",
		"imageData",
		"imageUrl",
		"fileData",
		"uploadPath",
		"mimeType",
		"name",
	])
		if (!optionalText(a[field])) return false;
	if (
		a.mode !== undefined &&
		(typeof a.mode !== "string" || !["inline", "reference", "lines", "page", "conversation"].includes(a.mode))
	)
		return false;
	if (a.size !== undefined && (typeof a.size !== "number" || !Number.isFinite(a.size) || a.size < 0)) return false;
	if (a.lines !== undefined) {
		if (!a.lines || typeof a.lines !== "object" || Array.isArray(a.lines) || !keys(a.lines, ["start", "end"]))
			return false;
		const lines = a.lines as Fields;
		if (
			typeof lines.start !== "number" ||
			!Number.isFinite(lines.start) ||
			typeof lines.end !== "number" ||
			!Number.isFinite(lines.end)
		)
			return false;
	}
	// Known app-relative image resources contain identifiers, not embedded auth.
	// Refuse external/credential-bearing/normalized-away references, never strip them.
	if (a.imageUrl !== undefined) {
		if (!text(a.imageUrl) || !a.imageUrl.startsWith("/") || a.imageUrl.startsWith("//")) return false;
		try {
			const url = new URL(a.imageUrl, "https://recovery.invalid");
			if (
				url.origin !== "https://recovery.invalid" ||
				url.pathname !== a.imageUrl ||
				url.search ||
				url.hash ||
				!/\/api\/(?:attachment|chat-image)\/[^?#:]+$/.test(url.pathname)
			)
				return false;
		} catch {
			return false;
		}
	}
	return true;
}
function attachments(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every(attachment));
}

/** These producer families must use appAdmit even when a malformed/unknown field
 * makes a particular payload ineligible. Otherwise a false policy could bypass it. */
export function requiresRecoveryAdmission(message: ClientMessage): boolean {
	switch (message.type) {
		case "prompt":
		case "edit_message":
		case "set_goal":
		case "start_goal_wizard":
		case "schedule_save":
		case "run_command":
		case "board_post":
		case "identity_note_save":
			return true;
		case "identity_file_save":
			return message.file === "about" || message.file === "prompt" || message.file === "notebook";
		case "board_close":
			return typeof message.note === "string" && message.note.length > 0;
		default:
			return false;
	}
}

/** Exact own wire schema after captureRecoveryMessage; no source fetch/redaction. */
export function isRecoveryEligible(message: ClientMessage): boolean {
	const m = message as unknown as Fields;
	switch (message.type) {
		case "set_goal":
			return (
				keys(m, ["type", "goal", "reviewModel", "maxRounds", "locked", "conversationId"]) &&
				nonempty(m.goal) &&
				nonempty(m.conversationId) &&
				(m.reviewModel === undefined || nonempty(m.reviewModel)) &&
				typeof m.maxRounds === "number" &&
				Number.isSafeInteger(m.maxRounds) &&
				m.maxRounds > 0 &&
				typeof m.locked === "boolean"
			);
		case "start_goal_wizard":
			return (
				keys(m, ["type", "text", "wizardModel", "maxRounds", "locked", "conversationId"]) &&
				nonempty(m.text) &&
				nonempty(m.conversationId) &&
				(m.wizardModel === undefined || nonempty(m.wizardModel)) &&
				(m.maxRounds === undefined ||
					(typeof m.maxRounds === "number" && Number.isSafeInteger(m.maxRounds) && m.maxRounds > 0)) &&
				(m.locked === undefined || typeof m.locked === "boolean")
			);
		case "schedule_save": {
			if (!keys(m, ["type", "task"]) || !m.task || typeof m.task !== "object" || Array.isArray(m.task)) return false;
			const task = m.task as Fields;
			return (
				keys(task, [
					"id",
					"name",
					"description",
					"cwd",
					"kind",
					"spec",
					"prompt",
					"model",
					"thinkingLevel",
					"catchUp",
				]) &&
				optionalText(task.id) &&
				nonempty(task.name) &&
				text(task.description) &&
				nonempty(task.cwd) &&
				(task.kind === "cron" || task.kind === "interval") &&
				nonempty(task.spec) &&
				(task.kind !== "interval" || (Number.isFinite(Number(task.spec)) && Number(task.spec) > 0)) &&
				nonempty(task.prompt) &&
				text(task.model) &&
				text(task.thinkingLevel) &&
				(task.catchUp === "once" || task.catchUp === "skip")
			);
		}
		case "prompt":
			return (
				keys(m, ["type", "text", "queue", "attachments", "id", "forSession"]) &&
				text(m.text) &&
				(m.text.length > 0 || (Array.isArray(m.attachments) && m.attachments.length > 0)) &&
				(m.queue === undefined || typeof m.queue === "boolean") &&
				optionalText(m.id) &&
				optionalText(m.forSession) &&
				attachments(m.attachments)
			);
		case "edit_message":
			return (
				keys(m, ["type", "messageId", "text", "attachments"]) &&
				nonempty(m.messageId) &&
				nonempty(m.text) &&
				attachments(m.attachments)
			);
		case "run_command": {
			const command = m.command;
			if (!command || typeof command !== "object" || Array.isArray(command)) return false;
			const c = command as Fields;
			return (
				keys(m, ["type", "terminalId", "command", "cols", "rows", "conversationId", "reqId", "original"]) &&
				matchesAuthoredCommand(message) &&
				nonempty(m.terminalId) &&
				keys(c, ["name", "command", "cwd"]) &&
				text(c.name) &&
				nonempty(c.command) &&
				optionalText(c.cwd) &&
				typeof m.cols === "number" &&
				Number.isFinite(m.cols) &&
				typeof m.rows === "number" &&
				Number.isFinite(m.rows) &&
				optionalText(m.conversationId)
			);
		}
		case "identity_file_save":
			return (
				requiresRecoveryAdmission(message) &&
				keys(m, ["type", "id", "file", "text", "baseHash", "ref", "reqId"]) &&
				nonempty(m.id) &&
				text(m.text) &&
				text(m.baseHash) &&
				optionalText(m.ref) &&
				optionalText(m.reqId)
			);
		case "identity_note_save":
			return (
				keys(m, ["type", "id", "ref", "text", "baseHash", "reqId"]) &&
				nonempty(m.id) &&
				nonempty(m.ref) &&
				text(m.text) &&
				text(m.baseHash) &&
				optionalText(m.reqId)
			);
		case "board_post":
			return (
				keys(m, ["type", "kind", "to", "title", "text", "reqId"]) &&
				(m.kind === "news" || m.kind === "order") &&
				(m.to === "all" || (Array.isArray(m.to) && m.to.length > 0 && m.to.every(nonempty))) &&
				text(m.title) &&
				text(m.text) &&
				optionalText(m.reqId)
			);
		case "board_close":
			return (
				requiresRecoveryAdmission(message) &&
				keys(m, ["type", "id", "note", "reqId"]) &&
				nonempty(m.id) &&
				text(m.note) &&
				optionalText(m.reqId)
			);
		default:
			return false;
	}
}
