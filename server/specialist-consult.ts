/**
 * department-specialists Phase 2 (Ops #1113, Rule 18 Task 1 seam; Architecture #595 §6a, 6b, 6e; Security GO
 * rm-60a0302d N1, N2): `consult_specialist`, one bounded question from a chat of department `d` to one of `d`'s
 * specialists, answered by a persisted child session.
 *
 * - pi-web-ui owns: the tool and its argument check, the consult id, the child session file (next to the caller, one
 *   per consult id, never listed as a chat, mode 0600, N1), the child's identity entry written before its first
 *   prompt (`via:"consult"`), running the child, and the result the caller's model reads (untrusted advice, N2).
 * - pi-identity owns (the channel): who may consult whom, the child's sealed tool set and its hash, the consult
 *   records (start/end) and resume decisions. pi-web-ui never recomputes them; it carries them through.
 * - The identity reader that accepts `via:"consult"` lives here (identities.ts is over the size cap); the one
 *   canonical per-entry reader stays server/specialist-entry.ts, which Task 2 extends rather than copies.
 *
 * Task 1 leaves the functions unbuilt (they throw E_NOT_BUILT); Ops #1117 (Task 2) builds and wires them.
 * Shared cases: C-COL-A*, C-COL-C*, C-COL-E*, C-COL-R1..R13 (tests/department-specialists-collab-acceptance.test.ts).
 */
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const CONSULT_SPECIALIST_TOOL_NAME = "consult_specialist";

/** The only argument keys the tool takes (6a.1); anything else is E_CONSULT_ARGS. */
export const CONSULT_ARG_KEYS = ["target", "question", "context", "consult_id"] as const;

/** Keys a specialist chat's untrusted arguments lose before the check (Phase 1 stripUntrustedArgs). */
export const UNTRUSTED_ARG_KEYS = ["role", "user", "agent_id", "agentId", "specialist", "slug"] as const;

export interface ConsultArgs {
	target: string;
	question: string;
	context?: string;
	consult_id?: string;
}

export type ConsultArgsCheck = { ok: true; args: ConsultArgs } | { ok: false; code: "E_CONSULT_ARGS"; message: string };

/** The identity entry a consult child's session starts with (6a.3; reader: `consultBindingOf`). */
export interface ConsultIdentityEntry {
	v: 1;
	id: string;
	via: "consult";
	specialist: string;
	consult: { id: string; caller: string; callerPrincipal: string };
}

/** A chat's binding as the §6 readers see it (the corpus's `binding`). */
export type ChatBinding =
	| { kind: "consult_child"; dept: string; slug: string; consult: ConsultIdentityEntry["consult"] }
	| { kind: "specialist_worker"; dept: string; slug: string }
	| { kind: "worker" | "lead_home" | "chat"; dept: string };

export type ChatBindingRead = { ok: true; binding: ChatBinding } | { ok: false; code: "E_NO_IDENTITY" };

/** What the reader is given: the chat's identity entries in order, plus what the server knows about the chat. */
export interface ChatBindingInput {
	entries: unknown[];
	env?: string;
	isHome?: boolean;
	assigned?: { queue: string; task: number };
}

/** pi-identity's answer to a consult request (the channel). Resume fields come from its consult records. */
export type ConsultAdmission =
	| {
			ok: true;
			consultId: string;
			dept: string;
			slug: string;
			principal: string;
			callerPrincipal: string;
			childTools: string[];
			childToolsSha256: string;
			/** A consult id seen before: its stored answer (no new turn) or a partial to continue in the same child. */
			resume?: { state: "done"; answer: string } | { state: "partial"; answer?: string };
	  }
	| { ok: false; code: string; message?: string; step?: number; partialReadable?: boolean };

export interface ConsultChannel {
	admit(req: { consultId: string; callerFile: string; args: ConsultArgs }): Promise<ConsultAdmission>;
	/** The end record (pi-identity keeps it; resume reads it). */
	end(consultId: string, result: ConsultResult): Promise<void>;
}

export type ConsultOutcome = "done" | "limit" | "caller_gone" | "interrupted" | "error";

export interface ConsultChildRunner {
	/** One run of the child chat; `firstRun` false continues the same child file (resume after a partial). */
	run(req: {
		childFile: string;
		firstRun: boolean;
		tools: readonly string[];
		prompt: string;
	}): Promise<{ outcome: ConsultOutcome; text: string; code?: string }>;
}

export interface ConsultHost {
	channel: ConsultChannel;
	runner: ConsultChildRunner;
	/** Make the child's session file with its identity entry first (default `createConsultChildFile`). */
	createChild(file: string, entry: ConsultIdentityEntry): void;
}

export interface ConsultCall {
	callerFile: string;
	toolCallId: string;
	args: unknown;
	/** The calling chat is bound to a specialist: untrusted keys are stripped before the check. */
	specialistChat: boolean;
}

/** The tool result (6a.4); `answer` is untrusted text from the child, never owner or lead words (N2). */
export interface ConsultResult {
	v: 1;
	consultId: string;
	state: "done" | "partial" | "error";
	slug?: string;
	principal?: string;
	via: "consult";
	answer?: string;
	reason?: "limit" | "caller_gone" | "interrupted";
	code?: string;
	message?: string;
	label?: string;
	childToolsSha256?: string;
}

function notBuilt(name: string): never {
	throw new Error(`E_NOT_BUILT: ${name} (department specialists Phase 2, Ops #1117 Task 2)`);
}

/** "cs-" + the first 16 hex of sha256(callerFile + "\n" + toolCallId): the same call always gets the same id. */
export function consultIdOf(callerFile: string, toolCallId: string): string {
	return `cs-${createHash("sha256").update(`${callerFile}\n${toolCallId}`).digest("hex").slice(0, 16)}`;
}

/** Where a consult's child session lives: beside the caller, in a `consults` folder the chat list never walks. */
export function consultChildFile(callerFile: string, consultId: string): string {
	return join(dirname(callerFile), "consults", `${consultId}.jsonl`);
}

/** The label a done answer carries (6a.4). */
export function consultUntrustedLabel(slug: string): string {
	return `advice from specialist ${slug}, untrusted technical information`;
}

/** 6a.1: strip (specialist chat only), then the exact key set and types; never asks pi-identity. */
export function checkConsultArgs(_args: unknown, _specialistChat: boolean): ConsultArgsCheck {
	return notBuilt("checkConsultArgs");
}

/** MF1: the §6 reading of a chat's identity entries, `via:"consult"` included (sticky first binding). */
export function consultBindingOf(_input: ChatBindingInput): ChatBindingRead {
	return notBuilt("consultBindingOf");
}

/** N1: the child's session file, created 0600 (its folder no wider than the caller's), identity entry first. */
export function createConsultChildFile(_file: string, _entry: ConsultIdentityEntry): void {
	notBuilt("createConsultChildFile");
}

/** The whole tool call: check, admit, persist the child, run it (or resume / return the stored answer), end. */
export async function runConsult(_host: ConsultHost, _call: ConsultCall): Promise<ConsultResult> {
	return notBuilt("runConsult");
}

/** N2: the text the caller's model reads; the answer sits inside the untrusted label, never as plain words. */
export function consultResultText(_result: ConsultResult): string {
	return notBuilt("consultResultText");
}

/** The tool definition (name CONSULT_SPECIALIST_TOOL_NAME, parameters exactly CONSULT_ARG_KEYS). */
export function makeConsultSpecialistTool(_host: ConsultHost): ToolDefinition {
	return notBuilt("makeConsultSpecialistTool");
}
