/** H1/H2/H3/H4 host seam, Task 1 only. No installation, tools or live registry.
 * The eventual host owns binding/leases; identity owns the ceiling decision;
 * queue owns HOME acceptance. These ports must not implement copies of either.
 */
import type { InboxRuntime } from "./inbox-runtime.js";
import type { InboxClass, InboxNeed, InboxOutcome, InboxPriority } from "./shared/inbox-wire.js";
import type { TaskStartHooks } from "./task-chat-start.js";

export interface InboxHelperBinding {
	role: string;
	msgId: string;
	leaseId: string;
	epoch: number;
	homeChat: string;
}
export interface InboxHelperLaunch extends InboxHelperBinding {
	sessionId: string;
	sessionFile: string;
	class: InboxClass;
	priority: InboxPriority;
	tools: readonly string[];
}
export type InboxToolDecision = { allowed: true } | { allowed: false; code: string };
export interface InboxHelperHostPorts {
	runtime: InboxRuntime;
	allocate(role: string): { sessionId: string; sessionFile: string };
	sealTools(role: string): Promise<readonly string[]>;
	/** Production supplies the one pi-identity resolver, including schema/narrowing. */
	decideTool(sessionId: string, name: string, args: unknown): Promise<InboxToolDecision>;
	/** Journal entries/seal precede this call; implementation uses startTaskChat. */
	launch(binding: InboxHelperLaunch, hooks: TaskStartHooks): Promise<void>;
	append(sessionFile: string, customType: string, data: unknown): void;
	working(sessionId: string): boolean;
	close(sessionId: string): Promise<boolean>;
	archive(sessionId: string): Promise<void>;
}
export interface InboxHelperAdmission {
	role: string;
	homeChat: string;
	homeWorking: boolean;
	k: 3 | 4;
}
const unbuilt = (): never => {
	throw new Error("E_RPI_UNBUILT: helper host is not installed");
};

/** Consumers may query the installed host by this exact H1 name. No binding exists
 * in Task 1. A missing binding must never downgrade a helper entry to plain role.
 */
export function inboxHelperBinding(_sessionId: string): InboxHelperBinding | undefined {
	return undefined;
}

export class InboxHelperHost {
	constructor(readonly ports: InboxHelperHostPorts) {}
	inboxHelperBinding(_sessionId: string): InboxHelperBinding | undefined {
		return unbuilt();
	}
	admit(_admission: InboxHelperAdmission): Promise<readonly InboxHelperLaunch[]> {
		return unbuilt();
	}
	call(
		_sessionId: string,
		_name: string,
		_args: unknown,
		_dispatch: () => Promise<unknown>,
	): Promise<InboxToolDecision> {
		return unbuilt();
	}
	end(_sessionId: string, _outcome: InboxOutcome): Promise<void> {
		return unbuilt();
	}
	release(_sessionId: string, _need: InboxNeed): Promise<void> {
		return unbuilt();
	}
	reconcile(): Promise<void> {
		return unbuilt();
	}
	live(_role: string): number {
		return unbuilt();
	}
}
