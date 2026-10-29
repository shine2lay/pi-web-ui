// Fixed scalar fixtures only: no model input/output, auth store, service, live ledger or chat.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANG_GUARD_MS } from "./load-independent.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	allocated,
	heldTokens,
	reservationBlock,
	validBudget,
	validLocalCall,
} from "../../server/decision-batch-budget.js";
import {
	BATCH_MODEL,
	BATCH_PROVIDER,
	DecisionBatchControl,
	validLedger,
	type BatchConfig,
	type BatchLedger,
	type BatchControlOptions,
} from "../../server/decision-batches.js";
import { DecisionStore } from "../../server/decision-store.js";
import type { DecisionRecord } from "../../server/decision-records.js";
import { AgentService } from "../../server/agent-service.js";
import { controlPath, startControlServer } from "../../server/control-socket.js";
import {
	canonical,
	collectLegacyProof,
	H7,
	H7_NONCE,
	isDecisionServiceProcess,
	liveCollectorEnv,
	runReadOnly,
	type CollectorEnv,
	newLocalCall,
	parseRecoveryCommand,
	persistLedger,
	sha256,
	validateNativeApproval,
	verifyLegacyProof,
	withLedgerExclusion,
	type LegacyProof,
	type NativeApproval,
} from "../../server/decision-recovery.js";
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const now = Date.parse("2026-10-12T18:20:00Z");
const identity = { provider: BATCH_PROVIDER, id: BATCH_MODEL, thinking: "medium" };
const command = { operation: "H7-R2" as const, nonce: H7_NONCE, beforeHash: H7.beforeHash, dryRun: false };
const order =
	"Owner in Ops queue task98, m02302: keep going thru all batches one by one; max20 records/500000 additional tokens per chunk; automatic sequential continuation, existing stops retained";
