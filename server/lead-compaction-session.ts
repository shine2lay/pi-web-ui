import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { LeadAdmission, type FileAdmission } from "./lead-compaction-admission.js";

type Call = (...args: unknown[]) => unknown;
const originals = new WeakMap<AgentSession, Map<string, Call>>();
const customOriginals = new WeakMap<Function, Function>();
const synchronousAdmission = new WeakMap<object, () => boolean>();
export function leadCustomMessageIsSynchronous(session: object): boolean {
	return synchronousAdmission.get(session)?.() ?? true;
}
export function unwrapLeadCustomMessage<T extends Function>(fn: T): T {
	return (customOriginals.get(fn) ?? fn) as T;
}
const appends = [
	"appendMessage",
	"appendThinkingLevelChange",
	"appendModelChange",
	"appendUsage",
	"appendCompaction",
	"appendCustomEntry",
	"appendSessionInfo",
	"appendCustomMessageEntry",
	"appendContextEdit",
	"appendLabelChange",
] as const;
const changes = [
	"branch",
	"resetLeaf",
	"branchWithSummary",
	"createBranchedSession",
	"setSessionFile",
	"newSession",
] as const;
const managers = new WeakSet<object>();
export const managerFenceRevision = new WeakMap<object, number>();
const notes = new WeakMap<FileAdmission, { customType: unknown; content: unknown; details: unknown }[]>();
/** Protect every public manager mutation, including writes originating inside the SDK. */
export function fenceManager(manager: AgentSession["sessionManager"], admission: LeadAdmission): void {
	if (managers.has(manager) || !manager.getSessionFile()) return;
	managers.add(manager);
	managerFenceRevision.set(manager, admission.file(manager.getSessionFile()!).revision);
	for (const method of [...appends, ...changes]) {
		const original = manager[method] as Call;
		if (typeof original !== "function") throw new Error("unsupported-native-api");
		Object.defineProperty(manager, method, {
			configurable: true,
			writable: true,
			value: (...args: unknown[]) => {
				const source = manager.getSessionFile();
				if (!source) return original.apply(manager, args);
				const file = admission.file(source);
				if (
					file.session &&
					file.session.sessionManager !== manager &&
					!admission.owns(file) &&
					method !== "createBranchedSession"
				)
					throw new Error("detached-native-writer");
				const result = admission.mutation(
					file,
					() => original.apply(manager, args),
					(changes as readonly string[]).includes(method),
				);
				if ((changes as readonly string[]).includes(method)) file.checkpoint = undefined;
				if (method === "appendMessage" && typeof result === "string") {
					const role = (args[0] as { role?: string })?.role;
					if (role === "assistant") file.checkpoint = { messageEntryId: result, toolResultEntryIds: [] };
					else if (role === "toolResult") file.checkpoint?.toolResultEntryIds.push(result);
				}
				if (method === "appendCustomMessageEntry") {
					const pending = notes.get(file) ?? [];
					const index = pending.findIndex(
						(n) => n.customType === args[0] && n.content === args[1] && n.details === args[3],
					);
					if (index >= 0) {
						pending.splice(index, 1);
						file.deferred--;
					}
				}
				if (file.session?.sessionManager === manager && manager.getSessionFile() !== source) {
					const session = file.session;
					file.session = undefined;
					file.generation++;
					admission.attach(session);
				}
				const currentSource = manager.getSessionFile();
				if (currentSource) managerFenceRevision.set(manager, admission.file(currentSource).revision);
				return result;
			},
		});
	}
}
/** Install after prompt-start/home-inbox wrappers. Fast path adds no admission await. */
export function fenceSession(session: AgentSession, admission: LeadAdmission): void {
	if (!session.sessionManager.getSessionFile()) return;
	admission.attach(session);
	synchronousAdmission.set(session, () => {
		const source = session.sessionManager.getSessionFile();
		if (!source) return true;
		const file = admission.file(source);
		return !file.locked && !file.recovery && file.session === session;
	});
	fenceManager(session.sessionManager, admission);
	if (originals.has(session)) return;
	const native = new Map<string, Call>();
	originals.set(session, native);
	for (const method of [
		"prompt",
		"steer",
		"followUp",
		"sendCustomMessage",
		"sendUserMessage",
		"reload",
		"compact",
		"navigateTree",
		"setModel",
		"cycleModel",
		"executeBash",
		"abort",
	] as const) {
		const original = session[method] as Call;
		if (typeof original !== "function") throw new Error("unsupported-native-api");
		native.set(method, original);
		const wrapped = (...args: unknown[]) => {
			const source = session.sessionManager.getSessionFile();
			if (!source) return original.apply(session, args);
			const file = admission.file(source);
			if (["reload", "navigateTree"].includes(method)) file.generation++;
			return admission.input(file, async (target) => {
				const fn = originals.get(target)?.get(method);
				if (!fn) throw new Error("unbound-native-owner");
				let note: { customType: unknown; content: unknown; details: unknown } | undefined;
				if (method === "sendCustomMessage") {
					const message = args[0] as { customType: unknown; content: unknown; details: unknown };
					// Track every native-deferred note until its actual native append, not pendingMessageCount.
					note = { customType: message.customType, content: message.content ?? [], details: message.details };
					args[0] = { ...message, content: note.content };
					const pending = notes.get(file) ?? [];
					pending.push(note);
					notes.set(file, pending);
					file.deferred++;
				}
				try {
					return await fn.apply(target, args);
				} catch (error) {
					const pending = notes.get(file) ?? [];
					const index = note ? pending.indexOf(note) : -1;
					if (index >= 0) {
						pending.splice(index, 1);
						file.deferred--;
					}
					throw error;
				}
			});
		};
		Object.defineProperty(session, method, { configurable: true, writable: true, value: wrapped });
		if (method === "sendCustomMessage") customOriginals.set(wrapped, original);
	}
	for (const method of [
		"setThinkingLevel",
		"cycleThinkingLevel",
		"setActiveToolsByName",
		"setCacheWarmingMode",
		"setSteeringMode",
		"setFollowUpMode",
		"setSessionName",
		"clearQueue",
		"setAutoCompactionEnabled",
		"setAutoRetryEnabled",
	] as const) {
		const original = session[method] as Call;
		Object.defineProperty(session, method, {
			configurable: true,
			writable: true,
			value: (...args: unknown[]) => {
				const source = session.sessionManager.getSessionFile();
				if (!source) return original.apply(session, args);
				const file = admission.file(source);
				if (file.session !== session) throw new Error("stale-native-owner");
				return admission.mutation(file, () => original.apply(session, args));
			},
		});
	}
	const dispose = session.dispose.bind(session);
	session.dispose = () => {
		const source = session.sessionManager.getSessionFile();
		if (!source) return dispose();
		const file = admission.file(source);
		admission.mutation(
			file,
			() => {
				dispose();
				if (file.session === session && !file.recovery) file.session = undefined;
			},
			true,
		);
	};
}
