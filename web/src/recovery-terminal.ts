import { isAuthoredCommandIntent } from "../../server/command-intent";
import type { AuthoredCommandIntent, ClientMessage, TerminalViewReply } from "./types";
import type { AdmissionBinding } from "./recovery-admission";
import type { createRecoveryChatTransport } from "./recovery-chat";
import type { TerminalAttachIntent } from "./components/TermXterm";
import { randomUuid } from "./uuid";

type Bridge = Pick<ReturnType<typeof createRecoveryChatTransport>, "admit" | "captureBinding" | "isCurrent">;
interface PendingView {
	binding: AdmissionBinding;
	intent: TerminalAttachIntent;
	replace: (data: string) => void;
	resolve: (value: boolean) => void;
}

/** Binds the reviewed command/renderer callbacks to one actual document recovery
 * owner. Import and renderer mount never execute a command. */
export function createTerminalRecovery(bridge: Bridge) {
	const views = new Map<string, PendingView>();
	const sameTarget = (binding: AdmissionBinding, intent: { conversationId: string; sessionId: string }) =>
		binding.conversationId === intent.conversationId && binding.sessionId === intent.sessionId;
	return {
		async command(input: AuthoredCommandIntent): Promise<boolean> {
			const binding = bridge.captureBinding();
			if (
				!binding ||
				!isAuthoredCommandIntent(input) ||
				!sameTarget(binding, input) ||
				binding.workspace !== input.workspaceCwd ||
				!bridge.isCurrent(binding)
			)
				return false;
			const original = structuredClone(input);
			const message: ClientMessage = {
				type: "run_command",
				reqId: original.requestId,
				original,
				terminalId: original.terminal.id,
				command: original.command,
				cols: original.terminal.cols,
				rows: original.terminal.rows,
				conversationId: original.conversationId,
			};
			// The complete original is in the ordinary immutable C payload before any wire/clear.
			return (await bridge.admit(message, binding)) === true;
		},
		attach(input: TerminalAttachIntent, replace: (data: string) => void): Promise<boolean> {
			const binding = bridge.captureBinding();
			if (
				!binding ||
				!sameTarget(binding, input) ||
				!bridge.isCurrent(binding) ||
				!input.viewId ||
				!input.terminalId ||
				!Number.isFinite(input.cols) ||
				!Number.isFinite(input.rows)
			)
				return Promise.resolve(false);
			const intent = structuredClone(input);
			const reqId = `terminal-view-${randomUuid()}`;
			return new Promise((resolve) => {
				views.set(reqId, { binding, intent, replace, resolve });
				try {
					const socket = binding.transport as Pick<WebSocket, "send">;
					socket.send(JSON.stringify({ type: "terminal_attach", reqId, ...intent } satisfies ClientMessage));
				} catch {
					views.delete(reqId);
					resolve(false);
				}
			});
		},
		receive(owner: object, message: TerminalViewReply): boolean {
			const pending = views.get(message.reqId);
			if (
				!pending ||
				pending.binding.transport !== owner ||
				message.viewId !== pending.intent.viewId ||
				message.terminalId !== pending.intent.terminalId ||
				!sameTarget(pending.binding, message)
			)
				return false;
			views.delete(message.reqId);
			if (
				!bridge.isCurrent(pending.binding) ||
				!message.available ||
				message.terminal.id !== pending.intent.terminalId ||
				typeof message.data !== "string" ||
				!Number.isSafeInteger(message.offset) ||
				message.offset < 0
			) {
				pending.resolve(false);
				return true;
			}
			try {
				pending.replace(message.data);
				pending.resolve(bridge.isCurrent(pending.binding));
			} catch {
				pending.resolve(false);
			}
			return true;
		},
		cancel(): void {
			for (const pending of views.values()) pending.resolve(false);
			views.clear();
		},
	};
}