const config: BatchConfig = {
	v: 1,
	approval: order,
	provider: BATCH_PROVIDER,
	model: BATCH_MODEL,
	thinking: "medium",
	maxRecords: 20,
	tokenLimit: 500000,
	dailyTokenCap: 6000000,
	historicTokensByDay: { "2026-10-10": 173176, "2026-10-11": 24459 },
	historicUnknownByDay: { "2026-10-11": 163161 },
};
// Native pinned legacy image is reconstructed from these numeric scalars, not read from HOME.
const history = [
	[1791775613668, 1791775688004, 1, 25495, 1],
	[1791775688192, 1791775747121, 1, 25103, 1],
	[1791775748003, 1791775803904, 3, 21813, 2],
	[1791775805222, 1791775870248, 4, 26513, 5],
	[1791775873162, 1791775954143, 2, 28820, 2],
	[1791775961294, 1791776011239, 3, 20979, 2],
	[1791776011617, 1791776091143, 1, 25198, 1],
	[1791776091472, 1791776188197, 1, 33133, 1],
	[1791776188566, 1791776247195, 2, 25716, 1],
	[1791776247537, 1791776282316, 2, 16211, 1],
	[1791776282502, 1791776351482, 1, 27149, 1],
	[1791776361320, 1791776413379, 2, 21447, 2],
	[1791776413712, 1791776452012, 1, 18750, 1],
	[1791776452439, 1791776534751, 1, 30887, 1],
	[1791776535065, 1791776593102, 2, 24646, 1],
	[1791776593297, 1791776657089, 1, 24735, 1],
	[1791776657429, 1791776693614, 1, 18829, 1],
	[1791776706199, 1791776751272, 2, 19895, 1],
	[1791776751496, 1791776785282, 1, 17603, 1],
	[1791776785664, 1791776843120, 2, 24834, 1],
	[1791776843351, 1791776885743, 4, 17849, 1],
	[1791776886082, 1791776980380, 1, 34776, 1],
	[1791776981748, 1791777001689, 2, 11120, 2],
	[1791777001973, 1791777070200, 1, 29692, 1],
	[1791777078254, 1791777129835, 3, 21018, 2],
	[1791777130146, 1791777189660, 1, 24724, 1],
	[1791777189981, 1791777271660, 1, 33020, 1],
	[1791777271850, 1791777322776, 1, 24685, 1],
	[1791777323205, 1791777421745, 1, 36385, 1],
	[1791777422552, 1791777505511, 1, 29329, 1],
	[1791777505795, 1791777554854, 1, 22904, 1],
	[1791777555053, 1791777658472, 1, 32429, 1],
	[1791777659456, 1791777714826, 4, 23647, 1],
	[1791777715147, 1791777786429, 1, 30360, 1],
	[1791777789195, 1791777817576, 1, 12911, 2],
	[1791777817891, 1791777857995, 1, 20896, 1],
];
function legacyImage(): string {
	const image = JSON.stringify(
		{
			v: 1,
			approval: order,
			historicTokensByDay: config.historicTokensByDay,
			historicUnknownByDay: config.historicUnknownByDay,
			newTokensByDay: { "2026-10-11": 883501 },
			chunks: history.map(([at, ended, selected, actual, calls], i) => ({
				n: i + 1,
				at,
				ended,
				reason: "records complete",
				selected,
				newRead: selected,
				actual,
				unknown: 0,
				calls,
			})),
			configProof: JSON.stringify(config),
			current: {
				n: 37,
				at: 1791777858313,
				ids: [...H7.ids],
				alreadyRead: [],
				budget: {
					v: 1,
					limit: 500000,
					actual: 0,
					calls: 0,
					pending: { tokens: 170198, inputUpper: 42198, outputUpper: 128000, at: H7.at },
				},
			},
			stopReason: "unresolved call cost",
		},
		null,
		"\t",
	);
	return `${image}\n`;
}
function approval(): NativeApproval {
	return {
		recordId: H7.approvalId,
		rawHash: H7.approvalHash,
		ref: H7.approvalRef,
		at: 1791827495304,
		question: H7.question,
		planHash: H7.planHash,
		nativePlanHash: H7.nativePlanHash,
		evidenceHash: H7.evidenceHash,
	};
}
function proof(): LegacyProof {
	const boot = "aacd6a99-8828-4bc5-9b38-2613ba089dfa";
	return {
		at: now,
		current: { invocation: "f".repeat(32), pid: 2, start: "2222", boot },
		oldInvocation: H7.legacyInvocation,
		oldPid: H7.legacyPid,
		oldStart: {
			at: H7.at - 3600000,
			pid: H7.legacyPid,
			invocation: H7.legacyInvocation,
			cursor: "known-start",
			monotonic: "1111",
			boot,
		},
		oldPidAbsent: true,
		duplicates: [],
		quiescent: true,
		complete: true,
		gapped: false,
		suppressed: false,
		starts: [
			{
				at: H7.at,
				pid: H7.legacyPid,
				invocation: H7.legacyInvocation,
				cursor: H7.legacyCursor,
				monotonic: "1234",
				boot,
			},
		],
		terminals: 0,
		stoppedUsec: H7.stoppedUsec,
		sequenceHash: "c".repeat(64),
		sequenceGaps: 0,
		journalHash: "a".repeat(64),
		runtimeHash: "b".repeat(64),
		legacySourceVerified: true,
	};
}
const row = (id: string): DecisionRecord => ({
	v: 1,
	id,
	ref: `rm-${id}`,
	source: "message",
	from: "ops",
	to: "data",
	how: "live",
	at: H7.at,
	seen: H7.at,
	initiative: "team-in-temper",
});
function fixture(overrides: BatchControlOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "h7-recovery-stage-"));
	dirs.push(dir);
	const store = new DecisionStore(dir);
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({
			enabled: false,
			initiatives: ["team-in-temper"],
			model: "auto",
			thinking: "medium",
			batchRecords: 4,
			dailyTokenCap: 6000000,
		}),
	);
	writeFileSync(join(dir, "reader-batch-settings.json"), JSON.stringify(config));
	writeFileSync(join(dir, "reader-batches.json"), legacyImage());
	writeFileSync(
		join(dir, "reader-batch-guard.json"),
		JSON.stringify({
			provider: BATCH_PROVIDER,
			guardExpiresAt: now / 1000 + 3600,
			stopped: false,
			lastReading: { at: now / 1000, week: 10, five: 20 },
		}),
	);
	const options = {
		now: () => now,
		guardActive: () => true,
		recoveryApproval: approval,
		recoveryProof: proof,
		...overrides,
	};
	const ctl = new DecisionBatchControl(store, options);
	const cold = () => new DecisionBatchControl(store, options);
	const raw = () => readFileSync(ctl.ledgerFile, "utf8");
	const ledger = () => JSON.parse(raw()) as BatchLedger;
	return { dir, store, ctl, cold, raw, ledger, options };
}
function enable(f: ReturnType<typeof fixture>) {
	const s = f.store.settings();
	s.enabled = true;
	writeFileSync(join(f.dir, "settings.json"), JSON.stringify(s));
}
function recover(f: ReturnType<typeof fixture>) {
	const r = f.ctl.recover(command, true);
	expect(r.ok, r.error).toBe(true);
	return r;
}
describe("H7 exact join and approval stages", () => {
	it("recognises absolute and relative native service scripts, not unrelated node processes", () => {
		for (const script of [
			"/home/test/pi-web-ui/dist/server/index.js",
			"dist/server/index.js",
			"./dist/server/index.js",
			"server/index.ts",
			"server/index.js",
			// How the live unit starts it (H7-FIX-1-MEASURE.json serviceArgv), and the launcher it links to.
			"/home/shinelay/.nvm/versions/node/v22.22.0/bin/pi-web-ui",
			"/home/shinelay/projects/pi-web-ui/bin/pi-web-ui.mjs",
			"bin/pi-web-ui",
		])
			expect(isDecisionServiceProcess(["node", script])).toBe(true);
		for (const args of [
			["node", "tools/check.mjs"],
			["node", "-e", "console.log('hello')"],
			["python", "server/index.py"],
			["grep", "pi-web-ui"],
			["bash", "/home/shinelay/.local/bin/pi-web-deploy", "status"],
			["node", "/home/shinelay/projects/pi-web-ui/bin/pi-web-ui.mjs.bak"],
		])
			expect(isDecisionServiceProcess(args)).toBe(false);
	});
	it("reconstructs the fixed pinned legacy bytes, not just their totals", () => {
		expect(sha256(legacyImage())).toBe(H7.beforeHash);
		expect(validLedger(JSON.parse(legacyImage()), config)).toBe(true);
	});
	it("clean legacy local-death proof passes; negative cases do not", () => {
		expect(() => verifyLegacyProof(proof(), now)).not.toThrow();
		const cases: Partial<LegacyProof>[] = [
			{ oldPidAbsent: false },
			{ duplicates: [7] },
			{ quiescent: false },
			{ complete: false },
			{ gapped: true },
			{ suppressed: true },
			{ sequenceGaps: 1 },
			{ terminals: 1 },
			{ oldPid: H7.legacyPid + 1 },
			{ oldInvocation: "e".repeat(32) },
			{ at: now - 30001 },
			{ starts: [...proof().starts, ...proof().starts] },
			{ starts: [] },
			{ current: { ...proof().current, pid: H7.legacyPid } },
			{ oldStart: { ...proof().oldStart, monotonic: "9999" } },
			{ legacySourceVerified: false },
		];
		for (const change of cases) expect(() => verifyLegacyProof({ ...proof(), ...change }, now)).toThrow();
	});
	it("caller strings cannot add an operation, authority or supplied evidence", () => {
		expect(parseRecoveryCommand(command)).toEqual(command);
		for (const bad of [
			{ ...command, nonce: "another" },
			{ ...command, beforeHash: "stale" },
			{ ...command, approval: "Owner said yes" },
			{ ...command, proof: proof() },
			{ ...command, dryRun: "false" },
			{ ...command, operation: "old163161" },
		])
			expect(parseRecoveryCommand(bad)).toBeUndefined();
	});
	it("known-good isolated native format passes; fake/missing/stale/wrong version deny", () => {
		const native = {
			v: 1,
			id: H7.approvalId,
			source: "answer",
			from: "owner",
			to: "ops",
			how: "live",
			ref: H7.approvalRef,
			answeredIn: "telegram",
			at: now - 1000,
			questions: [
				{
					id: H7.question,
					picked: ["Approve exact H7 repair"],
					detail: [
						"Ops #121 H7-R2 unmodified installer health check",
						H7.planHash,
						H7.nativePlanHash,
						H7.evidenceHash,
						H7.beforeHash,
						H7.at,
						...H7.ids,
					].join(" "),
				},
			],
		};
		const raw = JSON.stringify(native);
		// Fixture pin exists only inside this pure-format test. Production lookup has fixed H7 pins/paths.
		const pin = { ...H7, approvalHash: sha256(raw) };
		expect(validateNativeApproval(raw, pin).recordId).toBe(H7.approvalId);
		expect(() => validateNativeApproval(raw)).toThrow("native approval hash mismatch");
		for (const bad of [
			{ ...native, from: "ops" },
			{ ...native, at: H7.at - 1 },
			{ ...native, questions: [{ ...native.questions[0], picked: ["Keep reader off"] }] },
			{ ...native, questions: [{ ...native.questions[0], detail: "approval-looking string" }] },
		]) {
			const body = JSON.stringify(bad);
			expect(() => validateNativeApproval(body, { ...H7, approvalHash: sha256(body) })).toThrow();
		}
		for (const callback of [
			() => {
				throw new Error("native approval missing");
			},
			() => validateNativeApproval(raw),
		]) {
			const f = fixture({ recoveryApproval: callback });
			const before = f.raw();
			expect(f.ctl.recover(command, true).ok).toBe(false);
			expect(f.raw()).toBe(before);
		}
	});
});
describe("H7 atomic transition, replay and fencing stages", () => {
	it("dry run is read-only; one receipt retires only occupancy, preserves all charges and IDs", () => {
		const f = fixture();
		const before = f.raw();
		const original = f.ledger();
		const dry = f.ctl.recover({ ...command, dryRun: true }, true);
		expect(dry.ok).toBe(true);
		expect(f.raw()).toBe(before);
		const r = recover(f);
		const l = f.ledger();
		expect(l.v).toBe(2);
		expect(l.generation).toBe(1);
		expect(l.current!.budget.pending).toBeUndefined();
		expect(l.current!.ids).toEqual(H7.ids);
		expect(l.current!.alreadyRead).toEqual([]);
		expect(l.current!.budget.actual).toBe(0);
		expect(l.current!.budget.calls).toBe(0);
		expect(allocated(l.current!.budget)).toBe(170198);
		expect(heldTokens(l.current!.budget)).toBe(170198);
		expect(l.historicTokensByDay).toEqual(original.historicTokensByDay);
		expect(l.historicUnknownByDay).toEqual(original.historicUnknownByDay);
		expect(l.newTokensByDay).toEqual(original.newTokensByDay);
		expect(l.carriedUnknownByDay).toEqual({ "2026-10-11": 170198 });
		expect(l.audit!.beforeImage).toBe(before);
		expect(validLedger(l, config)).toBe(true);
		expect(r).toMatchObject({ recorded: 1081136, unknown: 333359, allocated: 1414495, remaining: 329802 });
		const after = f.raw();
		const replay = f.ctl.recover(command, true);
		expect(replay).toMatchObject({ ok: true, existing: true, receiptHash: r.receiptHash });
		expect(f.raw()).toBe(after);
		expect(replay.wholeFileHash).toBe(sha256(after));
		expect(f.store.settings().enabled).toBe(false);
		expect(Object.keys(f.store.readerState().read)).toHaveLength(0);
	});
	it("all live/duplicate/gapped/PID reuse admissions deny without mutation", () => {
		for (const change of [
			{ oldPidAbsent: false },
			{ duplicates: [7] },
			{ gapped: true },
			{ complete: false },
			{ starts: [...proof().starts, ...proof().starts] },
			{ current: { ...proof().current, pid: H7.legacyPid } },
		]) {
			const f = fixture({ recoveryProof: () => ({ ...proof(), ...change }) });
			const before = f.raw();
			expect(f.ctl.recover(command, true).ok).toBe(false);
			expect(f.raw()).toBe(before);
		}
		const f = fixture();
		enable(f);
		expect(f.ctl.recover(command, true).ok).toBe(false);
		expect(f.ctl.recover(command, false).ok).toBe(false);
	});
	it("a stale controller and every old callback fence cannot overwrite recovery", () => {
		const f = fixture(),
			stale = f.cold();
		stale.status();
		const oldFence = f.ctl.captureFence()!;
		recover(f);
		const after = f.raw();
		expect(() => stale.pause("late failure", true)).toThrow();
		expect(() => stale.settle({ input: 1, output: 1 }, oldFence)).toThrow();
		expect(() => f.ctl.pause("late failure", true, oldFence)).toThrow();
		f.ctl.progress();
		f.ctl.prepare(H7.ids.map(row));
		expect(f.raw()).toBe(after);
		expect(stale.reserve(1, 1, identity, oldFence)).toBeTruthy();
		expect(f.raw()).toBe(after);
	});
	it("cold v1/v2 reads never migrate, reset or recreate; canonical receipt has no self reference", () => {
		const f = fixture();
		const before = f.raw();
		f.cold().status();
		expect(f.raw()).toBe(before);
		recover(f);
		const after = f.raw();
		const cold = f.cold();
		expect(cold.status().unknown).toBe(333359);
		expect(cold.recover(command, true).existing).toBe(true);
		expect(f.raw()).toBe(after);
		const r = f.ledger().receipts![H7_NONCE];
		expect(r.hash).toBe(sha256(canonical(r.payload)));
		expect(Object.keys(r.payload)).not.toContain("hash");
		expect(Object.keys(r.payload)).not.toContain("afterHash");
		expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
		expect(() => canonical({ bad: undefined })).toThrow();
	});
	it("wrong hash/record ID/day or an insufficient numeric image is never accepted", () => {
		for (const mutate of [
			(l: BatchLedger) => {
				l.current!.ids[0] = "another";
			},
			(l: BatchLedger) => {
				l.current!.budget.pending!.tokens = 500001;
			},
			(l: BatchLedger) => {
				l.historicUnknownByDay[H7.day] = 6000000;
			},
			(l: BatchLedger) => {
				l.current!.budget.pending!.at++;
			},
		]) {
			const f = fixture(),
				l = f.ledger();
			mutate(l);
			writeFileSync(f.ctl.ledgerFile, JSON.stringify(l));
			const before = f.raw();
			expect(f.ctl.recover(command, true).ok).toBe(false);
			expect(f.raw()).toBe(before);
		}
	});
	it("a replay preserves an unrelated terminal hold instead of clearing it", () => {
		const f = fixture();
		recover(f);
		f.ctl.pause("unrelated hold", true);
		const before = f.raw();
		expect(f.ctl.recover(command, true).existing).toBe(true);
		expect(f.raw()).toBe(before);
		expect(f.ledger().halted).toBe(true);
		expect(f.ledger().stopReason).toBe("unrelated hold");
	});
	it("a continued recovered call charges its old origin day even after midnight", () => {
		const f = fixture();
		recover(f);
		enable(f);
		f.ctl.prepare(H7.ids.map(row));
		const fence = f.ctl.captureFence()!;
		expect(f.ctl.reserve(42198, 128000, identity, fence)).toBeUndefined();
		expect(f.ledger().current!.budget.pending!.local!.day).toBe("2026-10-11");
		f.ctl.settle({ input: 1000, output: 1000 }, fence);
		expect(f.ledger().newTokensByDay).toEqual({ "2026-10-11": 885501 });
		expect(f.ledger().carriedUnknownByDay).toEqual({ "2026-10-11": 170198 });
		expect(f.ledger().current!.n).toBe(37);
	});
	it("retained unknowns cannot escape into a new chunk or day", () => {
		const f = fixture();
		recover(f);
		enable(f);
		f.ctl.prepare(H7.ids.map(row));
		expect(f.ctl.reserve(201802, 128001, identity)).toBe("recovered chunk allowance exhausted");
		expect(f.ledger().current!.n).toBe(37);
		expect(f.ledger().chunks).toHaveLength(36);
		const b = f.ledger().current!.budget;
		expect(reservationBlock(b, 201802, 128000, now)).toBeUndefined();
		const forged = f.ledger();
		forged.current!.budget.unknowns![0].day = "2026-10-12";
		expect(validLedger(forged, config)).toBe(false);
		expect(validBudget({ ...b, unknowns: undefined })).toBe(false);
	});
});
describe("H7 immutable receipt validation", () => {
	it("retains the clean audit, native reservation, generation and day baseline on cold load", () => {
		const f = fixture();
		recover(f);
		const before = f.raw();
		expect(validLedger(f.ledger(), config)).toBe(true);
		expect(f.cold().status().unknown).toBe(333359);
		expect(f.raw()).toBe(before);
	});
	const cases: [string, (l: BatchLedger) => void][] = [
		[
			"generation before receipt",
			(l) => {
				l.generation = 0;
			},
		],
		[
			"receipt generation not joined to audit",
			(l) => {
				l.receipts![H7_NONCE].payload.beforeGeneration++;
			},
		],
		[
			"reservation not joined to audit",
			(l) => {
				l.receipts![H7_NONCE].payload.reservation.tokens--;
			},
		],
		[
			"changed old call counter",
			(l) => {
				l.chunks[0].calls++;
			},
		],
		[
			"known old-day tokens moved to new day",
			(l) => {
				l.newTokensByDay[H7.day]--;
				l.newTokensByDay["2026-10-12"] = 1;
			},
		],
		[
			"receipt after-hash self reference",
			(l) => {
				(l.receipts![H7_NONCE].payload as unknown as Record<string, unknown>).afterHash = "0".repeat(64);
			},
		],
	];
	it.each(cases)("denies %s even when public receipt hashes are recomputed", (_name, mutate) => {
		const f = fixture();
		recover(f);
		const l = f.ledger();
		mutate(l);
		const r = l.receipts![H7_NONCE];
		r.payload.reservationHash = sha256(canonical(r.payload.reservation));
		r.hash = sha256(canonical(r.payload));
		const hold = l.current!.budget.unknowns![0];
		hold.receipt = r.hash;
		hold.id = sha256(
			canonical({ beforeHash: H7.beforeHash, chunk: H7.chunk, reservationHash: r.payload.reservationHash }),
		);
		expect(validLedger(l, config)).toBe(false);
		writeFileSync(f.ctl.ledgerFile, JSON.stringify(l));
		const bad = f.raw();
		expect(f.cold().status().recorded).toBeNull();
		expect(f.raw()).toBe(bad);
	});
});
describe("H7 filesystem exclusion and crash stages", () => {
	it("nested/concurrent writers and partial/dead locks fail closed", () => {
		const f = fixture();
		const before = f.raw();
		withLedgerExclusion(f.ctl.ledgerFile, () => {
			expect(() => withLedgerExclusion(f.ctl.ledgerFile, () => undefined)).toThrow("exclusion unavailable");
			expect(f.ctl.recover(command, true).ok).toBe(false);
		});
		mkdirSync(`${f.ctl.ledgerFile}.lock`);
		expect(f.ctl.recover(command, true).ok).toBe(false);
		expect(f.raw()).toBe(before);
	});
	it.each(["before-file-sync", "before-rename", "after-rename", "after-directory-sync"] as const)(
		"%s failure exposes either full old image or full charged receipt, never partial accounting",
		(stage) => {
			const f = fixture({
				persistFault: (at) => {
					if (at === stage) throw new Error("fixed fsync/crash failure");
				},
			});
			const before = f.raw();
			expect(f.ctl.recover(command, true).ok).toBe(false);
			if (stage.startsWith("before")) expect(f.raw()).toBe(before);
			else {
				expect(validLedger(f.ledger(), config)).toBe(true);
				expect(f.cold().status().unknown).toBe(333359);
				expect(f.cold().recover(command, true).existing).toBe(true);
			}
		},
	);
	it("a separate process cannot enter an owned writer lease", () => {
		const f = fixture();
		withLedgerExclusion(f.ctl.ledgerFile, () => {
			const path = new URL("../../server/decision-recovery.ts", import.meta.url).href;
			const code = `import {withLedgerExclusion} from ${JSON.stringify(path)};
try {withLedgerExclusion(${JSON.stringify(f.ctl.ledgerFile)},()=>{}); process.exit(2)} catch {console.log('denied')}`;
			expect(
				execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], {
					encoding: "utf8",
				}).trim(),
			).toBe("denied");
		});
	});
	it("CAS rejects a changed file while holding exclusion", () => {
		const f = fixture();
		withLedgerExclusion(f.ctl.ledgerFile, () =>
			expect(() => persistLedger(f.ctl.ledgerFile, "0".repeat(64), {})).toThrow("stale ledger hash"),
		);
	});
});

