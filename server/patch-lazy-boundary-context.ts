/**
 * Lazy boundary-context patch for @earendil-works/pi-coding-agent (Ops #697).
 *
 * In @earendil-works/pi-coding-agent 1.0.1 (and through 1.4.0),
 * `ExtensionRunner.emitBoundary()` (dist/core/extensions/runner.js) eagerly
 * awaits `buildContext(entries)` before the handler loop and again after every
 * boundary handler, and `AgentSession._runBeforeSettleBoundary()`
 * (dist/core/agent-session.js) eagerly calls `this._buildBoundaryContext([], "agent_before_settle")`
 * even when `shouldContinue` is false. Each `_buildBoundaryContext` call
 * clones the full branch into `SessionManager.inMemory(...)`, builds the
 * whole-session projection (`buildSessionProjection` -> `buildSessionPath` +
 * `getBranch`), and runs `convertToLlm()`, taking 1–2.5 s of main-thread CPU
 * per turn end on large chats (9–14% of total server main-thread busy time)
 * even though the installed `turn_end` handlers (`pi-tldr`, `pi-control-chrome`)
 * never read `event.context` and `pi-queue`'s `agent_before_settle` handler
 * only reads `event.context` on `outcome === "error"`.
 *
 * This startup patch rewrites the installed `runner.js` and `agent-session.js`
 * so boundary context is captured in O(1) at emit time (leaf id, entry count,
 * boundary drafts snapshot, queued/pending message state) and the expensive
 * session projection is built lazily on first `event.context` (or `result.context`)
 * read, or when continuation validation (`boundary.continue` / `shouldContinue`)
 * actually needs `.canContinue`.
 *
 * Exact semantics preserved:
 *  - When no handler reads `event.context` (and continuation is not requested),
 *    `_buildBoundaryContext`, `_createBoundaryPreviewManager`, `buildSessionProjection`,
 *    and `getBranch` are never called.
 *  - A handler that reads `event.context` receives a plain `BoundaryContextPreview`
 *    object deep-equal to the eager build at that handler's emit point, even
 *    when an earlier or current handler appends entries (via returned `{ entries }`
 *    or `sessionManager.append*`).
 *
 * Idempotent and guarded by exact single-occurrence source matches via
 * `server/sdk-file-patch.ts`. MUST be imported before `@earendil-works/pi-coding-agent`
 * is first loaded (imported at the top of `server/agent-service.ts`).
 */

import { join } from "node:path";
import {
	applySdkFilePatches,
	patchFile,
	patchSource,
	resolvePiSdkFile,
	type FilePatchStatus,
	type PatchBatchResult,
	type SourcePatchResult,
	type SourceReplacement,
} from "./sdk-file-patch.js";

