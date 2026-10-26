/**
 * W1-F: opt-in tool catalog, per-chat/workspace overrides and HTTP adapter.
 * No imports with startup side effects; Wave 2 owns mounting and session creation.
 *
 * SDK 1.0.1 rebuilds a fresh wrapped registry per session. Its _applyToolLoadout
 * funnel runs on activation, registry refresh, transcript restore AND each request.
 * Only that session's method/registry is decorated; shared definitions stay intact.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import { normalizeToolInfo, TOOL_DESCRIPTION_CAP, TOOL_GUIDELINES_CAP } from "./tool-info.js";

export type ToolInspectorScope = "chat" | "workspace";
export type ToolInspectorSource = "core" | "extension" | "plugin" | "mcp";
export interface ToolInspectorOverride {
	enabled?: boolean;
	/** Empty string explicitly selects the definition's default text. */
	customDescription?: string;
	/** Extra guideline, not a replacement for the tool's built-in guidelines. */
	promptRule?: string;
}
export interface ToolInspectorUpdate {
	toolName: string;
	scope?: ToolInspectorScope;
	/** null removes this scope's override (inherits the workspace/default). */
	enabled?: boolean | null;
	customDescription?: string | null;
	promptRule?: string | null;
}
interface CatalogTool {
	name: string;
	label?: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	exposure?: string;
	sourceInfo?: { source?: string; path?: string; scope?: string; origin?: string };
}
/** Public structural surface: private SDK fields are cast only inside this module. */
export interface ToolInspectorSession {
	readonly sessionId: string;
	readonly sessionManager: { getCwd(): string };
	getAllTools(): CatalogTool[];
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
}
export interface ToolInspectorExternalTool {
	name: string;
	source?: "plugin" | "mcp";
	label?: string;
	origin?: string;
}
export interface ToolParameterSummary {
	name: string;
	type: string;
	required: boolean;
	description: string;
}
export interface ToolInspectorTool {
	name: string;
	label?: string;
	source: ToolInspectorSource;
	origin?: string;
	description: string;
	defaultDescription: string;
	promptSnippet?: string;
	promptGuidelines: string[];
	parameters?: unknown;
	parametersDropped?: boolean;
	parameterSummary: ToolParameterSummary[];
	exposure: string;
	/** enabled = policy permits it; active = declared in the current loadout. */
	enabled: boolean;
	active: boolean;
	overrides: { chat: ToolInspectorOverride; workspace: ToolInspectorOverride; effective: ToolInspectorOverride };
}
export interface ToolInspectorSnapshot {
	sessionId: string;
	workspace: string;
	tools: ToolInspectorTool[];
}
type ToolOverrides = Record<string, ToolInspectorOverride>;
type Buckets = Record<string, ToolOverrides>;
interface StoreData {
	version: 1;
	chats: Buckets;
	workspaces: Buckets;
}
export class ToolInspectorError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}
const record = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = <T>(r: Record<string, T>, k: string): T | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);
const emptyData = (): StoreData => ({ version: 1, chats: record(), workspaces: record() });

function cleanOverride(raw: unknown): ToolInspectorOverride {
	if (!object(raw)) return {};
	const out: ToolInspectorOverride = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (typeof raw.customDescription === "string" && raw.customDescription.length <= TOOL_DESCRIPTION_CAP)
		out.customDescription = raw.customDescription.trim();
	if (typeof raw.promptRule === "string" && raw.promptRule.length <= TOOL_GUIDELINES_CAP)
		out.promptRule = raw.promptRule.trim();
	return out;
}
function readData(raw: unknown): StoreData {
	if (!object(raw) || raw.version !== 1 || !object(raw.chats) || !object(raw.workspaces))
		throw new ToolInspectorError("Unrecognized Tool Inspector store; repair the file before retrying.", 500);
	const data = emptyData();
	for (const scope of ["chats", "workspaces"] as const) {
		for (const [key, tools] of Object.entries(raw[scope] as Record<string, unknown>)) {
			if (!key || !object(tools)) continue;
			const bucket = record<ToolInspectorOverride>();
			for (const [name, value] of Object.entries(tools)) {
				const entry = cleanOverride(value);
				if (name && Object.keys(entry).length) bucket[name] = entry;
			}
			if (Object.keys(bucket).length) data[scope][key] = bucket;
		}
	}
	return data;
}