describe("H7 native control admissions", () => {
	it("native SDK in-memory session and local process metadata require no prompt, auth or persisted chat", () => {
		const f = fixture();
		const before = f.raw();
		const manager = SessionManager.inMemory(f.dir);
		const local = newLocalCall(now);
		expect(validLocalCall(local)).toBe(true);
		expect(manager.getSessionId()).toMatch(/^[a-f0-9-]{36}$/);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getEntries()).toHaveLength(0);
		manager.appendCustomEntry("h7-metadata-fixture", { callRef: local.ref });
		expect(manager.getEntries()).toHaveLength(1);
		expect(manager.getEntries()[0].type).toBe("custom");
		expect(f.raw()).toBe(before);
	});
	it("AgentService checks both timer/manual busy state and native reader running metadata", () => {
		const f = fixture();
		const before = f.raw();
		const run = (reader: unknown, manual = false) =>
			AgentService.prototype.decisionsRecoverCall.call(
				{
					decisionBatchControl: f.ctl,
					decisionReader: reader,
					decisionReadNow: manual,
				} as unknown as AgentService,
				{ ...command, dryRun: true },
			);
		for (const reader of [undefined, {}, { running: true }]) expect(run(reader).ok).toBe(false);
		expect(run({ running: false }, true).ok).toBe(false);
		expect(run({ running: false }).ok).toBe(true);
		expect(f.raw()).toBe(before);
	});
	it("native socket allows only exact metadata and never caller-provided approval or proof", async () => {
		const f = fixture();
		let calls = 0;
		const stop = startControlServer({
			dataDir: f.dir,
			port: 0,
			service: {
				serviceStatus: () => ({}) as never,
				quiesce: () => {},
				unquiesce: () => {},
				decisionsRecoverCall: (v) => {
					calls++;
					return f.ctl.recover(v as typeof command, true);
				},
			},
		});
		try {
			const socket = controlPath(f.dir, 0);
			if (!existsSync(socket))
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						listener.close();
						reject(new Error("fixture socket missing"));
					}, HANG_GUARD_MS); // Ops #639: a hang guard; 2 s could run out on a busy machine
					const listener = watch(f.dir, () => {
						if (existsSync(socket)) {
							clearTimeout(timer);
							listener.close();
							resolve();
						}
					});
				});
			const ask = (value: unknown) =>
				new Promise<{ ok: boolean }>((resolve, reject) => {
					const sock = createConnection(socket);
					let text = "";
					sock.on("connect", () => sock.write(`${JSON.stringify(value)}\n`));
					sock.on("data", (part) => {
						text += part.toString();
						if (text.includes("\n")) {
							sock.destroy();
							resolve(JSON.parse(text.split("\n")[0]));
						}
					});
					sock.on("error", reject);
				});
			for (const req of [
				{ cmd: "decisions_recover_call", recovery: { ...command, proof: proof() } },
				{ cmd: "decisions_recover_call", recovery: command, approval: "approved" },
			] as const)
				expect((await ask(req)).ok).toBe(false);
			expect(calls).toBe(0);
			expect((await ask({ cmd: "decisions_recover_call", recovery: { ...command, dryRun: true } })).ok).toBe(true);
			expect(calls).toBe(1);
			expect(f.ledger().v).toBe(1);
		} finally {
			stop();
		}
	});
});