export const RUNNER_BOUNDARY_REPLACEMENTS: ReadonlyArray<SourceReplacement> = [
	{
		old: `    async emitBoundary(baseEvent, buildContext) {
        const ctx = this.createContext();
        let entries = [];
        let shouldContinue = false;
        let context = await buildContext(entries);
        let valid = true;
        for (const { ext, handlers } of snapshotEventHandlers(this.extensions, baseEvent.type)) {
            for (const handler of handlers) {
                const event = {
                    ...baseEvent,
                    entries,
                    continue: shouldContinue,
                    context,
                };
                try {
                    const handlerResult = (await handler(event, ctx));
                    if (handlerResult?.entries !== undefined)
                        entries = handlerResult.entries;
                    if (handlerResult?.continue !== undefined)
                        shouldContinue = handlerResult.continue;
                }
                catch (err) {
                    this.emitError({
                        extensionPath: ext.path,
                        event: baseEvent.type,
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                    });
                }
                try {
                    context = await buildContext(entries);
                    valid = true;
                }
                catch (err) {
                    valid = false;
                    this.emitError({
                        extensionPath: ext.path,
                        event: baseEvent.type,
                        error: \`Invalid boundary entries: \${err instanceof Error ? err.message : String(err)}\`,
                        stack: err instanceof Error ? err.stack : undefined,
                    });
                }
            }
        }
        return valid
            ? { entries, continue: shouldContinue, context, valid: true }
            : { entries: [], continue: false, context, valid: false };
    }`,
		new: `    async emitBoundary(baseEvent, buildContext) {
        const ctx = this.createContext();
        let entries = [];
        let shouldContinue = false;
        const prepareContext = async (currentEntries, validateDrafts = false) => {
            if (typeof buildContext.prepare === "function")
                return buildContext.prepare(currentEntries, validateDrafts);
            if (buildContext.constructor.name === "AsyncFunction") {
                const resolved = await buildContext(currentEntries);
                return () => resolved;
            }
            const snapshotEntries = currentEntries.length > 0 ? structuredClone(currentEntries) : [];
            const sm = this.sessionManager;
            const snapshot = sm && typeof sm.getLeafId === "function"
                ? {
                    header: sm.getHeader?.(),
                    leafId: sm.getLeafId(),
                    fileEntries: sm.fileEntries,
                    fileEntriesLength: Array.isArray(sm.fileEntries) ? sm.fileEntries.length : 0,
                }
                : undefined;
            if (sm && snapshot && !snapshot.header)
                throw new Error("Session header is missing");
            let built;
            let hasBuilt = false;
            const resolve = () => {
                if (!hasBuilt) {
                    const prev = sm ? sm._boundarySnapshot : undefined;
                    if (sm && snapshot)
                        sm._boundarySnapshot = snapshot;
                    try {
                        built = buildContext(snapshotEntries);
                        hasBuilt = true;
                    }
                    finally {
                        if (sm && snapshot)
                            sm._boundarySnapshot = prev;
                    }
                }
                return built;
            };
            if (validateDrafts && snapshotEntries.some((draft) => draft?.type !== "custom" && draft?.type !== "custom_message")) {
                resolve();
            }
            return resolve;
        };
        let getContext = await prepareContext(entries, false);
        let valid = true;
        for (const { ext, handlers } of snapshotEventHandlers(this.extensions, baseEvent.type)) {
            for (const handler of handlers) {
                const currentGetContext = getContext;
                const event = {
                    ...baseEvent,
                    entries,
                    continue: shouldContinue,
                    get context() {
                        return currentGetContext();
                    },
                };
                let entriesUpdated = false;
                try {
                    const handlerResult = (await handler(event, ctx));
                    if (handlerResult?.entries !== undefined) {
                        entries = handlerResult.entries;
                        entriesUpdated = true;
                    }
                    if (handlerResult?.continue !== undefined)
                        shouldContinue = handlerResult.continue;
                }
                catch (err) {
                    this.emitError({
                        extensionPath: ext.path,
                        event: baseEvent.type,
                        error: err instanceof Error ? err.message : String(err),
                        stack: err instanceof Error ? err.stack : undefined,
                    });
                }
                try {
                    getContext = await prepareContext(entries, entriesUpdated);
                    valid = true;
                }
                catch (err) {
                    valid = false;
                    this.emitError({
                        extensionPath: ext.path,
                        event: baseEvent.type,
                        error: \`Invalid boundary entries: \${err instanceof Error ? err.message : String(err)}\`,
                        stack: err instanceof Error ? err.stack : undefined,
                    });
                }
            }
        }
        const finalGetContext = getContext;
        return valid
            ? {
                entries,
                continue: shouldContinue,
                get context() {
                    return finalGetContext();
                },
                valid: true,
            }
            : {
                entries: [],
                continue: false,
                get context() {
                    return finalGetContext();
                },
                valid: false,
            };
    }`,
	},
];

