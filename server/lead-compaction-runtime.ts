import {
	SessionManager as NativeSessionManager,
	createAgentSessionRuntime as createNativeRuntime,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";
import { LeadAdmission } from "./lead-compaction-admission.js";
import { LeadCompactionHost, type LeadHostPorts } from "./lead-compaction-host.js";
import { fenceManager, fenceSession, managerFenceRevision } from "./lead-compaction-session.js";

/** One process-owned domain, shared by UI, scheduler, extensions, restore and native apply. */
export const nativeLeadAdmission = new LeadAdmission();
let webHost: { ports: LeadHostPorts; host: LeadCompactionHost } | undefined;
let recoveryPreflight: ((source: string) => Promise<void>) | undefined;
/** Server installs this before accepting clients; unit/worker runtimes do not enable lead recovery. */
export function setNativeRecoveryPreflight(check: ((source: string) => Promise<void>) | undefined): void {
	recoveryPreflight = check;
}
/** Integration's only web-host constructor: always joins the existing runtime ownership domain. */
export function createWebLeadCompactionHost(ports: LeadHostPorts): LeadCompactionHost {
	if (webHost && webHost.ports !== ports) throw new Error("lead-host-already-configured");
	webHost ??= { ports, host: new LeadCompactionHost(ports, nativeLeadAdmission) };
	return webHost.host;
}
export function noteNativeInput(session: AgentSessionRuntime["session"]): void {
	const source = session.sessionFile;
	if (source && isAbsolute(source)) nativeLeadAdmission.file(source).revision++;
}
export async function reloadNativeResources(session: AgentSessionRuntime["session"]): Promise<void> {
	const source = session.sessionFile;
	if (!source || !isAbsolute(source)) {
		await session.resourceLoader.reload();
		return;
	}
	const file = nativeLeadAdmission.file(source);
	file.generation++;
	await nativeLeadAdmission.input(file, async (current) => {
		await current.resourceLoader.reload();
	});
}
export function readNativeLeadObservation(source: string): {
	checkpoint?: { messageEntryId: string; toolResultEntryIds: string[] };
} {
	const checkpoint = nativeLeadAdmission.file(source).checkpoint;
	return checkpoint ? { checkpoint: structuredClone(checkpoint) } : {};
}
export function trackNativeManager(manager: NativeSessionManager): NativeSessionManager {
	const source = manager.getSessionFile();
	if (source && isAbsolute(source)) {
		nativeLeadAdmission.assertReadable(source);
		fenceManager(manager, nativeLeadAdmission);
	}
	return manager;
}
export type SessionManager = NativeSessionManager;
/** Public SDK opens only; never patches the global SDK class or its private constructor. */
export const SessionManager: typeof NativeSessionManager = new Proxy(NativeSessionManager, {
	get(target, key, receiver) {
		if (key === "open")
			return (path: string, sessionDir?: string, cwdOverride?: string) => {
				const source = resolve(path);
				nativeLeadAdmission.assertReadable(source);
				return trackNativeManager(target.open(source, sessionDir, cwdOverride));
			};
		if (key === "create")
			return (...args: Parameters<typeof NativeSessionManager.create>) => trackNativeManager(target.create(...args));
		return Reflect.get(target, key, receiver);
	},
});
/** Covers factory awaits. A manager read before a cold write cannot become a stale cached owner. */
export async function createFencedSession(
	manager: NativeSessionManager,
	create: () => Promise<CreateAgentSessionRuntimeResult>,
): Promise<CreateAgentSessionRuntimeResult> {
	const source = manager.getSessionFile();
	if (!source || !isAbsolute(source)) return create();
	await recoveryPreflight?.(source);
	trackNativeManager(manager);
	const file = nativeLeadAdmission.file(source);
	nativeLeadAdmission.assertReadable(source);
	if (managerFenceRevision.get(manager) !== file.revision && !nativeLeadAdmission.owns(file))
		throw new Error("stale-native-open");
	if (file.session && file.session.sessionManager !== manager && !nativeLeadAdmission.owns(file))
		throw new Error("cached-owner-collision");
	if (file.opening && !nativeLeadAdmission.openingOwned(file) && !nativeLeadAdmission.owns(file))
		throw new Error("opening-owner-collision");
	file.opening++;
	file.generation++;
	try {
		const created = await create();
		fenceSession(created.session, nativeLeadAdmission);
		return created;
	} finally {
		file.opening--;
	}
}
const runtimes = new WeakSet<AgentSessionRuntime>();
export function fenceRuntime(runtime: AgentSessionRuntime): AgentSessionRuntime {
	if (runtimes.has(runtime)) return runtime;
	runtimes.add(runtime);
	for (const method of ["dispose", "switchSession", "newSession", "fork", "importFromJsonl"] as const) {
		const original = runtime[method] as (...args: unknown[]) => Promise<unknown>;
		Object.defineProperty(runtime, method, {
			configurable: true,
			writable: true,
			value: async (...args: unknown[]) => {
				const source = runtime.session.sessionFile;
				if (!source || !isAbsolute(source)) return original.apply(runtime, args);
				const file = nativeLeadAdmission.file(source);
				file.generation++;
				file.active++;
				let target: ReturnType<LeadAdmission["file"]> | undefined;
				try {
					if ((file.locked || file.recovery) && !nativeLeadAdmission.owns(file))
						await nativeLeadAdmission.available(file);
					if (method === "switchSession" && typeof args[0] === "string") {
						const targetSource = resolve(args[0]);
						await recoveryPreflight?.(targetSource);
						target = nativeLeadAdmission.file(targetSource);
						target.opening++;
						target.generation++;
						if ((target.locked || target.recovery) && !nativeLeadAdmission.owns(target))
							await nativeLeadAdmission.available(target);
						if (target.session && target.session !== runtime.session && !nativeLeadAdmission.owns(target))
							throw new Error("cached-owner-collision");
					}
					return await (target
						? nativeLeadAdmission.runOpening(target, () => original.apply(runtime, args))
						: original.apply(runtime, args));
				} finally {
					if (target) {
						target.opening--;
						target.generation++;
					}
					file.active--;
					file.generation++;
					file.revision++;
				}
			},
		});
	}
	return runtime;
}
export const createAgentSessionRuntime: typeof createNativeRuntime = async (factory, options) =>
	fenceRuntime(await createNativeRuntime(factory, options));

export async function withNativeLifecycle<T>(
	session: AgentSessionRuntime["session"],
	operation: () => Promise<T>,
): Promise<T> {
	const source = session.sessionFile;
	if (!source || !isAbsolute(source)) return operation();
	const file = nativeLeadAdmission.file(source);
	file.active++;
	file.generation++;
	try {
		if ((file.locked || file.recovery) && !nativeLeadAdmission.owns(file)) await nativeLeadAdmission.available(file);
		return await operation();
	} finally {
		file.active--;
		file.generation++;
		file.revision++;
	}
}

/** File ownership before host scan/open, retained until an existing cache or new runtime is adopted. */
export async function withNativeOpen<T>(source: string, operation: () => Promise<T>): Promise<T> {
	if (!isAbsolute(source) || !existsSync(source)) return operation(); // Non-native/missing targets retain the host's normal validation path.
	await recoveryPreflight?.(resolve(source));
	const file = nativeLeadAdmission.file(resolve(source));
	file.opening++;
	file.generation++;
	try {
		await nativeLeadAdmission.available(file);
		return await nativeLeadAdmission.runOpening(file, operation);
	} finally {
		file.opening--;
		file.generation++;
	}
}
