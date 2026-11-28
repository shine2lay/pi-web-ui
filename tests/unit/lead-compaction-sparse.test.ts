import { test, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { nativeFixture } from "../helpers/lead-compaction-fixture.js";
import { createSparseHostPorts, type SparseLibrary } from "../../server/lead-compaction-sparse.js";
import { LeadCompactionHost, type LeadHostPorts } from "../../server/lead-compaction-host.js";
import { createLeadChecks } from "../../server/lead-compaction-checks.js";
import {
	coldNativeApply,
	nativeSourceVerifier,
	nativePrefixVerifier,
	nativeRecoveryInspection,
} from "../../server/lead-compaction-cold.js";
import {
	nativeLeadAdmission,
	setNativeRecoveryPreflight,
	withNativeOpen,
	SessionManager,
} from "../../server/lead-compaction-runtime.js";
const root = process.env.PI_OPENVIKING_ROOT ?? join(userInfo().homedir, "projects/pi-openviking");
const load = (name: string) => import(/* @vite-ignore */ pathToFileURL(join(root, "src/v2", name)).href);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
async function setup(wrap?: (library: SparseLibrary) => SparseLibrary) {
	const h = await nativeFixture({ inputHold: Promise.resolve(), leadingProtected: true });
	const dir = dirname(h.source),
		identitiesDir = join(dir, "identities");
	mkdirSync(join(identitiesDir, "ops"), { recursive: true });
	writeFileSync(join(identitiesDir, "ops", "identity.json"), JSON.stringify({ id: "ops", homeChat: h.source }), {
		mode: 0o600,
	});
	const rolloutStatePath = join(dir, "rollout.json");
	writeFileSync(rolloutStatePath, JSON.stringify({ phase: "v2" }), { mode: 0o600 });
	h.manager.appendCustomEntry("identity", { id: "ops" });
	for (let i = 0; i < 24; i++) {
		h.manager.appendMessage({ role: "user", content: `synthetic ${i}`, timestamp: 1 });
		h.manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(40000) }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			usage,
			stopReason: "stop",
			timestamp: 1,
		});
	}
	h.manager.appendMessage({ role: "user", content: "retain current input", timestamp: 2 });
	h.session.refreshContext();
	const [native, validation, material, api, fake] = await Promise.all([
		load("lead-sparse-native.ts"),
		load("lead-sparse-plan.ts"),
		load("lead-sparse-executor.ts"),
		load("lead-executor.ts"),
		import(/* @vite-ignore */ pathToFileURL(join(root, "tests/helpers/fake-openviking.ts")).href),
	]);
	const server = await fake.startFakeOpenViking({ unknownRead: "404" });
	const sdkModule = join(
		userInfo().homedir,
		"projects/pi-web-ui/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js",
	);
	const config = {
		sdkModule,
		baseUrl: server.baseUrl,
		stateDir: dir,
		rolloutStatePath,
		identitiesDir,
		sessionsRoot: dir,
		planPath: join(dir, "plans.jsonl"),
		metricsPath: join(dir, "metrics.jsonl"),
	};
	const executor = api.createLeadExecutor(config, h.host);
	let library = { ...native, ...validation, ...material } as SparseLibrary;
	if (wrap) library = wrap(library);
	h.configurePorts({
		acknowledge: (prepared, result) => executor.acknowledge(prepared, result),
		sparse: createSparseHostPorts({
			library,
			captureFence: (id) => h.host.captureFence(id),
			resolveHome: (id) =>
				id === h.session.sessionId ? { source: h.source, role: "ops", bindingEpoch: 0 } : undefined,
			verifyPrefix: async (source, _sid, n, digest) => {
				expect(hash(readFileSync(source).subarray(0, n))).toBe(digest);
			},
			progress: (prepared, cursor, id, fence) => executor.nativeProgress(prepared, cursor, id, fence),
		}),
	});
	return {
		...h,
		executor,
		server,
		native,
		api,
		library,
		config: { ...config, openVikingRoot: root },
		async closeAll() {
			await executor.close();
			await server.close();
			h.close();
		},
	};
}
test("cached sparse apply retains ownership across yields, queues input and refreshes only once", async () => {
	const yielded = gate(),
		continueApply = gate();
	let first = true;
	const h = await setup((library) => ({
		...library,
		applySparseNative: (app, port) =>
			library.applySparseNative(app, {
				...port,
				yield: async () => {
					if (first) {
						first = false;
						yielded.resolve();
						await continueApply.promise;
					}
				},
			}),
	}));
	try {
		const before = readFileSync(h.source),
			prepared = await h.executor.prepare(h.host.captureFence(h.session.sessionId));
		expect(prepared.strategy).toBe("sparse");
		const ticket = await h.executor.resume(prepared.planId, prepared.planHash);
		let refreshes = 0;
		const refresh = h.session.refreshContext.bind(h.session);
		h.session.refreshContext = () => {
			refreshes++;
			refresh();
		};
		const applying = h.host.tryApply(ticket);
		await yielded.promise;
		const file = h.host.admission.file(h.source);
		expect(file.internal).toBe(false);
		expect(h.host.admission.owns(file)).toBe(false);
		expect(() => h.manager.appendCustomEntry("foreign", {})).toThrow("file-owned-for-compaction");
		const input = h.session.prompt("queued synthetic input");
		expect(h.handledInputs()).toBe(0);
		continueApply.resolve();
		const result = await applying;
		expect(result.state).toBe("applied");
		await input;
		expect(refreshes).toBe(1);
		expect(h.handledInputs()).toBe(1);
		expect(h.modelCalls()).toBe(0);
		expect(readFileSync(h.source).subarray(0, before.length).equals(before)).toBe(true);
		expect(file.recovery).toBe(false);
		expect(file.locked).toBe(false);
	} finally {
		continueApply.resolve();
		await h.closeAll();
	}
}, 30000);