/** One shared store per server; pass a file path for persistence, omit it in tests. */
export class ToolInspectorStore {
	private data = emptyData();
	private readonly sessions = new Set<WeakRef<ToolInspectorSession>>();
	constructor(readonly filePath?: string) {
		if (!filePath) return;
		let text: string;
		try {
			text = readFileSync(filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		// Never overwrite an unreadable/corrupt store with empty choices.
		this.data = readData(JSON.parse(text));
	}
	get(scope: ToolInspectorScope, key: string, name: string): ToolInspectorOverride {
		const bucket = own(scope === "chat" ? this.data.chats : this.data.workspaces, key);
		return { ...(bucket && own(bucket, name)) };
	}
	effective(session: ToolInspectorSession, name: string): ToolInspectorOverride {
		return {
			...this.get("workspace", workspaceOf(session), name),
			...this.get("chat", session.sessionId, name),
		};
	}
	set(scope: ToolInspectorScope, key: string, name: string, value: ToolInspectorOverride): void {
		const next = readData(JSON.parse(JSON.stringify(this.data)));
		const buckets = scope === "chat" ? next.chats : next.workspaces;
		const bucket = own(buckets, key) ?? record<ToolInspectorOverride>();
		if (Object.keys(value).length) bucket[name] = { ...value };
		else delete bucket[name];
		if (Object.keys(bucket).length) buckets[key] = bucket;
		else delete buckets[key];
		this.save(next);
	}
	forgetChat(sessionId: string): void {
		const next = readData(JSON.parse(JSON.stringify(this.data)));
		delete next.chats[sessionId];
		this.save(next);
	}
	private save(next: StoreData): void {
		if (this.filePath) {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.tmp-${randomUUID()}`;
			try {
				writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
				renameSync(tmp, this.filePath);
			} finally {
				rmSync(tmp, { force: true });
			}
		}
		// Publish only after the atomic write succeeds.
		this.data = next;
	}
	track(session: ToolInspectorSession): void {
		this.sessions.add(new WeakRef(session));
	}
	peers(session: ToolInspectorSession): ToolInspectorSession[] {
		const peers: ToolInspectorSession[] = [];
		for (const ref of this.sessions) {
			const candidate = ref.deref();
			if (!candidate || states.get(candidate)?.store !== this) this.sessions.delete(ref);
			else if (workspaceOf(candidate) === workspaceOf(session)) peers.push(candidate);
		}
		return peers;
	}
}
function workspaceOf(session: ToolInspectorSession): string {
	return resolve(session.sessionManager.getCwd());
}
interface WrappedTool {
	name: string;
	description?: string;
}
interface SessionInternals {
	_toolRegistry: Map<string, WrappedTool>;
	_toolPromptGuidelines?: Map<string, string[]>;
	_applyToolLoadout(names: string[]): WrappedTool[];
	_getCallableTools?: (...args: unknown[]) => WrappedTool[];
}
interface InspectorState {
	store: ToolInspectorStore;
	suppressed: Map<string, Set<string>>;
	descriptions: WeakMap<WrappedTool, string | undefined>;
	guidelineMap?: Map<string, string[]>;
	guidelineBase: Map<string, string[]>;
}
const states = new WeakMap<ToolInspectorSession, InspectorState>();
const internals = (session: ToolInspectorSession): SessionInternals => session as unknown as SessionInternals;
function suppressedFor(session: ToolInspectorSession, state: InspectorState): Set<string> {
	let names = state.suppressed.get(session.sessionId);
	if (!names) state.suppressed.set(session.sessionId, (names = new Set()));
	return names;
}
function applyTexts(session: ToolInspectorSession, state: InspectorState): void {
	const sdk = internals(session);
	if (sdk._toolPromptGuidelines !== state.guidelineMap) {
		state.guidelineMap = sdk._toolPromptGuidelines;
		state.guidelineBase = new Map([...(sdk._toolPromptGuidelines ?? [])].map(([name, lines]) => [name, [...lines]]));
	}
	for (const [name, tool] of sdk._toolRegistry) {
		if (!state.descriptions.has(tool)) state.descriptions.set(tool, tool.description);
		const override = state.store.effective(session, name);
		tool.description = override.customDescription || state.descriptions.get(tool);
		const guidelines = [...(state.guidelineBase.get(name) ?? [])];
		if (override.promptRule && !guidelines.includes(override.promptRule)) guidelines.push(override.promptRule);
		if (guidelines.length) sdk._toolPromptGuidelines?.set(name, guidelines);
		else sdk._toolPromptGuidelines?.delete(name);
	}
}

/** Install immediately after a session is created/restored, BEFORE its first turn.
 * Refuse an incompatible SDK rather than silently offering unenforced toggles.
 */
export function attachToolInspector(session: ToolInspectorSession, store: ToolInspectorStore): void {
	const previous = states.get(session);
	if (previous) {
		if (previous.store !== store)
			throw new ToolInspectorError("This chat already uses another Tool Inspector store.", 409);
		refreshToolInspectorSession(session);
		return;
	}
	const sdk = internals(session);
	if (!(sdk._toolRegistry instanceof Map) || typeof sdk._applyToolLoadout !== "function")
		throw new ToolInspectorError(
			"Tool Inspector needs the SDK 1.0.1 tool-loadout adapter; update the adapter first.",
			409,
		);
	const state: InspectorState = {
		store,
		suppressed: new Map(),
		descriptions: new WeakMap(),
		guidelineBase: new Map(),
	};
	const apply = sdk._applyToolLoadout;
	sdk._applyToolLoadout = function (names) {
		applyTexts(session, state);
		const suppressed = suppressedFor(session, state);
		const allowed = names.filter((name) => {
			if (store.effective(session, name).enabled !== false) return true;
			suppressed.add(name);
			return false;
		});
		const declared = apply.call(this, allowed);
		// A prepareLoadout hook may return a fresh declaration with its own text.
		for (const tool of declared) {
			const description = store.effective(session, tool.name).customDescription;
			if (description) tool.description = description;
		}
		return declared;
	};
	const callable = sdk._getCallableTools;
	if (callable) {
		sdk._getCallableTools = function (...args) {
			return callable.apply(this, args).filter((tool) => store.effective(session, tool.name).enabled !== false);
		};
	}
	states.set(session, state);
	store.track(session);
	refreshToolInspectorSession(session);
}

/** Restore only names previously suppressed by this policy, not all catalog tools. */
export function refreshToolInspectorSession(session: ToolInspectorSession, activate?: string): void {
	const state = states.get(session);
	if (!state) return;
	const suppressed = suppressedFor(session, state);
	const names = new Set(session.getActiveToolNames());
	for (const name of suppressed) {
		if (state.store.effective(session, name).enabled !== false) {
			names.add(name);
			suppressed.delete(name);
		}
	}
	if (activate) names.add(activate);
	session.setActiveToolsByName([...names]);
}

function sourceOf(tool: CatalogTool, external?: ToolInspectorExternalTool): ToolInspectorSource {
	if (external) return external.source ?? "plugin";
	const info = tool.sourceInfo;
	if (
		tool.name === "mcp" ||
		tool.name === "mcpScript" ||
		tool.name.startsWith("mcp__") ||
		`${info?.source ?? ""} ${info?.path ?? ""}`.includes("mcp-adapter")
	)
		return "mcp";
	if (!info || info.source === "builtin" || info.source === "sdk" || info.source === "core") return "core";
	if (info.source === "plugin" || info.source === "mcp") return info.source;
	return "extension";
}
function schemaType(schema: Record<string, unknown>): string {
	if (typeof schema.type === "string") return schema.type;
	if (Array.isArray(schema.type)) return schema.type.join(" | ");
	if (typeof schema.$ref === "string") return schema.$ref;
	if (Array.isArray(schema.enum)) return "enum";
	if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) return "union";
	return "any";
}
/** Root parameters + nested object/array fields; the full schema is also available. */
export function summarizeToolParameters(schema: unknown): ToolParameterSummary[] {
	const rows: ToolParameterSummary[] = [];
	const seen = new Set<object>();
	function visit(value: unknown, prefix: string): void {
		if (!object(value) || seen.has(value)) return;
		seen.add(value);
		const required = new Set(Array.isArray(value.required) ? value.required : []);
		if (object(value.properties)) {
			for (const [key, raw] of Object.entries(value.properties)) {
				if (!object(raw)) continue;
				const name = prefix ? `${prefix}.${key}` : key;
				rows.push({
					name,
					type: schemaType(raw),
					required: required.has(key),
					description: typeof raw.description === "string" ? raw.description : "",
				});
				visit(raw, name);
			}
		}
		if (object(value.items)) visit(value.items, `${prefix}[]`);
	}
	visit(schema, "");
	return rows;
}
export function getToolInspectorSnapshot(
	session: ToolInspectorSession,
	pluginTools: readonly ToolInspectorExternalTool[] = [],
): ToolInspectorSnapshot {
	const state = states.get(session);
	const active = new Set(session.getActiveToolNames());
	const external = new Map(pluginTools.map((tool) => [tool.name, tool]));
	const tools = session.getAllTools().map((tool): ToolInspectorTool => {
		const chat = state?.store.get("chat", session.sessionId, tool.name) ?? {};
		const workspace = state?.store.get("workspace", workspaceOf(session), tool.name) ?? {};
		const effective = { ...workspace, ...chat };
		const normalized = normalizeToolInfo(tool.name, {
			...tool,
			description: effective.customDescription || tool.description,
		});
		const parameters =
			normalized.parameters === undefined ? undefined : JSON.parse(JSON.stringify(normalized.parameters));
		const origin = external.get(tool.name)?.origin ?? tool.sourceInfo?.path ?? tool.sourceInfo?.source;
		return {
			name: tool.name,
			label: tool.label ?? external.get(tool.name)?.label,
			source: sourceOf(tool, external.get(tool.name)),
			origin,
			description: normalized.description ?? "",
			defaultDescription: normalizeToolInfo(tool.name, tool).description ?? "",
			promptSnippet: normalized.promptSnippet,
			promptGuidelines: [
				...new Set([...(normalized.promptGuidelines ?? []), ...(effective.promptRule ? [effective.promptRule] : [])]),
			],
			parameters,
			parametersDropped: normalized.parametersDropped,
			parameterSummary: summarizeToolParameters(parameters),
			exposure: tool.exposure ?? "direct",
			enabled: effective.enabled !== false,
			active: active.has(tool.name) && effective.enabled !== false,
			overrides: { chat, workspace, effective },
		};
	});
	tools.sort((a, b) => a.name.localeCompare(b.name));
	return { sessionId: session.sessionId, workspace: workspaceOf(session), tools };
}

export function applyToolInspectorUpdate(session: ToolInspectorSession, input: ToolInspectorUpdate): void {
	const state = states.get(session);
	if (!state) throw new ToolInspectorError("Tool Inspector is not attached to this chat.", 409);
	if (!object(input) || typeof input.toolName !== "string" || !input.toolName.trim())
		throw new ToolInspectorError("toolName must be a non-empty string.");
	const name = input.toolName;
	if (!session.getAllTools().some((tool) => tool.name === name))
		throw new ToolInspectorError("Tool not found in this chat.", 404);
	const scope = input.scope ?? "chat";
	if (scope !== "chat" && scope !== "workspace") throw new ToolInspectorError("scope must be chat or workspace.");
	const key = scope === "chat" ? session.sessionId : workspaceOf(session);
	const next = state.store.get(scope, key, name);
	let changed = false;
	for (const field of ["enabled", "customDescription", "promptRule"] as const) {
		if (!Object.hasOwn(input, field)) continue;
		changed = true;
		const value = input[field];
		if (value === null) delete next[field];
		else if (field === "enabled") {
			if (typeof value !== "boolean") throw new ToolInspectorError("enabled must be boolean or null.");
			next.enabled = value;
		} else {
			if (typeof value !== "string") throw new ToolInspectorError(`${field} must be a string or null.`);
			const cap = field === "customDescription" ? TOOL_DESCRIPTION_CAP : TOOL_GUIDELINES_CAP;
			if (value.length > cap)
				throw new ToolInspectorError(`${field} exceeds the existing tool-text limit (${cap} characters).`);
			next[field] = value.trim();
		}
	}
	if (!changed) throw new ToolInspectorError("Supply enabled, customDescription or promptRule.");
	state.store.set(scope, key, name, next);
	for (const peer of scope === "workspace" ? state.store.peers(session) : [session]) {
		// Explicitly enabling an inactive tool activates it in the edited chat only.
		refreshToolInspectorSession(peer, peer === session && input.enabled === true ? name : undefined);
	}
}

export interface ToolInspectorDependencies {
	store: ToolInspectorStore;
	/** Must resolve the exact client + conversation; never fall back to the foreground chat. */
	resolveSession(
		clientId: string,
		convId: string,
	): ToolInspectorSession | undefined | Promise<ToolInspectorSession | undefined>;
	pluginTools?: (session: ToolInspectorSession) => readonly ToolInspectorExternalTool[];
}
export interface ToolInspectorRequest {
	method: "GET" | "POST";
	clientId?: unknown;
	convId?: unknown;
	update?: unknown;
}
/** Transport-independent adapter: unit tests open no port and need no real chats. */
export async function handleToolInspectorRequest(
	deps: ToolInspectorDependencies,
	request: ToolInspectorRequest,
): Promise<{ status: number; body: ToolInspectorSnapshot | { error: string } }> {
	try {
		if (
			typeof request.clientId !== "string" ||
			!request.clientId ||
			typeof request.convId !== "string" ||
			!request.convId
		)
			throw new ToolInspectorError("clientId and convId are required.");
		const session = await deps.resolveSession(request.clientId, request.convId);
		if (!session) throw new ToolInspectorError("Chat not found.", 404);
		attachToolInspector(session, deps.store);
		if (request.method === "POST") applyToolInspectorUpdate(session, request.update as ToolInspectorUpdate);
		return { status: 200, body: getToolInspectorSnapshot(session, deps.pluginTools?.(session)) };
	} catch (error) {
		if (error instanceof ToolInspectorError) return { status: error.status, body: { error: error.message } };
		return {
			status: 500,
			body: {
				error: "Tool Inspector could not read or save its settings. Check the server's storage access and retry.",
			},
		};
	}
}
/** Mount AFTER the host's authentication middleware. No new WebSocket protocol needed. */
export function registerToolInspectorRoutes(app: Express, deps: ToolInspectorDependencies): void {
	app.get("/api/tool-inspector", async (req, res) => {
		const result = await handleToolInspectorRequest(deps, {
			method: "GET",
			clientId: req.query.clientId,
			convId: req.query.convId,
		});
		res.setHeader("Cache-Control", "no-store");
		res.status(result.status).json(result.body);
	});
	app.post("/api/tool-inspector/update", express.json(), async (req, res) => {
		const result = await handleToolInspectorRequest(deps, {
			method: "POST",
			clientId: req.body?.clientId,
			convId: req.body?.convId,
			update: req.body?.update,
		});
		res.setHeader("Cache-Control", "no-store");
		res.status(result.status).json(result.body);
	});
}
