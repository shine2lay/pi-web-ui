/** Pure, field-sensitive command-source contract shared by host and browser.
 * No unknown fields, secret/config forms or raw PTY streams acquire persistence permission. */
import type { AuthoredCommandIntent, ClientMessage } from "./protocol.js";

type Fields = Record<string, unknown>;
function data(value: unknown, allowed: string[]): value is Fields {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Reflect.ownKeys(value).every(
		(key) =>
			typeof key === "string" &&
			allowed.includes(key) &&
			Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), "value"),
	);
}
const text = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string => text(value) && value.trim().length > 0;
const size = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 2;

export function isAuthoredCommandIntent(value: unknown): value is AuthoredCommandIntent {
	if (
		!data(value, [
			"requestId",
			"source",
			"conversationId",
			"sessionId",
			"workspaceCwd",
			"command",
			"terminal",
			"commitSource",
		])
	)
		return false;
	if (
		![value.requestId, value.conversationId, value.sessionId, value.workspaceCwd].every(id) ||
		(value.source !== "scm" && value.source !== "terminal")
	)
		return false;
	const command = value.command;
	const terminal = value.terminal;
	if (
		!data(command, ["name", "command", "cwd"]) ||
		!text(command.name) ||
		!id(command.command) ||
		(command.cwd !== undefined && !text(command.cwd))
	)
		return false;
	if (
		!data(terminal, ["id", "title", "cwd", "cols", "rows", "mode", "running", "exitCode"]) ||
		!id(terminal.id) ||
		!text(terminal.title) ||
		!id(terminal.cwd) ||
		!size(terminal.cols) ||
		!size(terminal.rows) ||
		(terminal.mode !== "new" && terminal.mode !== "existing") ||
		typeof terminal.running !== "boolean" ||
		(terminal.exitCode !== null && (typeof terminal.exitCode !== "number" || !Number.isSafeInteger(terminal.exitCode)))
	)
		return false;
	if (terminal.mode === "new" && (terminal.running || terminal.exitCode !== null)) return false;
	if (value.commitSource !== undefined) {
		if (
			value.source !== "scm" ||
			!data(value.commitSource, ["text", "revision"]) ||
			!text(value.commitSource.text) ||
			typeof value.commitSource.revision !== "number" ||
			!Number.isSafeInteger(value.commitSource.revision) ||
			value.commitSource.revision < 0
		)
			return false;
	}
	return true;
}

export function matchesAuthoredCommand(message: Extract<ClientMessage, { type: "run_command" }>): boolean {
	const original = message.original;
	if (!isAuthoredCommandIntent(original) || !data(message.command, ["name", "command", "cwd"])) return false;
	return (
		message.reqId === original.requestId &&
		message.conversationId === original.conversationId &&
		message.terminalId === original.terminal.id &&
		message.cols === original.terminal.cols &&
		message.rows === original.terminal.rows &&
		message.command.name === original.command.name &&
		message.command.command === original.command.command &&
		message.command.cwd === original.command.cwd &&
		Object.hasOwn(message.command, "cwd") === Object.hasOwn(original.command, "cwd")
	);
}