test("cached sparse failure keeps admission closed until exact native recovery completes", async () => {
	let fail = true;
	const h = await setup((library) => ({
		...library,
		applySparseNative: (app, port) =>
			library.applySparseNative(app, {
				...port,
				progress: async (cursor: number, id: string) => {
					await (port.progress as (cursor: number, id: string) => Promise<void>)(cursor, id);
					if (fail && cursor === 1) {
						fail = false;
						throw Error("synthetic cursor interruption");
					}
				},
			}),
	}));
	try {
		const prepared = await h.executor.prepare(h.host.captureFence(h.session.sessionId));
		const ticket = await h.executor.resume(prepared.planId, prepared.planHash);
		const result = await h.host.tryApply(ticket);
		expect(result.errorCode).toBe("native-recovery-required");
		expect(h.host.admission.file(h.source).recovery).toBe(true);
		await h.host.recover(h.session.sessionId);
		expect(h.host.admission.file(h.source).recovery).toBe(false);
		expect(h.modelCalls()).toBe(0);
		const records = h.host.admission.file(h.source).session!.sessionManager.getBranch();
		expect(h.native.pendingSparseApplications(records)).toEqual([]);
	} finally {
		await h.closeAll();
	}
}, 30000);

test("cold reopen reconciles durable sparse progress before native open or input admission", async () => {
	let fail = true;
	const h = await setup((library) => ({
		...library,
		applySparseNative: (app, port) =>
			library.applySparseNative(app, {
				...port,
				progress: async (cursor: number, id: string) => {
					await (port.progress as (cursor: number, id: string) => Promise<void>)(cursor, id);
					if (fail && cursor === 1) {
						fail = false;
						throw Error("synthetic process boundary");
					}
				},
			}),
	}));
	let next: Awaited<ReturnType<typeof h.create>> | undefined, coldExecutor: any;
	try {
		const prepared = await h.executor.prepare(h.host.captureFence(h.session.sessionId));
		const ticket = await h.executor.resume(prepared.planId, prepared.planHash);
		expect((await h.host.tryApply(ticket)).errorCode).toBe("native-recovery-required");
		const originalFile = h.host.admission.file(h.source);
		h.host.admission.owned(originalFile, () => h.session.dispose());
		const inspection = nativeRecoveryInspection(h.config),
			pending = await inspection(h.source, h.session.sessionId);
		expect(pending).toHaveLength(1);
		const ports: LeadHostPorts = {
			resolveHome: (id) =>
				id === h.session.sessionId ? { source: h.source, role: "ops", bindingEpoch: 0 } : undefined,
			busy: () => false,
			invalidate: () => {},
			acknowledge: (p, r) => coldExecutor.acknowledge(p, r),
			coldApply: coldNativeApply(h.config),
			verifySource: nativeSourceVerifier(h.config),
			reconstruct: async () => {
				throw Error("unexpected cached reconstruction");
			},
		};
		const coldHost = new LeadCompactionHost(ports, nativeLeadAdmission);
		coldExecutor = h.api.createLeadExecutor(h.config, coldHost);
		ports.sparse = createSparseHostPorts({
			library: h.library,
			captureFence: (id) => coldHost.captureFence(id),
			resolveHome: ports.resolveHome,
			verifyPrefix: nativePrefixVerifier(h.config),
			progress: (p, cursor, id, f) => coldExecutor.nativeProgress(p, cursor, id, f),
		});
		const checks = createLeadChecks(coldHost, coldExecutor);
		let admitted = false;
		setNativeRecoveryPreflight(async (source) => {
			if (source !== h.source) return;
			const outstanding = await inspection(source, h.session.sessionId);
			if (outstanding.length) {
				coldHost.markSparsePending(h.session.sessionId, outstanding[0]);
				expect(admitted).toBe(false);
				expect(
					(
						await checks.recoverPending(
							h.session.sessionId,
							outstanding[0].applicationId,
							outstanding[0].applicationHash,
						)
					).state,
				).toBe("applied");
			}
		});
		const manager = await withNativeOpen(h.source, async () => {
			expect(await inspection(h.source, h.session.sessionId)).toEqual([]);
			admitted = true;
			return SessionManager.open(h.source);
		});
		const file = nativeLeadAdmission.file(h.source);
		next = await nativeLeadAdmission.owned(file, () => h.create(manager));
		coldHost.attach(next);
		await next.prompt("first input only after durable recovery");
		expect(h.handledInputs()).toBe(1);
		expect(h.modelCalls()).toBe(0);
		expect(file.recovery).toBe(false);
	} finally {
		setNativeRecoveryPreflight(undefined);
		if (next) {
			const f = nativeLeadAdmission.file(h.source);
			nativeLeadAdmission.owned(f, () => next!.dispose());
			f.session = undefined;
		}
		await coldExecutor?.close();
		await h.closeAll();
	}
}, 30000);