describe("H7 actual cold old-code counterexamples", () => {
	function oldProcess(f: ReturnType<typeof fixture>) {
		const sourceDir = join(f.dir, "old-source");
		mkdirSync(sourceDir);
		writeFileSync(join(sourceDir, "package.json"), '{"type":"module"}');
		for (const file of ["decision-batches.ts", "decision-batch-budget.ts"]) {
			writeFileSync(
				join(sourceDir, file),
				execFileSync("git", ["show", `${H7.legacyHead}:server/${file}`], { encoding: "utf8" }),
			);
		}
		writeFileSync(
			join(sourceDir, "decision-records.ts"),
			`export const localDay = (n) => new Intl.DateTimeFormat("en-CA", {timeZone:"America/Los_Angeles"}).format(new Date(n));`,
		);
		const script = join(sourceDir, "cold.mjs");
		writeFileSync(
			script,
			`import {DecisionBatchControl} from './decision-batches.ts';
import {readFileSync} from 'node:fs';
const dir = ${JSON.stringify(f.dir)};
const store = {dir, settings:()=>({enabled:true,model:'auto',thinking:'medium',initiatives:['team-in-temper'],dailyTokenCap:6000000,batchRecords:4}),readerState:()=>({read:{}}),inInitiatives:(rs)=>rs};
const before = readFileSync(dir+'/reader-batches.json','utf8');
const c = new DecisionBatchControl(store,{now:()=>${now},guardActive:()=>true});
c.prepare(${JSON.stringify(H7.ids.map(row))});
const status=c.status(), missing=typeof c.recover==='undefined', blocked=c.preflight(${JSON.stringify(identity)});
c.pause('cold-old-code');
console.log(JSON.stringify({missing,blocked,status,unchanged:before===readFileSync(dir+'/reader-batches.json','utf8')}));`,
		);
		return JSON.parse(
			execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), script], { encoding: "utf8" }),
		);
	}
	it("old code fails verified recovery on absent operation/unresolved occupancy, retaining unsafe-retry stop", () => {
		const f = fixture();
		const r = oldProcess(f);
		expect(r.missing).toBe(true);
		expect(r.blocked).toBe("unresolved call cost");
		expect(r.unchanged).toBe(false);
		// Old pause may add stopReason, but it must retain the unresolved charge and not read/prompt.
		expect(f.ledger().current!.budget.pending!.tokens).toBe(170198);
	});
	it("a fresh old-code PROCESS with retained v2 denies without reset/recreation", () => {
		const f = fixture();
		recover(f);
		const before = f.raw();
		const r = oldProcess(f);
		expect(r.blocked).toBe("batch configuration unavailable or changed");
		expect(r.status.recorded).toBeNull();
		expect(r.unchanged).toBe(true);
		expect(f.raw()).toBe(before);
		expect(existsSync(f.ctl.ledgerFile)).toBe(true);
	});
});

