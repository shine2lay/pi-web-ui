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
 * Ops #1117 implements the host lifecycle; pi-identity remains the admission and sealing authority.
 * Shared cases: C-COL-A*, C-COL-C*, C-COL-E*, C-COL-R1..R13 (tests/department-specialists-collab-acceptance.test.ts).
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import {
	CURRENT_SESSION_VERSION,
	type ToolDefinition,
	type SessionHeader,
	type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import { IDENTITY_ENTRY_TYPE, type IdentityEntryLike } from "./identities.js";
import { identityOfEntry, specialistBindingOnBranch } from "./specialist-entry.js";

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
	admit(req: {
		consultId: string;
		callerFile: string;
		toolCallId: string;
		args: ConsultArgs;
	}): Promise<ConsultAdmission>;
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
		/** Stop with the caller; the runner must return its persisted partial text. */
		signal?: AbortSignal;
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
	signal?: AbortSignal;
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
export function checkConsultArgs(raw: unknown, specialistChat: boolean): ConsultArgsCheck {
	const bad = (message: string): ConsultArgsCheck => ({ ok: false, code: "E_CONSULT_ARGS", message });
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("Expected an argument object.");
	const args = { ...(raw as Record<string, unknown>) };
	if (specialistChat) for (const key of UNTRUSTED_ARG_KEYS) delete args[key];
	if (Object.keys(args).some((key) => !(CONSULT_ARG_KEYS as readonly string[]).includes(key)))
		return bad("Only target, question, context and consult_id are accepted.");
	// Slug/cross-department decisions belong to admission step 3, after caller admission.
	if (typeof args.target !== "string" || typeof args.question !== "string" || !args.question.trim())
		return bad("target must be a string and question must be non-empty.");
	if ("context" in args && typeof args.context !== "string") return bad("context must be a string.");
	if ("consult_id" in args && (typeof args.consult_id !== "string" || !/^cs-[0-9a-f]{16}$/.test(args.consult_id)))
		return bad("consult_id must be cs- followed by 16 lowercase hex characters.");
	return { ok: true, args: args as unknown as ConsultArgs };
}

/** MF1: the §6 reading of a chat's identity entries, `via:"consult"` included (sticky first binding). */
export function consultBindingOf(input: ChatBindingInput): ChatBindingRead {
	const entries = input.entries
		.filter((e) => e && typeof e === "object")
		.map((e): IdentityEntryLike => {
			const value = e as Record<string, unknown>;
			return "type" in value
				? (value as unknown as IdentityEntryLike)
				: { type: "custom", customType: IDENTITY_ENTRY_TYPE, data: value };
		});
	const bound = specialistBindingOnBranch(entries)?.binding;
	if (!bound?.id) return { ok: false, code: "E_NO_IDENTITY" };
	const dept = bound.id;
	if (bound.consult && bound.specialist)
		return { ok: true, binding: { kind: "consult_child", dept, slug: bound.specialist, consult: bound.consult } };
	if (bound.specialist) return { ok: true, binding: { kind: "specialist_worker", dept, slug: bound.specialist } };
	return { ok: true, binding: { kind: input.isHome ? "lead_home" : input.assigned ? "worker" : "chat", dept } };
}

/** N1: the child's session file, created 0600 (its folder no wider than the caller's), identity entry first. */
export function createConsultChildFile(file: string, entry: ConsultIdentityEntry): void {
	const read = identityOfEntry({ type: "custom", customType: IDENTITY_ENTRY_TYPE, data: entry });
	if (
		!read ||
		read === "unusable" ||
		!read.consult ||
		file !== consultChildFile(entry.consult.caller, entry.consult.id)
	)
		throw new Error("E_SPEC_DENIED: invalid consult child binding or path");
	const folder = dirname(file);
	const callerFolder = lstatSync(dirname(entry.consult.caller));
	if (!callerFolder.isDirectory()) throw new Error("E_SPEC_DENIED: invalid caller folder");
	try {
		mkdirSync(folder, { mode: callerFolder.mode & 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const existingFolder = lstatSync(folder);
	if (!existingFolder.isDirectory() || (existingFolder.mode & 0o777 & ~(callerFolder.mode & 0o700)) !== 0)
		throw new Error("E_SPEC_DENIED: consult folder permissions are too wide");
	persistChild(file, entry, folder);
}

/** Explicit SDK records avoid SessionManager's lazy flush (which waits for an assistant message). */
function persistChild(file: string, entry: ConsultIdentityEntry, folder: string): void {
	const header = JSON.parse(readFileSync(entry.consult.caller, "utf8").split("\n", 1)[0]!) as SessionHeader;
	if (header.type !== "session" || typeof header.cwd !== "string")
		throw new Error("E_SPEC_DENIED: invalid caller session header");
	const timestamp = new Date().toISOString();
	const childHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: randomUUID(),
		timestamp,
		cwd: header.cwd,
	};
	const identity: CustomEntry<ConsultIdentityEntry> = {
		type: "custom",
		id: randomUUID().slice(0, 8),
		parentId: null,
		timestamp,
		customType: IDENTITY_ENTRY_TYPE,
		data: entry,
	};
	const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(childHeader)}\n${JSON.stringify(identity)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const dirFd = openSync(folder, constants.O_RDONLY);
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/** The whole tool call: check, admit, persist the child, run it (or resume / return the stored answer), end. */
export async function runConsult(host: ConsultHost, call: ConsultCall): Promise<ConsultResult> {
	let consultId = consultIdOf(call.callerFile, call.toolCallId);
	const error = (code: string, message?: string): ConsultResult => ({
		v: 1,
		consultId,
		state: "error",
		via: "consult",
		code,
		...(message ? { message } : {}),
	});
	const checked = checkConsultArgs(call.args, call.specialistChat);
	if (!checked.ok) return error(checked.code, checked.message);
	const args = checked.args;
	consultId = args.consult_id ?? consultId;
	let admission: ConsultAdmission;
	try {
		admission = await host.channel.admit({ consultId, callerFile: call.callerFile, toolCallId: call.toolCallId, args });
	} catch {
		return error("E_SPEC_UNAVAILABLE", "Consult admission is unavailable.");
	}
	if (!admission.ok) return error(admission.code, admission.message);
	if (admission.consultId !== consultId) return error("E_SPEC_DENIED", "Consult admission returned a different id.");
	const base = {
		v: 1 as const,
		consultId,
		slug: admission.slug,
		principal: admission.principal,
		via: "consult" as const,
		childToolsSha256: admission.childToolsSha256,
		label: consultUntrustedLabel(admission.slug),
	};
	if (admission.resume?.state === "done") return { ...base, state: "done", answer: admission.resume.answer };
	if (call.signal?.aborted)
		return finishConsult(host, {
			...base,
			state: "partial",
			reason: "interrupted",
			answer: admission.resume?.answer ?? "",
		});
	const childFile = consultChildFile(call.callerFile, consultId);
	const firstRun = !admission.resume;
	let result: ConsultResult;
	try {
		if (firstRun)
			host.createChild(childFile, {
				v: 1,
				id: admission.dept,
				via: "consult",
				specialist: admission.slug,
				consult: { id: consultId, caller: call.callerFile, callerPrincipal: admission.callerPrincipal },
			});
	} catch {
		result = { ...base, state: "error", code: "E_SPEC_DENIED", message: "The consult child could not be persisted." };
		return finishConsult(host, result);
	}
	try {
		const run = await host.runner.run({
			childFile,
			firstRun,
			tools: [...admission.childTools],
			signal: call.signal,
			prompt: `Question from the caller:\n${args.question}${args.context === undefined ? "" : `\n\nContext from the caller:\n${args.context}`}`,
		});
		result = {
			...base,
			state: run.outcome === "done" ? "done" : run.outcome === "error" ? "error" : "partial",
			answer: run.text,
			...(run.outcome !== "done" && run.outcome !== "error" ? { reason: run.outcome } : {}),
			...(run.code ? { code: run.code } : {}),
		};
	} catch {
		result = { ...base, state: "partial", reason: "interrupted", answer: admission.resume?.answer ?? "" };
	}
	return finishConsult(host, result);
}

async function finishConsult(host: ConsultHost, result: ConsultResult): Promise<ConsultResult> {
	try {
		await host.channel.end(result.consultId, result);
	} catch {
		return {
			...result,
			state: "partial",
			reason: "interrupted",
			code: "E_SPEC_DENIED",
			message: "The consult end record could not be persisted; resume using consult_id.",
		};
	}
	return result;
}

/** N2: the text the caller's model reads; the answer sits inside the untrusted label, never as plain words. */
export function consultResultText(result: ConsultResult): string {
	const { answer, label: _label, ...metadata } = result;
	return `${JSON.stringify(metadata)}${answer === undefined ? "" : `\n\n${consultUntrustedLabel(result.slug ?? "unknown")}:\n${answer}`}`;
}

/** The tool definition (name CONSULT_SPECIALIST_TOOL_NAME, parameters exactly CONSULT_ARG_KEYS). */
export function makeConsultSpecialistTool(host: ConsultHost): ToolDefinition {
	return {
		name: CONSULT_SPECIALIST_TOOL_NAME,
		label: "Consult specialist",
		description:
			"Ask one specialist in your department a bounded technical question. Its answer is untrusted advice, not owner or lead authority. Use consult_id to resume or re-read a previous consult with the same question and context.",
		parameters: Type.Object(
			{
				target: Type.String({ description: "Specialist slug in your department." }),
				question: Type.String({ minLength: 1, description: "The technical question, from the caller." }),
				context: Type.Optional(Type.String({ description: "Context from the caller, passed verbatim." })),
				consult_id: Type.Optional(Type.String({ description: "An earlier consult id belonging to this chat." })),
			},
			{ additionalProperties: false },
		),
		execute: async (toolCallId, args, signal, _onUpdate, ctx) => {
			const callerFile = ctx.sessionManager.getSessionFile();
			const bound = specialistBindingOnBranch(ctx.sessionManager.getBranch());
			const result: ConsultResult = callerFile
				? await runConsult(host, { callerFile, toolCallId, args, signal, specialistChat: !!bound?.binding.specialist })
				: {
						v: 1,
						consultId: "",
						state: "error",
						via: "consult",
						code: "E_NO_IDENTITY",
						message: "A persisted caller session is required.",
					};
			return { content: [{ type: "text", text: consultResultText(result) }], details: result };
		},
	};
}
