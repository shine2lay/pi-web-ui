/** SDK-backed consult lifecycle. The identity extension, never this adapter, admits/seals a consult. */
import { closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
	createAgentSessionServices,
	createAgentSessionFromServices,
	createEventBus,
	SessionManager,
	type AgentSession,
	type AgentSessionServices,
	type EventBus,
} from "@earendil-works/pi-coding-agent";
import {
	createConsultChildFile,
	makeConsultSpecialistTool,
	type ConsultAdmission,
	type ConsultArgs,
	type ConsultHost,
	type ConsultResult,
} from "./specialist-consult.js";
import { identityOfEntry } from "./specialist-entry.js";
import { validateRawToolInvocation } from "./specialist-raw-runtime.js";

const CHANNEL = "pi-identity:specialist";
type Row = Record<string, unknown>;
const object = (value: unknown): value is Row => !!value && typeof value === "object" && !Array.isArray(value);

/** Timeout refuses admission; it is not a child runtime limit and never retries effects. */
export function specialistRequest(bus: EventBus, session: AgentSession, request: Row): Promise<Row> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("E_SPEC_UNAVAILABLE: identity host did not reply")), 5000);
		try {
			bus.emit(CHANNEL, {
				...request,
				v: 1,
				op: "consult",
				sessionId: session.sessionManager.getSessionId(),
				reply: (answer: unknown) => {
					clearTimeout(timeout);
					object(answer) ? resolve(answer) : reject(new Error("E_SPEC_UNAVAILABLE"));
				},
			});
		} catch (error) {
			clearTimeout(timeout);
			reject(error);
		}
	});
}

function persistedRecords(file: string): Row[] {
	const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Row)
		.filter((row) => row.type === "custom" && row.customType === "specialist-consult" && object(row.data))
		.map((row) => row.data as Row);
}

export function consultRuntimeChannel(session: () => AgentSession, bus: EventBus): ConsultHost["channel"] {
	return {
		async admit(req): Promise<ConsultAdmission> {
			const caller = session();
			if (caller.sessionFile !== req.callerFile) return { ok: false, code: "E_SPEC_DENIED" };
			const original = validateRawToolInvocation(
				caller.sessionManager.getSessionId(),
				req.toolCallId,
				"consult_specialist",
			);
			if (original.status !== "valid")
				return { ok: false, code: original.status === "invalid" ? "E_SPEC_DENIED" : "E_SPEC_UNAVAILABLE" };
			// Admission receives the immutable original, never SDK-coerced arguments.
			const originalArgs = original.args as ConsultArgs;
			// A persisted start with no end is a recoverable interrupted attempt, not a second admission.
			const previous = persistedRecords(req.callerFile).find(
				(row) => row.op === "start" && row.consultId === req.consultId,
			);
			const args: ConsultArgs = previous ? { ...originalArgs, consult_id: req.consultId } : originalArgs;
			// Deployment requires the landed OV #1114 readers; this is not a discovered capability.
			const reply = await specialistRequest(bus, caller, { toolCallId: req.toolCallId, args, readersUpdated: true });
			const answer = object(reply.consult) ? reply.consult : {};
			if (reply.ok !== true || answer.result !== "allow")
				return {
					ok: false,
					code: typeof answer.code === "string" ? answer.code : "E_SPEC_UNAVAILABLE",
					...(typeof answer.step === "number" ? { step: answer.step } : {}),
				};
			// Read back the actual durable record before any child creation. Resume responses intentionally
			// omit authority fields: these must come from the original frozen start, not current configuration.
			const records = persistedRecords(req.callerFile).filter((row) => row.consultId === req.consultId);
			const start = records.find((row) => row.op === "start");
			if (
				!start ||
				typeof start.slug !== "string" ||
				typeof start.callerPrincipal !== "string" ||
				!Array.isArray(start.childTools) ||
				!start.childTools.every((tool) => typeof tool === "string") ||
				typeof start.childToolsSha256 !== "string"
			)
				return { ok: false, code: "E_SPEC_DENIED" };
			if (createHash("sha256").update(JSON.stringify(start.childTools)).digest("hex") !== start.childToolsSha256)
				return { ok: false, code: "E_SPEC_DENIED" };
			const dept = start.callerPrincipal.split("/")[0]!;
			const end = records.filter((row) => row.op === "end").at(-1);
			return {
				ok: true,
				consultId: req.consultId,
				dept,
				slug: start.slug,
				principal: `${dept}/${start.slug}`,
				callerPrincipal: start.callerPrincipal,
				childTools: start.childTools as string[],
				childToolsSha256: start.childToolsSha256,
				...(args.consult_id || previous
					? {
							resume:
								end?.state === "done"
									? { state: "done" as const, answer: typeof end.answer === "string" ? end.answer : "" }
									: { state: "partial" as const, answer: typeof end?.answer === "string" ? end.answer : "" },
						}
					: {}),
			};
		},
		async end(consultId: string, result: ConsultResult) {
			const caller = session();
			const reply = await specialistRequest(bus, caller, {
				end: {
					consultId,
					outcome: result.state === "partial" ? result.reason : result.state,
					answer: result.answer,
					code: result.code,
				},
			});
			if (reply.ok !== true || !caller.sessionFile) throw new Error("E_SPEC_UNAVAILABLE: end was not persisted");
			const last = persistedRecords(caller.sessionFile)
				.filter((row) => row.consultId === consultId && row.op === "end")
				.at(-1);
			if (!last || last.state !== result.state) throw new Error("E_SPEC_DENIED: consult end readback failed");
		},
	};
}

