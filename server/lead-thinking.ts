import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { samePath } from "./identities.js";
import { isThinkingLevel } from "./model-all-chats.js";
import { readLeadThinkingStore, writeLeadThinkingStore, type LeadThinkingStore } from "./lead-thinking-store.js";

export interface LeadThinkingRequest {
	type: "lead_thinking_control";
	requestId: string;
	action: "get" | "set" | "default";
	role?: string;
	sessionId?: string;
	level?: string | null;
}
export interface LeadThinkingResolution {
	level?: string;
	source: string;
	reason?: string;
}
export type LeadThinkingResult = {
	type: "lead_thinking_result";
	requestId: string;
	ok: boolean;
	error?: string;
	defaultLevel: "high" | null;
	role?: string;
	sessionId?: string;
	model?: string;
	effective?: string;
	supported?: readonly string[];
	resolution?: LeadThinkingResolution;
};
interface Configuration {
	file: string;
	homes: () => readonly { id: string; homeChat: string | null }[];
	session: (file: string) => AgentSession | null;
	changed: (session: AgentSession) => void;
}
let configuration: Configuration | undefined;
const pendingInitializations = new Map<string, { session: WeakRef<AgentSession>; entryId: string | null }>();
const issued = new Map<
	string,
	{
		session: AgentSession;
		model: AgentSession["model"];
		entryId: string | null;
		snapshot: string;
		branch: { id: string; type: string }[];
		resolution: LeadThinkingResolution;
	}
>();
function snapshot(store: LeadThinkingStore, sid: string): string {
	return JSON.stringify([
		store.defaultLevel,
		Object.hasOwn(store.owners, sid) ? store.owners[sid] : null,
		Object.hasOwn(store.initializations, sid) ? [store.initializations[sid]] : [],
	]);
}
export function configureLeadThinking(options: Configuration): void {
	if (!options.file) throw new Error("Lead thinking store file is required");
	readLeadThinkingStore(options.file);
	configuration = options;
	issued.clear();
	for (const [sid, pending] of pendingInitializations) {
		const session = pending.session.deref();
		if (session) recordInitialization(session.sessionId, pending.entryId);
		pendingInitializations.delete(sid);
	}
}
function configured(): Configuration {
	if (!configuration) throw new Error("Lead thinking is not configured");
	return configuration;
}
interface Home {
	role: string;
	session: AgentSession;
}
/** Only queue assignment metadata is inspected; never messages or entry content. */
function worker(session: AgentSession): boolean {
	return session.sessionManager.getBranch().some((entry) => {
		if (entry.type !== "custom" || entry.customType !== "queue") return false;
		const data = entry.data as { op?: unknown } | null;
		return data?.op === "assigned";
	});
}
function home(sessionId?: string, role?: string): Home | undefined {
	const options = configured();
	const matches: Home[] = [];
	for (const candidate of options.homes()) {
		if (!candidate.homeChat || (role !== undefined && candidate.id !== role)) continue;
		const session = options.session(candidate.homeChat);
		if (
			!session ||
			(sessionId !== undefined && session.sessionId !== sessionId) ||
			!samePath(candidate.homeChat, session.sessionManager.getSessionFile()) ||
			worker(session)
		)
			continue;
		matches.push({ role: candidate.id, session });
	}
	return matches.length === 1 ? matches[0] : undefined;
}
function supported(session: AgentSession, level: string, source: string, reason?: string): LeadThinkingResolution {
	if (
		!session.model ||
		!isThinkingLevel(level) ||
		!(session.getAvailableThinkingLevels() as readonly string[]).includes(level)
	) {
		return { source: "unsupported", reason: `Thinking level ${level} is not supported by the current model` };
	}
	return { level, source, ...(reason ? { reason } : {}) };
}
function latestThinkingEntryId(session: AgentSession): string | null {
	let id: string | null = null;
	for (const entry of session.sessionManager.getBranch()) {
		if (entry.type !== "thinking_level_change") continue;
		if (typeof entry.id !== "string" || !entry.id) throw new Error("Thinking history entry lacks identity");
		id = entry.id;
	}
	return id;
}
/** Call ONLY at a proven fresh creation boundary, never during ordinary bind/reopen. */
export function rememberLeadThinkingInitialization(session: AgentSession): void {
	const entryId = latestThinkingEntryId(session);
	if (!configuration) {
		const existing = pendingInitializations.get(session.sessionId);
		if (existing && existing.entryId !== entryId)
			throw new Error("Initialization baseline already recorded with different history");
		pendingInitializations.set(session.sessionId, { session: new WeakRef(session), entryId });
		return;
	}
	recordInitialization(session.sessionId, entryId);
}
function recordInitialization(sessionId: string, entryId: string | null): void {
	const options = configured();
	const store = readLeadThinkingStore(options.file);
	if (Object.hasOwn(store.initializations, sessionId)) {
		if (store.initializations[sessionId] !== entryId)
			throw new Error("Initialization baseline already recorded with different history");
		return;
	}
	Object.defineProperty(store.initializations, sessionId, {
		value: entryId,
		enumerable: true,
		configurable: true,
		writable: true,
	});
	writeLeadThinkingStore(options.file, store);
}
function resolve(session: AgentSession, store: LeadThinkingStore): LeadThinkingResolution {
	const owner = Object.hasOwn(store.owners, session.sessionId) ? store.owners[session.sessionId] : undefined;
	const entryId = latestThinkingEntryId(session);
	if (owner && owner.entryId === entryId) return supported(session, owner.level, "owner");
	const branch = session.sessionManager.getBranch();
	const initialized =
		Object.hasOwn(store.initializations, session.sessionId) && store.initializations[session.sessionId] === entryId;
	if ((owner && owner.entryId !== entryId) || (entryId !== null && !initialized)) {
		return supported(session, session.thinkingLevel, "historical", "Unlabelled thinking history is protected");
	}
	// An unflushed new home may already have an unrecorded picker choice. No guess from emptiness.
	if (branch.length === 0 && !initialized)
		return supported(
			session,
			session.thinkingLevel,
			"unconfirmed-baseline",
			"Blank home has no confirmed creation baseline",
		);
	return store.defaultLevel ? supported(session, store.defaultLevel, "default") : { source: "disabled" };
}
export function leadThinking(sessionId: string): LeadThinkingResolution {
	const store = readLeadThinkingStore(configured().file);
	const target = home(sessionId);
	if (!target) return { source: "ineligible", reason: "Not a unique loaded canonical lead home" };
	const resolution = resolve(target.session, store);
	issued.set(sessionId, {
		session: target.session,
		model: target.session.model,
		entryId: latestThinkingEntryId(target.session),
		snapshot: snapshot(store, sessionId),
		branch: target.session.sessionManager.getBranch().map(({ id, type }) => ({ id, type })),
		resolution,
	});
	return resolution;
}

