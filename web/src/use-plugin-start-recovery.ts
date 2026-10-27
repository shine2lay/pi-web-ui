import { useCallback, useEffect, useRef, useState } from "react";
import { PENDING_OWNER_KEY } from "./pending-recovery-coordinator";
import { getPluginApiCaller } from "./plugin-host";
import {
	catalogPluginStarts,
	exportPluginStarts,
	openPluginStartCheckpoint,
	type PluginStartCatalogueEntry,
	type PluginStartFailure,
	type PluginStartOwner,
	type PluginStartSource,
} from "./plugin-start-checkpoint";

export interface PluginStartRecoveryView {
	ownerId: string;
	ownerGeneration: string | null;
	openFailure: PluginStartFailure | null;
	catalogueComplete: boolean;
	entries: readonly PluginStartCatalogueEntry[];
	rawIssues: readonly string[];
	runtimeIssues: readonly PluginStartFailure[];
}

interface SingletonState {
	ownerId: string | null;
	owner: PluginStartOwner | null;
	openFailure: PluginStartFailure | null;
	opening: Promise<void> | null;
	sessionId: string;
	conversationId: string;
	listeners: Set<() => void>;
}

const singleton: SingletonState = {
	ownerId: null,
	owner: null,
	openFailure: null,
	opening: null,
	sessionId: "",
	conversationId: "",
	listeners: new Set(),
};

function notifySingleton(): void {
	for (const listener of singleton.listeners) {
		try {
			listener();
		} catch {
			/* ignore subscriber error */
		}
	}
}

function resolveOwnerId(): string {
	if (singleton.ownerId) return singleton.ownerId;
	try {
		const stored = globalThis.sessionStorage?.getItem(PENDING_OWNER_KEY)?.trim() ?? "";
		if (stored) singleton.ownerId = stored;
		return singleton.ownerId ?? "";
	} catch {
		return "";
	}
}

function readCurrentSource(): PluginStartSource {
	const ownerId = resolveOwnerId();
	return {
		ownerId,
		sessionId: singleton.sessionId,
		conversationId: singleton.conversationId,
		pluginId: getPluginApiCaller(),
	};
}

function ensureSingletonOpen(): void {
	if (singleton.owner || singleton.opening) return;
	const ownerId = resolveOwnerId();
	if (!ownerId || !singleton.sessionId || !singleton.conversationId) return;
	if (singleton.openFailure && singleton.openFailure.code !== "source-mismatch") return;
	singleton.openFailure = null;
	const p = openPluginStartCheckpoint({
		ownerId,
		getSource: () => readCurrentSource(),
	})
		.then((res) => {
			if (res.ok) {
				singleton.owner = res.owner;
				singleton.openFailure = null;
			} else {
				singleton.owner = null;
				singleton.openFailure = res;
			}
			notifySingleton();
		})
		.catch(() => {
			singleton.owner = null;
			singleton.openFailure = {
				ok: false,
				code: "unavailable",
				sourceRetained: true,
				checkpointMayExist: false,
				dispatch: false,
			};
			notifySingleton();
		})
		.finally(() => {
			singleton.opening = null;
		});
	singleton.opening = p;
}

export function getDocumentPluginStartOwner(): PluginStartOwner | null {
	return singleton.owner;
}

export function computePluginStartRecoveryView(opts?: {
	storage?: Storage;
	ownerId?: string;
	ownerGeneration?: string | null;
	openFailure?: PluginStartFailure | null;
	runtimeIssues?: readonly PluginStartFailure[];
	failedIntentIds?: readonly string[];
}): PluginStartRecoveryView {
	const ownerId = opts?.ownerId ?? resolveOwnerId();
	const ownerGeneration =
		opts?.ownerGeneration !== undefined ? opts.ownerGeneration : (singleton.owner?.generation ?? null);
	const openFailure = opts?.openFailure !== undefined ? opts.openFailure : singleton.openFailure;
	const runtimeIssues = opts?.runtimeIssues ?? [];
	const failedIds = new Set(opts?.failedIntentIds ?? []);
	const catalogue = catalogPluginStarts(opts?.storage);
	const entries = catalogue.entries.filter((entry) => {
		if (entry.issue || entry.kind === "corrupt") return true;
		if (entry.kind !== "intent" || entry.state !== "recovery-required" || !entry.intent) return false;
		if (ownerId && entry.ownerId && entry.ownerId !== ownerId) return false;
		if (!ownerGeneration) return true;
		if (entry.intent.source.generation !== ownerGeneration) return true;
		return failedIds.has(entry.intent.intentId);
	});
	return {
		ownerId,
		ownerGeneration,
		openFailure,
		catalogueComplete: catalogue.complete,
		entries,
		rawIssues: catalogue.issues,
		runtimeIssues,
	};
}

export function resetPluginStartRecoveryForTests(): void {
	try {
		singleton.owner?.close();
	} catch {
		/* ignore */
	}
	singleton.ownerId = null;
	singleton.owner = null;
	singleton.openFailure = null;
	singleton.opening = null;
	singleton.sessionId = "";
	singleton.conversationId = "";
	singleton.listeners.clear();
}

export interface UsePluginStartRecoveryOptions {
	ownerId?: string | null;
	sessionId: string | null;
	conversationId: string | null;
	getRuntimeIssues?: () => readonly PluginStartFailure[];
	getFailedIntentIds?: () => readonly string[];
}

export function usePluginStartRecovery(options: UsePluginStartRecoveryOptions): {
	getOwner: () => PluginStartOwner | null;
	view: PluginStartRecoveryView;
	notifyChange: () => void;
	exportRaw: () => string;
} {
	if (typeof options.ownerId === "string" && options.ownerId.trim().length > 0) {
		singleton.ownerId = options.ownerId.trim();
	}
	if (typeof options.sessionId === "string" && options.sessionId.trim().length > 0) {
		singleton.sessionId = options.sessionId.trim();
	}
	if (typeof options.conversationId === "string" && options.conversationId.trim().length > 0) {
		singleton.conversationId = options.conversationId.trim();
	}
	const latest = useRef(options);
	latest.current = options;
	const [, setTick] = useState(0);
	const notifyChange = useCallback(() => {
		setTick((t) => t + 1);
	}, []);
	useEffect(() => {
		singleton.listeners.add(notifyChange);
		ensureSingletonOpen();
		return () => {
			singleton.listeners.delete(notifyChange);
		};
	}, [notifyChange]);
	useEffect(() => {
		ensureSingletonOpen();
	}, [options.ownerId, options.sessionId, options.conversationId]);
	const view = computePluginStartRecoveryView({
		runtimeIssues: latest.current.getRuntimeIssues?.() ?? [],
		failedIntentIds: latest.current.getFailedIntentIds?.() ?? [],
	});
	const exportRaw = useCallback(() => exportPluginStarts(), []);
	return {
		getOwner: getDocumentPluginStartOwner,
		view,
		notifyChange,
		exportRaw,
	};
}