export const AGENT_SESSION_BOUNDARY_REPLACEMENTS: ReadonlyArray<SourceReplacement> = [
	{
		old: `        const boundary = await this._extensionRunner.emitBoundary({
            type: "turn_end",
            turnIndex: this._turnIndex,
            message,
            toolResults,
            messageEntryId,
            toolResultEntryIds,
            outcome: this._lastActivityOutcome,
        }, (entries) => this._buildBoundaryContext(entries, "turn_end"));`,
		new: `        const boundary = await this._extensionRunner.emitBoundary({
            type: "turn_end",
            turnIndex: this._turnIndex,
            message,
            toolResults,
            messageEntryId,
            toolResultEntryIds,
            outcome: this._lastActivityOutcome,
        }, this._createBoundaryContextBuilder("turn_end"));`,
	},
	{
		old: `    _createBoundaryPreviewManager(drafts) {
        const header = this.sessionManager.getHeader();
        if (!header)
            throw new Error("Session header is missing");
        const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this.sessionManager.getBranch()]);
        this._applyBoundaryDrafts(manager, drafts);
        return manager;
    }
    _getPendingBoundaryMessages() {
        return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
    }
    _buildBoundaryContext(drafts, boundary) {
        const projection = this._createBoundaryPreviewManager(drafts).buildSessionProjection();
        const pendingMessages = this._getPendingBoundaryMessages();
        const llmMessages = convertToLlm(projection.messages);
        const finalRole = llmMessages[llmMessages.length - 1]?.role;
        const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
        const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
        const pendingCustomContext = this._pendingCustomMessages.length > 0;
        return {
            contextEntries: projection.entries,
            contextMessages: projection.messages,
            llmMessages,
            pendingMessages,
            canContinue: contextCanContinue ||
                pendingCustomContext ||
                (boundary === "turn_end"
                    ? this.agent.hasQueuedMessages()
                    : finalRole === "assistant" && this.agent.hasQueuedMessages()),
        };
    }`,
		new: `    _resolveBoundarySnapshotBranch(snapshot) {
        if (!snapshot)
            return this.sessionManager.getBranch();
        if (snapshot.leafId === null)
            return [];
        if (this.sessionManager.fileEntries === snapshot.fileEntries && this.sessionManager.getEntry(snapshot.leafId))
            return this.sessionManager.getBranch(snapshot.leafId);
        const byId = new Map();
        for (let i = 0; i < snapshot.fileEntriesLength; i++) {
            const entry = snapshot.fileEntries[i];
            if (entry && entry.type !== "session")
                byId.set(entry.id, entry);
        }
        const path = [];
        let current = byId.get(snapshot.leafId);
        while (current) {
            path.unshift(current);
            current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return path;
    }
    _createBoundaryPreviewManager(drafts, snapshot = this.sessionManager._boundarySnapshot) {
        const header = snapshot?.header ?? this.sessionManager.getHeader();
        if (!header)
            throw new Error("Session header is missing");
        const manager = SessionManager.inMemory(this._cwd, undefined, [header, ...this._resolveBoundarySnapshotBranch(snapshot)]);
        this._applyBoundaryDrafts(manager, drafts);
        return manager;
    }
    _getPendingBoundaryMessages() {
        return [...this.agent.peekQueuedMessages(), ...this._pendingCustomMessages];
    }
    _snapshotBoundaryContext(drafts, validateDrafts = false) {
        const header = this.sessionManager.getHeader();
        if (!header)
            throw new Error("Session header is missing");
        const fileEntries = this.sessionManager.fileEntries;
        const snapshot = {
            header,
            leafId: this.sessionManager.getLeafId(),
            fileEntries,
            fileEntriesLength: fileEntries.length,
            drafts: drafts.length > 0 ? structuredClone(drafts) : [],
            pendingMessages: this._getPendingBoundaryMessages(),
            pendingCustomContext: this._pendingCustomMessages.length > 0,
            hasQueuedMessages: this.agent.hasQueuedMessages(),
            previewManager: undefined,
        };
        if (validateDrafts && snapshot.drafts.some((draft) => draft?.type !== "custom" && draft?.type !== "custom_message")) {
            snapshot.previewManager = this._createBoundaryPreviewManager(snapshot.drafts, snapshot);
        }
        return snapshot;
    }
    _createBoundaryContextBuilder(boundary) {
        const builder = (entries, snapshot) => this._buildBoundaryContext(entries, boundary, snapshot);
        builder.prepare = (entries, validateDrafts = false) => {
            const snapshot = this._snapshotBoundaryContext(entries, validateDrafts);
            let built;
            let hasBuilt = false;
            return () => {
                if (!hasBuilt) {
                    built = this._buildBoundaryContext(snapshot.drafts, boundary, snapshot);
                    hasBuilt = true;
                }
                return built;
            };
        };
        return builder;
    }
    _buildBoundaryContext(drafts, boundary, snapshot = this.sessionManager._boundarySnapshot) {
        const effectiveDrafts = snapshot?.drafts ?? drafts;
        const previewManager = snapshot?.previewManager ?? this._createBoundaryPreviewManager(effectiveDrafts, snapshot);
        const projection = previewManager.buildSessionProjection();
        const pendingMessages = snapshot?.pendingMessages ?? this._getPendingBoundaryMessages();
        const llmMessages = convertToLlm(projection.messages);
        const finalRole = llmMessages[llmMessages.length - 1]?.role;
        const hasNonSystemContext = llmMessages.some((message) => message.role !== "system");
        const contextCanContinue = hasNonSystemContext && finalRole !== "assistant";
        const pendingCustomContext = snapshot?.pendingCustomContext ?? this._pendingCustomMessages.length > 0;
        const hasQueuedMessages = snapshot?.hasQueuedMessages ?? this.agent.hasQueuedMessages();
        return {
            contextEntries: projection.entries,
            contextMessages: projection.messages,
            llmMessages,
            pendingMessages,
            canContinue: contextCanContinue ||
                pendingCustomContext ||
                (boundary === "turn_end"
                    ? hasQueuedMessages
                    : finalRole === "assistant" && hasQueuedMessages),
        };
    }`,
	},
	{
		old: `            const result = await this._extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: this._lastActivityOutcome }, (entries) => this._buildBoundaryContext(entries, "agent_before_settle"));
            this._commitBoundaryDrafts(result.entries);
            this._flushPendingCustomMessages();
            const finalContext = this._buildBoundaryContext([], "agent_before_settle");
            if (this._abortDuringBeforeSettle)
                return false;
            const shouldContinue = result.continue || this.agent.hasQueuedMessages();
            if (shouldContinue && !finalContext.canContinue) {`,
		new: `            const result = await this._extensionRunner.emitBoundary({ type: "agent_before_settle", outcome: this._lastActivityOutcome }, this._createBoundaryContextBuilder("agent_before_settle"));
            this._commitBoundaryDrafts(result.entries);
            this._flushPendingCustomMessages();
            if (this._abortDuringBeforeSettle)
                return false;
            const shouldContinue = result.continue || this.agent.hasQueuedMessages();
            if (shouldContinue && !this._buildBoundaryContext([], "agent_before_settle").canContinue) {`,
	},
];