/** SDK's native setter appends history even with persist:false. Public agent state does not. */
function apply(session: AgentSession, level: string): LeadThinkingResolution {
	const result = supported(session, level, "runtime");
	if (result.level === undefined) return result;
	if (!isThinkingLevel(level)) throw new Error("Invalid thinking level");
	if (session.thinkingLevel !== level) {
		session.agent.state.thinkingLevel = level;
		configured().changed(session);
	}
	if (session.thinkingLevel !== level) throw new Error("Lead thinking runtime readback mismatch");
	return result;
}
/** Conservative shape check, not independent provenance: still relies on the host's
 * model-selection boundary between issuing and consuming the decision. */
function routingSuffix(session: AgentSession, prefix: readonly { id: string; type: string }[]): boolean {
	const branch = session.sessionManager.getBranch();
	if (!prefix.every((entry, index) => branch[index]?.id === entry.id && branch[index]?.type === entry.type))
		return false;
	const suffix = branch.slice(prefix.length);
	if (suffix.length < 1 || suffix.length > 2) return false;
	const model = suffix[0];
	if (
		model.type !== "model_change" ||
		model.provider !== session.model?.provider ||
		model.modelId !== session.model?.id
	)
		return false;
	return suffix.length === 1 || suffix[1].type === "thinking_level_change";
}
export function applyLeadThinking(sessionId: string, level: string): LeadThinkingResolution {
	const options = configured();
	const store = readLeadThinkingStore(options.file);
	const target = home(sessionId);
	const decision = issued.get(sessionId);
	issued.delete(sessionId);
	if (!target) return { source: "ineligible", reason: "Not a unique loaded canonical lead home" };
	if (!decision || decision.session !== target.session || decision.resolution.level !== level) {
		return { source: "stale", reason: "No matching issued lead thinking decision" };
	}
	const modelChanged = decision.model !== target.session.model;
	const historyChanged = decision.entryId !== latestThinkingEntryId(target.session);
	if (
		decision.snapshot !== snapshot(store, sessionId) ||
		(!modelChanged && historyChanged) ||
		(modelChanged && !routingSuffix(target.session, decision.branch))
	) {
		const fresh = resolve(target.session, store);
		if (fresh.level !== undefined) apply(target.session, fresh.level);
		return fresh;
	}
	const result = apply(target.session, level);
	// Queue consumes one issued decision after normal model selection. The checked suffix
	// is consistent with that boundary, not proof of arbitrary new history's provenance.
	// Only this narrowly recognized transition can advance an observed marker.
	if (
		result.level !== undefined &&
		decision.snapshot === snapshot(readLeadThinkingStore(options.file), sessionId) &&
		decision.session === target.session &&
		decision.resolution.level === level &&
		decision.model !== target.session.model &&
		(decision.resolution.source === "default" || decision.resolution.source === "owner")
	) {
		const entryId = latestThinkingEntryId(target.session);
		if (entryId !== decision.entryId) {
			if (
				decision.resolution.source === "owner" &&
				Object.hasOwn(store.owners, sessionId) &&
				store.owners[sessionId].entryId === decision.entryId
			) {
				store.owners[sessionId].entryId = entryId;
			} else if (decision.resolution.source === "default") {
				Object.defineProperty(store.initializations, sessionId, {
					value: entryId,
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			writeLeadThinkingStore(options.file, store);
		}
	}
	return result;
}
export function rememberLeadThinkingOwner(session: AgentSession, level: string): void {
	if (!configuration) return;
	const options = configured();
	const target = home(session.sessionId);
	if (!target || target.session !== session) return;
	const store = readLeadThinkingStore(options.file);
	issued.delete(session.sessionId);
	const result = supported(session, level, "owner");
	if (result.level === undefined || !isThinkingLevel(level)) throw new Error(result.reason ?? "Invalid thinking level");
	const entryId = latestThinkingEntryId(session);
	if (
		Object.hasOwn(store.owners, session.sessionId) &&
		store.owners[session.sessionId].level === level &&
		store.owners[session.sessionId].entryId === entryId
	)
		return;
	Object.defineProperty(store.owners, session.sessionId, {
		value: { level, source: "owner", entryId },
		enumerable: true,
		configurable: true,
		writable: true,
	});
	writeLeadThinkingStore(options.file, store);
}
export function initializeLeadThinking(session: AgentSession): void {
	if (!configuration) return;
	const target = home(session.sessionId);
	if (!target || target.session !== session) return;
	const resolution = leadThinking(session.sessionId);
	if (resolution.level !== undefined) apply(target.session, resolution.level);
}
export function leadThinkingControl(msg: LeadThinkingRequest): LeadThinkingResult {
	const result: LeadThinkingResult = {
		type: "lead_thinking_result",
		requestId: msg.requestId,
		ok: false,
		defaultLevel: null,
	};
	try {
		if (msg.type !== "lead_thinking_control" || typeof msg.requestId !== "string" || !msg.requestId.trim())
			throw new Error("Invalid lead thinking request");
		const options = configured();
		const store = readLeadThinkingStore(options.file);
		result.defaultLevel = store.defaultLevel;
		if (msg.action === "default") {
			if (msg.level !== "high" && msg.level !== null) throw new Error("Default must be high or null");
			if (store.defaultLevel !== msg.level) {
				store.defaultLevel = msg.level;
				writeLeadThinkingStore(options.file, store);
			}
			return { ...result, ok: true, defaultLevel: store.defaultLevel };
		}
		if (msg.action !== "get" && msg.action !== "set") throw new Error("Invalid lead thinking action");
		if (!msg.role && !msg.sessionId) {
			if (msg.action === "get") return { ...result, ok: true };
			throw new Error("Set requires exact role and sessionId");
		}
		if (msg.action === "set" && (!msg.role || !msg.sessionId)) throw new Error("Set requires exact role and sessionId");
		const target = home(msg.sessionId, msg.role);
		if (!target) throw new Error("Not a unique loaded canonical lead home matching role and sessionId");
		const session = target.session;
		Object.assign(result, {
			role: target.role,
			sessionId: session.sessionId,
			model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
			effective: session.thinkingLevel,
			supported: session.model ? session.getAvailableThinkingLevels() : [],
			resolution: resolve(session, store),
		});
		if (msg.action === "set") {
			if (typeof msg.level !== "string") throw new Error("Set requires a thinking level");
			rememberLeadThinkingOwner(session, msg.level);
			apply(session, msg.level);
			result.effective = session.thinkingLevel;
			result.resolution = resolve(session, readLeadThinkingStore(options.file));
		}
		return { ...result, ok: true };
	} catch (error) {
		return { ...result, error: error instanceof Error ? error.message : String(error) };
	}
}
