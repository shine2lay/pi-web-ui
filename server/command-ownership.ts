import { createHash } from "node:crypto";
import { matchesAuthoredCommand } from "./command-intent.js";
import type { ClientMessage, CommandDef, TerminalInfo } from "./protocol.js";

interface Manager {
	list(): TerminalInfo[];
	runCommand(id: string, command: CommandDef, cols: number, rows: number, cwd: string): void;
}
interface Host {
	readonly cwd: string;
	activeSessionId?(): string;
	activeConversationId?(): string;
	getTerminalManager(conversationId: string): Manager | undefined;
}
export type CommandClaim =
	{ kind: "claimed"; run(): void } | { kind: "refused"; status: "unprocessed" | "uncertain"; reason: string };
const claims = new WeakMap<object, Map<string, string>>();

/** One in-process host owner per exact authored request. This is not a durable
 * receipt: after restart clients still keep unresolved originals and never auto replay. */
export function claimAuthoredCommand(
	host: Host,
	message: Extract<ClientMessage, { type: "run_command" }>,
): CommandClaim {
	const refuse = (reason: string, status: "unprocessed" | "uncertain" = "unprocessed"): CommandClaim => ({
		kind: "refused",
		status,
		reason,
	});
	if (
		!matchesAuthoredCommand(message) ||
		!message.original ||
		!message.recovery ||
		message.recovery.id !== message.reqId ||
		message.recovery.sessionId !== message.original.sessionId
	)
		return refuse("invalid-command-source");
	const source = structuredClone(message.original);
	const fingerprint = createHash("sha256").update(JSON.stringify(source)).digest("hex");
	let seen = claims.get(host);
	const earlier = seen?.get(source.requestId);
	if (earlier)
		return refuse(earlier === fingerprint ? "command-already-owned" : "command-identity-conflict", "uncertain");
	const bound = () =>
		host.cwd === source.workspaceCwd &&
		host.activeConversationId?.() === source.conversationId &&
		host.activeSessionId?.() === source.sessionId;
	if (!bound()) return refuse("command-target-changed");
	const manager = host.getTerminalManager(source.conversationId);
	if (!manager || typeof manager.list !== "function") return refuse("command-target-unavailable");
	const matchesTerminal = () => {
		const actual = manager.list().find((item) => item.id === source.terminal.id);
		return source.terminal.mode === "new"
			? !actual
			: !!actual && !actual.agentBash && actual.title === source.terminal.title && actual.cwd === source.terminal.cwd;
	};
	if (!matchesTerminal()) return refuse("command-terminal-changed");
	if (!seen) {
		seen = new Map();
		claims.set(host, seen);
	}
	seen.set(source.requestId, fingerprint);
	let invoked = false;
	return {
		kind: "claimed",
		run() {
			if (invoked) return;
			invoked = true;
			if (!bound() || host.getTerminalManager(source.conversationId) !== manager || !matchesTerminal())
				throw new Error("The original command target changed after ownership; original retained, no replay.");
			manager.runCommand(
				source.terminal.id,
				source.command,
				source.terminal.cols,
				source.terminal.rows,
				source.workspaceCwd,
			);
		},
	};
}