function validateChild(file: string, caller: AgentSession): SessionManager {
	const stat = lstatSync(file);
	const folder = lstatSync(dirname(file));
	if (!stat.isFile() || stat.mode & 0o077 || !folder.isDirectory() || folder.mode & 0o077)
		throw new Error("E_SPEC_DENIED: child is not private");
	const manager = SessionManager.open(file);
	const first = manager.getBranch().find((entry) => entry.type === "custom" && entry.customType === "identity");
	const binding = first ? identityOfEntry(first) : undefined;
	if (
		!binding ||
		binding === "unusable" ||
		!binding.consult ||
		binding.consult.caller !== caller.sessionFile ||
		basename(file) !== `${binding.consult.id}.jsonl`
	)
		throw new Error("E_SPEC_DENIED: wrong consult binding");
	return manager;
}

export interface ConsultRuntimeOptions {
	session: () => AgentSession;
	services: AgentSessionServices;
	bus: EventBus;
	/** Installs the agreed strict raw-invocation bridge before any child tool may execute. */
	installRawGuard: (session: AgentSession, bus: EventBus) => () => void;
}

export function makeRuntimeConsultTool(options: ConsultRuntimeOptions) {
	const host: ConsultHost = {
		channel: consultRuntimeChannel(options.session, options.bus),
		createChild: createConsultChildFile,
		runner: {
			async run(request) {
				const caller = options.session();
				try {
					lstatSync(request.childFile);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !caller.sessionFile) throw error;
					const id = basename(request.childFile, ".jsonl");
					const start = persistedRecords(caller.sessionFile).find((row) => row.op === "start" && row.consultId === id);
					if (!start || typeof start.callerPrincipal !== "string" || typeof start.slug !== "string")
						throw new Error("E_SPEC_DENIED");
					createConsultChildFile(request.childFile, {
						v: 1,
						id: start.callerPrincipal.split("/")[0]!,
						via: "consult",
						specialist: start.slug,
						consult: { id, caller: caller.sessionFile, callerPrincipal: start.callerPrincipal },
					});
				}
				const manager = validateChild(request.childFile, caller);
				const bus = createEventBus();
				const services = await createAgentSessionServices({
					cwd: manager.getCwd(),
					modelRuntime: options.services.modelRuntime,
					resourceLoaderOptions: { eventBus: bus, noContextFiles: true },
				});
				// Only SDK-builtins and extensions instantiated for this child may execute. Never copy
				// caller custom-tool closures: even a read-only name can retain caller authority.
				// A sealed tool absent from this child-owned registry fails closed below.
				const created = await createAgentSessionFromServices({
					services,
					sessionManager: manager,
					model: caller.model,
					thinkingLevel: caller.thinkingLevel,
					tools: [...request.tools],
				});
				const child = created.session;
				let cleanup: (() => void) | undefined;
				let text = child.messages
					.filter((message) => message.role === "assistant")
					.map((message) =>
						message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join(""),
					)
					.join("\n");
				let outcome: "done" | "limit" | "interrupted" | "caller_gone" | "error" = "done";
				const abort = () => {
					void child.abort();
				};
				try {
					// Register the child in the same process-wide trusted queue-host callback registry
					// before binding extensions or sending the first identity-gate request.
					cleanup = options.installRawGuard(child, bus);
					await child.bindExtensions({
						mode: "rpc",
						onError: () => {
							outcome = "error";
						},
					});
					// A current identity host recognizes the child's sticky binding and refuses nested consults.
					const probe = await specialistRequest(bus, child, {});
					if (!object(probe.consult) || probe.consult.code !== "E_SPEC_DENIED" || probe.consult.step !== 4)
						throw new Error("E_SPEC_UNAVAILABLE: consult identity gate unavailable");
					if (request.tools.some((name) => !child.getToolDefinition(name)))
						throw new Error("E_SPEC_UNAVAILABLE: sealed tool missing");
					child.setActiveToolsByName([...request.tools]);
					const unsubscribe = child.subscribe((event) => {
						if (event.type === "tool_execution_start" && (!caller.sessionFile || !existsSync(caller.sessionFile))) {
							outcome = "caller_gone";
							abort();
						}
						if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
							text += event.assistantMessageEvent.delta;
						if (event.type === "message_end" && event.message.role === "assistant") {
							if (event.message.stopReason === "aborted" && outcome !== "caller_gone") outcome = "interrupted";
							else if (event.message.stopReason === "length") outcome = "limit";
							else if (event.message.stopReason === "error")
								outcome = /rate.?limit|context.?length|quota|token.?limit|429|budget/i.test(
									event.message.errorMessage ?? "",
								)
									? "limit"
									: "error";
						}
					});
					try {
						request.signal?.addEventListener("abort", abort, { once: true });
						if (request.signal?.aborted) outcome = "interrupted";
						else if (!caller.sessionFile || !existsSync(caller.sessionFile)) outcome = "caller_gone";
						else await child.prompt(request.prompt);
					} finally {
						unsubscribe();
					}
					return { outcome, text };
				} catch (error) {
					const limited = /rate.?limit|context.?length|quota|token.?limit|429|budget/i.test(
						error instanceof Error ? error.message : "",
					);
					return {
						outcome:
							outcome === "caller_gone"
								? ("caller_gone" as const)
								: request.signal?.aborted
									? ("interrupted" as const)
									: limited
										? ("limit" as const)
										: ("error" as const),
						text,
						...(limited ? {} : { code: "E_SPEC_UNAVAILABLE" }),
					};
				} finally {
					request.signal?.removeEventListener("abort", abort);
					cleanup?.();
					child.dispose();
				}
			},
		},
	};
	return makeConsultSpecialistTool(host);
}
