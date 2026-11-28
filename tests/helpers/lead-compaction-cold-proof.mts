// External actual E/archive + H/native worker proof; no production fixture paths or model requests.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { LeadCompactionHost } from "../../server/lead-compaction-host.ts";
import { coldNativeApply, nativeSourceVerifier } from "../../server/lead-compaction-cold.ts";
import {
	nativeLeadAdmission,
	withNativeOpen,
	SessionManager as HostSessionManager,
} from "../../server/lead-compaction-runtime.ts";

const root = resolve(process.env.PI_OPENVIKING_ROOT ?? "../pi-openviking");
const load = (path: string) => import(pathToFileURL(join(root, path)).href);
const [{ fixture }, { startFakeOpenViking }, { createLeadExecutor }] = await Promise.all([
	load("tests/helpers/lead-executor-fixture.ts"),
	load("tests/helpers/fake-openviking.ts"),
	load("src/v2/lead-executor.ts"),
]);
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "host-cold-proof-"));
	const server = await startFakeOpenViking({ unknownRead: "404" });
	const f = fixture(dir, server.baseUrl);
	const config = { ...f.config, openVikingRoot: root };
	let loseAck = false;
	let tokens = 200000;
	let ackGate: Promise<void> | undefined;
	let reachAck!: () => void;
	const ackReached = new Promise<void>((resolve) => {
		reachAck = resolve;
	});
	let executor: ReturnType<typeof createLeadExecutor>;
	const host = new LeadCompactionHost(
		{
			resolveHome: (id) =>
				id === f.fence().sessionId ? { source: f.fence().source, role: "ops", bindingEpoch: 1 } : undefined,
			busy: () => false,
			invalidate: () => {},
			coldApply: coldNativeApply(config),
			verifySource: nativeSourceVerifier(config),
			reconstruct: async () => {
				throw new Error("unexpected-cached-owner");
			},
			acknowledge: async (prepared, result) => {
				reachAck();
				if (ackGate) await ackGate;
				if (loseAck) {
					loseAck = false;
					throw new Error("external-lost-ack");
				}
				await executor.acknowledge(prepared, result);
			},
		},
		nativeLeadAdmission,
	);
	executor = createLeadExecutor(config, host, {
		observation: () => ({
			checkpoint: f.fence().checkpoint,
			usage: { tokens, mutationRevision: host.captureFence(f.fence().sessionId).mutationRevision },
		}),
	});
	const makeTicket = async () => {
		const prepared = await executor.prepare(host.captureFence(f.fence().sessionId));
		assert.ok(prepared.originalFence, "canonical executor must prepare an actual archive plan");
		const ticket = await executor.resume(prepared.planId, prepared.planHash);
		assert.equal(ticket.state, undefined, "archive/readback must yield actual opaque host capability");
		return { prepared, ticket };
	};
	const { SessionManager } = await import(pathToFileURL(config.sdkModule).href);
	return {
		f,
		host,
		executor,
		makeTicket,
		config,
		dir,
		ackReached,
		holdAck: (gate: Promise<void>) => {
			ackGate = gate;
		},
		source: f.fence().source,
		cuts: () =>
			SessionManager.open(f.fence().source)
				.getEntries()
				.filter((e: { type: string }) => e.type === "compaction").length,
		loseAck: () => {
			loseAck = true;
		},
		belowThreshold: () => {
			tokens = 0;
		},
		close: async () => {
			await executor.close();
			await server.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
test("cold actual native worker preserves prefix, fsync/reopens and durably reconciles once", async () => {
	const f = await setup();
	try {
		const before = readFileSync(f.source);
		const { prepared, ticket } = await f.makeTicket();
		assert.equal((await f.host.tryApply(ticket)).state, "applied");
		assert.equal(f.cuts(), 1);
		assert.ok(readFileSync(f.source).subarray(0, before.length).equals(before));
		assert.equal((await f.executor.resume(prepared.planId, prepared.planHash)).state, "applied");
		assert.equal(f.cuts(), 1);
	} finally {
		await f.close();
	}
});
test("normal host open waits behind cold ownership and observes the single committed native entry", async () => {
	const f = await setup();
	let release!: () => void;
	try {
		f.holdAck(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		const { ticket } = await f.makeTicket();
		const apply = f.host.tryApply(ticket);
		await f.ackReached;
		let opened = false;
		const opening = withNativeOpen(f.source, async () => {
			assert.equal(nativeLeadAdmission.file(f.source).locked, false);
			const manager = HostSessionManager.open(f.source);
			opened = true;
			return manager.getEntries().filter((e) => e.type === "compaction").length;
		});
		assert.equal(opened, false);
		release();
		assert.equal((await apply).state, "applied");
		assert.equal(await opening, 1);
		assert.equal(f.cuts(), 1);
	} finally {
		release?.();
		await f.close();
	}
});
test("cold lost acknowledgement recovers under the same ownership without another append", async () => {
	const f = await setup();
	try {
		const { ticket } = await f.makeTicket();
		f.loseAck();
		assert.equal((await f.host.tryApply(ticket)).errorCode, "native-recovery-required");
		assert.equal(f.cuts(), 1);
		assert.equal(f.host.admission.file(f.source).recovery, true);
		await f.host.recover(f.f.fence().sessionId);
		assert.equal(f.cuts(), 1);
		assert.equal(f.host.admission.file(f.source).recovery, false);
	} finally {
		await f.close();
	}
});
test("process death after native append is reconciled on restart before threshold without a second cut", async () => {
	const f = await setup();
	try {
		const { prepared } = await f.makeTicket();
		const descriptor = join(f.dir, "crash-child.json");
		writeFileSync(
			descriptor,
			JSON.stringify({
				config: f.config,
				source: f.source,
				sessionId: f.f.fence().sessionId,
				checkpoint: f.f.fence().checkpoint,
				planId: prepared.planId,
				planHash: prepared.planHash,
			}),
		);
		const child = spawn(
			process.execPath,
			["--import", "tsx", fileURLToPath(new URL("./lead-compaction-crash-child.mts", import.meta.url)), descriptor],
			{ stdio: "ignore" },
		);
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("exit", resolve);
			child.once("error", reject);
		});
		assert.equal(code, 77, "child must die at the planted post-native, pre-ack boundary");
		assert.equal(f.cuts(), 1);
		f.belowThreshold();
		const reconciled = await f.executor.prepare(f.host.captureFence(f.f.fence().sessionId));
		assert.equal(reconciled.state, "applied");
		const { readLeadHandoffRecords } = await load("src/v2/lead-handoff-plan.ts");
		assert.equal(
			readLeadHandoffRecords(f.config.planPath).filter((r: { kind: string }) => r.kind === "applied").length,
			1,
		);
		assert.equal(f.cuts(), 1);
	} finally {
		await f.close();
	}
});
test("cold native worker refuses selected-byte drift after a ticket without cutting", async () => {
	const f = await setup();
	try {
		const { ticket } = await f.makeTicket();
		const original = readFileSync(f.source, "utf8");
		const changed = original.replace("owner request 0", "altered request");
		assert.notEqual(changed, original);
		writeFileSync(f.source, changed);
		assert.equal((await f.host.tryApply(ticket)).state, "blocked");
		assert.equal(f.cuts(), 0);
	} finally {
		await f.close();
	}
});