// H7-FIX-1: the collector itself, on fixtures shaped like the live machine (H7-FIX-1-MEASURE.json, 2026-10-13):
// one journald counter for system and user entries (full view 0 gaps, --user view 2996 gaps), verify 27 s,
// the unit launched as bin/pi-web-ui. Each case fails on the 113d0f5 collector, which ignored this env.
describe("H7-FIX-1 collector on live-shaped fixtures", () => {
	const S = "e2ee25b096694b7885dfface12521863";
	const B = "aacd6a9988284bc59b382613ba089dfa";
	const bootId = "aacd6a99-8828-4bc5-9b38-2613ba089dfa";
	const promptSeq = 0x838b61;
	const promptUsec = Number.parseInt("65d9ccac553bf", 16);
	const promptMono = Number.parseInt("115d66befa3", 16);
	const servicePid = 2909433;
	const serviceInvocation = "7abf3cbf99674974b881c2184a31cba6";
	const bin = "/home/shinelay/.nvm/versions/node/v22.22.0/bin/pi-web-ui";
	const modulePath = "/fixture/pi-web-ui/dist/server/decision-recovery.js";
	const legacySource = "// legacy decision-batches.ts at 9fe5b68\n";
	type Row = Record<string, string>;
	interface Shape {
		fullViewReadable?: boolean;
		secondStream?: boolean;
		journaldMessages?: string[];
		extraProcesses?: { pid: number; args: string[] }[];
		systemdPid?: number;
		module?: { path: string; hash: string } | undefined;
		moduleBytes?: string;
		legacyPidAlive?: boolean;
		terminal?: boolean;
	}
	function machine(shape: Shape = {}) {
		const calls: string[][] = [];
		// [realtime usec, monotonic usec, user journal?, fields]; seqnums follow this order with no holes.
		const plan: [number, number, boolean, Row][] = [
			[promptUsec - 90e6, promptMono - 90e6, false, {}],
			[promptUsec - 60e6, promptMono - 60e6, true, { _PID: String(H7.legacyPid), MESSAGE: "listening" }],
			[promptUsec - 30e6, promptMono - 30e6, false, {}],
			[
				promptUsec,
				promptMono,
				true,
				{
					_PID: String(H7.legacyPid),
					MESSAGE: `[decisions-call] ${JSON.stringify({ phase: "prompt_started", at: H7.at })}`,
				},
			],
			[promptUsec + 1e6, promptMono + 1e6, false, {}],
			[promptUsec + 2e6, promptMono + 2e6, false, {}],
			...(shape.terminal
				? [
						[
							promptUsec + 3e6,
							promptMono + 3e6,
							true,
							{
								_PID: String(H7.legacyPid),
								MESSAGE: `[decisions-call] ${JSON.stringify({ phase: "prompt_settled", at: H7.at + 3000 })}`,
							},
						] as [number, number, boolean, Row],
					]
				: []),
			[
				Number(H7.stoppedUsec),
				promptMono + 66e6,
				true,
				{ USER_UNIT: "pi-web-ui.service", MESSAGE: "Stopped pi-web-ui.service - pi web ui." },
			],
			[
				Number(H7.replacementStartedUsec),
				promptMono + 66.1e6,
				true,
				{ USER_UNIT: "pi-web-ui.service", MESSAGE: "Started pi-web-ui.service - pi web ui." },
			],
			[Number(H7.stoppedUsec) + 5e6, promptMono + 71e6, false, {}],
			[Number(H7.stoppedUsec) + 9e6, promptMono + 75e6, true, { _PID: String(servicePid), MESSAGE: "listening" }],
		];
		const at = plan.findIndex(([usec]) => usec === promptUsec);
		const entries = plan.map(([usec, mono, user, fields], index) => {
			const seq = promptSeq - at + index;
			const row: Row = {
				__CURSOR:
					index === at
						? H7.legacyCursor
						: `s=${S};i=${seq.toString(16)};b=${B};m=${mono.toString(16)};t=${usec.toString(16)};x=${seq.toString(16).padStart(16, "0")}`,
				__REALTIME_TIMESTAMP: String(usec),
				__MONOTONIC_TIMESTAMP: String(mono),
				_BOOT_ID: B,
				...fields,
			};
			if (fields._PID === String(H7.legacyPid)) row._SYSTEMD_INVOCATION_ID = H7.legacyInvocation;
			if (fields._PID === String(servicePid)) row._SYSTEMD_INVOCATION_ID = serviceInvocation;
			return { row, user };
		});
		const jsonl = (rows: Row[]) => Buffer.from(rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
		// A second counter (e.g. journald restarted with a new sequence id) holds one entry: no gap inside it.
		const other = {
			__CURSOR: `s=${"0".repeat(32)};i=1;b=${B};m=1;t=${(promptUsec + 4e6).toString(16)};x=1`,
			_BOOT_ID: B,
		};
		const cursors = (user: boolean) =>
			jsonl([
				...entries
					.filter((e) => !user || e.user)
					.map(({ row }) => ({
						__CURSOR: row.__CURSOR,
						__REALTIME_TIMESTAMP: row.__REALTIME_TIMESTAMP,
						_BOOT_ID: row._BOOT_ID,
					})),
				...(shape.secondStream ? [{ ...other, __REALTIME_TIMESTAMP: String(promptUsec + 4e6) }] : []),
			]);
		const moduleBytes = "compiled collector bytes";
		const env: CollectorEnv = {
			run(command, args, cwd) {
				calls.push([command, ...args]);
				if (command === "systemctl")
					return Buffer.from(`MainPID=${shape.systemdPid ?? servicePid}\nInvocationID=${serviceInvocation}\n`);
				if (
					command === "git" &&
					cwd === "/home/shinelay/projects/pi-web-ui" &&
					args[1] === `${H7.legacyHead}:server/decision-batches.ts`
				)
					return Buffer.from(legacySource);
				if (command === "journalctl") {
					// The live verify takes 27 s against the 10 s limit: an old-style call fails here as it does there.
					if (args.includes("--verify")) throw new Error("legacy evidence query unavailable: journalctl");
					if (args.includes("-u")) return jsonl(entries.filter((e) => e.user).map((e) => e.row));
					if (args.includes("-t")) return jsonl((shape.journaldMessages ?? []).map((MESSAGE) => ({ MESSAGE })));
					if (args.some((a) => a.startsWith("--output-fields=__CURSOR")))
						return cursors(args.includes("--user") || shape.fullViewReadable === false);
				}
				throw new Error(`unexpected command ${command}`);
			},
			processes: () => [
				{ pid: servicePid, args: ["/home/shinelay/.nvm/versions/node/v22.22.0/bin/node", bin, "--no-browser"] },
				{ pid: 4100, args: ["grep", "pi-web-ui"] },
				{ pid: 4101, args: ["bash", "/home/shinelay/.local/bin/pi-web-deploy", "status"] },
				...(shape.extraProcesses ?? []),
			],
			pidAlive: (pid) => (pid === H7.legacyPid ? (shape.legacyPidAlive ?? false) : true),
			self: { invocation: serviceInvocation, pid: servicePid, start: "123456789", boot: bootId },
			module: "module" in shape ? shape.module : { path: modulePath, hash: sha256(moduleBytes) },
			read(file) {
				if (file === modulePath) return Buffer.from(shape.moduleBytes ?? moduleBytes);
				if (file.endsWith("/H7-RECOVERY-EVIDENCE.json"))
					return Buffer.from(
						JSON.stringify({
							sourceSha256: { "/home/shinelay/projects/pi-web-ui/server/decision-batches.ts": sha256(legacySource) },
						}),
					);
				throw new Error("unexpected read");
			},
		};
		return { env, calls };
	}
	const denied = (proof: LegacyProof) => () => verifyLegacyProof(proof, Date.now());

	it("passes on the clean live-shaped journal, without --verify and from the full view", () => {
		const { env, calls } = machine();
		const proof = collectLegacyProof(true, env);
		expect(denied(proof)).not.toThrow();
		expect(proof.gapped).toBe(false);
		expect(proof.sequenceGaps).toBe(0);
		expect(proof.suppressed).toBe(false);
		expect(proof.duplicates).toEqual([]);
		expect(proof.starts.map((s) => s.cursor)).toEqual([H7.legacyCursor]);
		expect(proof.current.pid).toBe(servicePid);
		expect(calls.some((c) => c.includes("--verify"))).toBe(false);
		const coverage = calls.filter((c) => c.some((a) => a.startsWith("--output-fields=__CURSOR")));
		expect(coverage).toHaveLength(1);
		expect(coverage[0]).not.toContain("--user");
	});
	it("the --user view alone is always gapped (one shared counter) and denies", () => {
		const proof = collectLegacyProof(true, machine({ fullViewReadable: false }).env);
		expect(proof.gapped).toBe(true);
		expect(proof.sequenceGaps).toBeGreaterThan(0);
		expect(denied(proof)).toThrow(/legacy local-death proof/);
	});
	it("a second sequence stream denies even with no gap inside each stream", () => {
		const proof = collectLegacyProof(true, machine({ secondStream: true }).env);
		expect(proof.sequenceGaps).toBe(0);
		expect(proof.gapped).toBe(true);
		expect(denied(proof)).toThrow(/legacy local-death proof/);
	});
	it("journald suppression or corruption notices deny", () => {
		for (const message of [
			"Suppressed 12 messages from pi-web-ui.service",
			"Journal file /var/log/journal/x/user-1000.journal corrupted or uncleanly shut down, renaming and replacing.",
		]) {
			const proof = collectLegacyProof(true, machine({ journaldMessages: [message] }).env);
			expect(proof.suppressed).toBe(true);
			expect(denied(proof)).toThrow(/legacy local-death proof/);
		}
		const clean = collectLegacyProof(
			true,
			machine({ journaldMessages: ["Time spent on flushing to /var is 2ms"] }).env,
		);
		expect(denied(clean)).not.toThrow();
	});
	it("a second server launched the normal way (bin/pi-web-ui) is a duplicate writer", () => {
		const proof = collectLegacyProof(
			true,
			machine({
				extraProcesses: [
					{ pid: 4242, args: ["/home/shinelay/.nvm/versions/node/v22.22.0/bin/node", bin, "--no-browser"] },
				],
			}).env,
		);
		expect(proof.duplicates).toEqual([4242]);
		expect(denied(proof)).toThrow(/legacy local-death proof/);
	});
	it("a legacy terminal event, a live legacy pid or an unquiescent reader deny", () => {
		for (const [shape, quiescent] of [
			[{ terminal: true }, true],
			[{ legacyPidAlive: true }, true],
			[{}, false],
		] as [Shape, boolean][])
			expect(denied(collectLegacyProof(quiescent, machine(shape).env))).toThrow(/legacy local-death proof/);
	});
	it("loaded-code identity comes from the collector's own file and fails closed", () => {
		expect(() => collectLegacyProof(true, machine({ module: undefined }).env)).toThrow(
			/installed source identity unavailable/,
		);
		expect(() => collectLegacyProof(true, machine({ moduleBytes: "swapped after startup" }).env)).toThrow(
			/installed source changed after startup/,
		);
		const live = liveCollectorEnv();
		expect(live.module?.path).toMatch(/\/server\/decision-recovery\.ts$/);
		expect(live.module?.hash).toBe(sha256(readFileSync(live.module!.path)));
		expect(live.self.pid).toBe(process.pid);
	});
	it("the service identity must be systemd's main process", () => {
		expect(() => collectLegacyProof(true, machine({ systemdPid: 1 }).env)).toThrow(/current service identity mismatch/);
	});
	it("read-only queries fail closed on stderr, a non-zero exit or a missing command", () => {
		expect(runReadOnly("sh", ["-c", "printf ok"]).toString("utf8")).toBe("ok");
		expect(() => runReadOnly("sh", ["-c", "printf ok; printf warn >&2"])).toThrow(
			/legacy evidence query unavailable: sh/,
		);
		expect(() => runReadOnly("sh", ["-c", "exit 3"])).toThrow(/legacy evidence query unavailable: sh/);
		expect(() => runReadOnly("/nonexistent/h7-fix-command", [])).toThrow(/legacy evidence query unavailable/);
	});
});