/** Rewrites runner.js source (pure; no file access). */
export function patchRunnerBoundarySource(source: string): SourcePatchResult {
	return patchSource(source, RUNNER_BOUNDARY_REPLACEMENTS);
}

/** Rewrites agent-session.js source (pure; no file access). */
export function patchAgentSessionBoundarySource(source: string): SourcePatchResult {
	return patchSource(source, AGENT_SESSION_BOUNDARY_REPLACEMENTS);
}

/** Absolute path of the installed dist/core/extensions/runner.js, or null. */
export function runnerBoundaryFile(coreDir?: string): string | null {
	return coreDir ? join(coreDir, "extensions", "runner.js") : resolvePiSdkFile("core", "extensions", "runner.js");
}

/** Absolute path of the installed dist/core/agent-session.js, or null. */
export function agentSessionBoundaryFile(coreDir?: string): string | null {
	return coreDir ? join(coreDir, "agent-session.js") : resolvePiSdkFile("core", "agent-session.js");
}

/** Patches a single runner.js file on disk. */
export function patchRunnerBoundaryFile(file: string | null = runnerBoundaryFile()): FilePatchStatus {
	return patchFile(file, RUNNER_BOUNDARY_REPLACEMENTS);
}

/** Patches a single agent-session.js file on disk. */
export function patchAgentSessionBoundaryFile(file: string | null = agentSessionBoundaryFile()): FilePatchStatus {
	return patchFile(file, AGENT_SESSION_BOUNDARY_REPLACEMENTS);
}

/**
 * Patches both installed SDK boundary files (`extensions/runner.js` and `agent-session.js`).
 * Pass `coreDir` in tests to target a temporary directory copy.
 */
export function applyLazyBoundaryContextPatch(options?: {
	coreDir?: string;
	runnerFile?: string | null;
	agentSessionFile?: string | null;
	warn?: ((msg: string) => void) | null;
	log?: ((msg: string) => void) | null;
}): PatchBatchResult {
	const runnerFile = options && "runnerFile" in options ? options.runnerFile : runnerBoundaryFile(options?.coreDir);
	const agentSessionFile =
		options && "agentSessionFile" in options ? options.agentSessionFile : agentSessionBoundaryFile(options?.coreDir);
	return applySdkFilePatches(
		[
			{
				name: "extensions/runner.js",
				file: runnerFile,
				replacements: RUNNER_BOUNDARY_REPLACEMENTS,
			},
			{
				name: "agent-session.js",
				file: agentSessionFile,
				replacements: AGENT_SESSION_BOUNDARY_REPLACEMENTS,
			},
		],
		{
			tag: "patch-lazy-boundary-context",
			warn: options?.warn,
			log: options?.log,
		},
	);
}

applyLazyBoundaryContextPatch({
	log: (msg) => console.log(msg),
});
